import { dec } from '@/platform/common/money';
import type { CoreServices } from '@/platform/container';
import { AccountingSyncService } from './accounting/sync.service';
import { BillingService } from './billing/billing.service';
import { AdjustmentsService } from './customers/adjustments.service';
import { CustomersService } from './customers/customers.service';
import { CustomerImportService } from './customers/import.service';
import { TelemetryService } from './ops/telemetry.service';
import { StatementService } from './customers/statement.service';
import { WaterDb, waterSettings } from './db';
import { DisconnectionsService } from './disconnections/disconnections.service';
import { MetersService } from './meters/meters.service';
import { PaymentsService } from './payments/payments.service';
import { ReadingsService } from './readings/readings.service';
import { ReportsService } from './reports/reports.service';
import { MasterDataService } from './setup/master-data.service';
import { WaterSettingsService } from './setup/settings.service';
import { DebtService } from './debt/debt.service';
import { IntakeService } from './service/intake.service';
import { NoticesService } from './service/notices.service';
import { PortalService } from './service/portal.service';
import { TicketsService } from './service/tickets.service';
import { KiosksService } from './ops/kiosks.service';
import { NetworkService } from './ops/network.service';
import { ProductionService } from './ops/production.service';
import { WorksService } from './ops/works.service';
import { WasrebService } from './reports/wasreb.service';

/**
 * The water module's services, built on the platform's audit, SMS, ledger and events. Other modules
 * hear about water through events (water.bill-run.approved, water.payment.posted, …), never by
 * calling these services directly.
 */
export function buildWaterServices(db: WaterDb, core: CoreServices) {
  const { audit, sms, events, email } = core;
  const statement = new StatementService(db);
  const accounting = new AccountingSyncService(db, core.ledger);
  const customers = new CustomersService(db, audit, statement);
  const billing = new BillingService(db, audit, statement);
  const payments = new PaymentsService(db, audit, statement);
  const adjustments = new AdjustmentsService(db, audit, statement);
  const tickets = new TicketsService(db, audit, sms, email);
  tickets.notifyAssignee = async (organisationId, userId, number, subject) => {
    await core.notifications.notify(organisationId, [userId], { title: `Ticket ${number} routed to you`, body: subject, link: '/water/service', module: 'water' });
  };
  const notices = new NoticesService(db, audit, sms);
  const debt = new DebtService(db, audit, sms, adjustments);
  const production = new ProductionService(db, audit);
  const works = new WorksService(db, audit, events);
  const reports = new ReportsService(db);

  // A complaint that needs the field team becomes a job card; finishing the job resolves the complaint.
  tickets.createWorkOrder = (user, ticketId) => works.fromTicket(user, ticketId);
  works.onCompleted = async (user, job) => {
    if (!job.ticketId) return;
    const t = await db.tickets.findById(job.ticketId, { status: 1 }).lean();
    if (t && ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED'].includes(t.status)) await tickets.resolve(user, job.ticketId, `${job.number} done: ${job.findings ?? ''}`.trim());
  };
  // A failed drinking-water test is an incident for the technical team.
  production.onQualityFailure = async (user, testId, failures) => {
    const test = await db.qualityTests.findById(testId).lean();
    await tickets.create(user, { category: 'WATER_QUALITY', channel: 'FIELD', priority: failures.some((f) => f.startsWith('E. coli') || f.startsWith('Total coliforms')) ? 'EMERGENCY' : 'URGENT', subject: `Failed water test at ${test?.location ?? test?.point?.toLowerCase().replace('_', ' ') ?? 'sample point'}`, description: failures.join('\n'), zoneId: test?.zoneId ?? null, location: test?.location ?? undefined });
  };

  billing.hooks = {
    async afterIssue(user, runId) {
      const [org, settings] = await Promise.all([db.organisations.findById(user.organisationId, { name: 1 }).lean(), waterSettings(db, user.organisationId)]);
      if (settings.billing?.sendBillSms) {
        const bills = await db.bills.find({ billRunId: runId, status: 'ISSUED', smsStatus: 'NOT_SENT' }, { customerId: 1, accountNo: 1, period: 1, units: 1, amountDue: 1, dueDate: 1 }).lean();
        const phones = new Map((await db.customers.find({ _id: { $in: bills.map((b) => b.customerId) } }, { phone: 1 }).lean()).map((c) => [c._id.toHexString(), c.phone]));
        for (const b of bills) {
          const paybill = settings.billing?.paybill ? ` Pay via M-Pesa Paybill ${settings.billing.paybill}, account ${b.accountNo}.` : '';
          const queued = await sms.queue(
            user.organisationId,
            phones.get(b.customerId.toHexString()),
            `${org?.name ?? 'Water'}: ${b.period} bill for ${b.accountNo}: ${dec(b.units).toFixed()} m3. Amount due KES ${dec(b.amountDue).toFixed(2)} by ${b.dueDate?.toISOString().slice(0, 10)}.${paybill}`,
            'water:bill',
            b._id,
          );
          await db.bills.updateOne({ _id: b._id }, { smsStatus: queued ? 'PENDING' : 'SKIPPED' });
        }
        await sms.deliverDue(user.organisationId, 500);
      }
      if (settings.billing?.emailBills) {
        const bills = await db.bills.find({ billRunId: runId, status: 'ISSUED' }, { customerId: 1, accountNo: 1, billNo: 1, period: 1, units: 1, currentCharges: 1, amountDue: 1, dueDate: 1 }).lean();
        const emails = new Map((await db.customers.find({ _id: { $in: bills.map((b) => b.customerId) }, email: { $nin: [null, ''] } }, { email: 1, name: 1 }).lean()).map((c) => [c._id.toHexString(), c]));
        for (const b of bills) {
          const c = emails.get(b.customerId.toHexString());
          if (!c) continue;
          const paybill = settings.billing?.paybill ? `\nPay via M-Pesa Paybill ${settings.billing.paybill}, account ${b.accountNo}.` : '';
          await email.queue(user.organisationId, c.email, `${org?.name ?? 'Water'} bill ${b.billNo} for ${b.period}`, `Dear ${c.name},\n\nYour water bill ${b.billNo} for ${b.period} (account ${b.accountNo}):\nConsumption: ${dec(b.units).toFixed()} m3\nThis bill: KES ${dec(b.currentCharges).toFixed(2)}\nAmount due: KES ${dec(b.amountDue).toFixed(2)} by ${b.dueDate?.toISOString().slice(0, 10)}${paybill}\n\n${settings.billing?.billFooter ?? ''}`.trim(), 'water:bill', b._id);
        }
        await email.deliverDue(user.organisationId, 500);
      }
      await accounting.trySync(user.organisationId, 'billRun', runId);
      await events.emit(user.organisationId, 'water.bill-run.approved', { billRunId: runId });
    },
  };

  payments.hooks = {
    async afterPosted(organisationId, paymentId) {
      await accounting.trySync(organisationId, 'payment', paymentId);
      await debt.onPayment(organisationId, paymentId).catch((err) => console.error('Payment plan update failed', err));
      const settings = await waterSettings(db, organisationId);
      if (settings.billing?.sendReceipts) {
        const p = await db.payments.findById(paymentId, { customerId: 1, amount: 1, receiptNo: 1, paidAt: 1, reference: 1 }).lean();
        const c = p?.customerId ? await db.customers.findById(p.customerId, { phone: 1, email: 1, name: 1, accountNo: 1, balance: 1 }).lean() : null;
        if (p && c) {
          const org = await db.organisations.findById(organisationId, { name: 1 }).lean();
          const bal = dec(c.balance);
          const text = `${org?.name ?? 'Water'}: Received KES ${dec(p.amount).toFixed(2)} for ${c.accountNo}, receipt ${p.receiptNo} (${p.reference}). ${bal.gt(0) ? `Balance KES ${bal.toFixed(2)}.` : 'Your account is paid up.'}`;
          await sms.queue(organisationId, c.phone, text, 'water:receipt', p._id);
          await email.queue(organisationId, c.email, `Receipt ${p.receiptNo}`, `Dear ${c.name},\n\n${text}`, 'water:receipt', p._id);
          await sms.deliverDue(organisationId);
          await email.deliverDue(organisationId);
        }
      }
      await events.emit(organisationId, 'water.payment.posted', { paymentId });
    },
    async afterReversed(organisationId, paymentId) {
      const p = await db.payments.findById(paymentId, { accounting: 1 }).lean();
      // A payment never sent to the ledger just stays out of it; one already there is reversed.
      if (p?.accounting?.status === 'SENT') await accounting.trySync(organisationId, 'reversal', paymentId);
      else await db.payments.updateOne({ _id: paymentId }, { 'accounting.status': 'SKIPPED', 'accounting.error': 'Reversed before it reached the ledger' });
      await events.emit(organisationId, 'water.payment.reversed', { paymentId });
    },
  };
  adjustments.afterApproved = async (organisationId, id) => {
    await accounting.trySync(organisationId, 'adjustment', id);
    await events.emit(organisationId, 'water.adjustment.approved', { adjustmentId: id });
  };

  const disconnections = new DisconnectionsService(db, audit, customers, statement, sms);
  disconnections.afterReconnected = async (organisationId, id) => {
    await accounting.trySync(organisationId, 'fee', id);
  };

  const readings = new ReadingsService(db, audit);
  return {
    db,
    statement,
    accounting,
    customers,
    customerImport: new CustomerImportService(db, audit, customers),
    billing,
    payments,
    adjustments,
    masterData: new MasterDataService(db, audit),
    meters: new MetersService(db, audit),
    readings,
    telemetry: new TelemetryService(db, audit, core.notifications, readings),
    disconnections,
    tickets,
    notices,
    debt,
    intake: new IntakeService(db, audit, sms, tickets, notices),
    portal: new PortalService(db, sms, tickets, notices),
    reports,
    production,
    works,
    network: new NetworkService(db, audit),
    kiosks: new KiosksService(db, audit, billing),
    wasreb: new WasrebService(db, reports, production),
    settings: new WaterSettingsService(db, audit),
  };
}

export type WaterServices = ReturnType<typeof buildWaterServices>;
