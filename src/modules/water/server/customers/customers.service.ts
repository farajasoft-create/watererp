import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, NotFoundException } from '@/platform/common/errors';
import { Decimal, toD128 } from '@/platform/common/money';
import { escapeRegex } from '@/platform/common/validation';
import { WaterDb as Db } from '@/modules/water/server/db';
import { CUSTOMER_CATEGORIES, CUSTOMER_STATUSES } from '@/modules/water/server/schemas';
import { AuditService } from '@/platform/services/audit.service';
import { StatementService } from './statement.service';

type Category = (typeof CUSTOMER_CATEGORIES)[number];
type Status = (typeof CUSTOMER_STATUSES)[number];

export interface CustomerInput {
  name: string;
  category: Category;
  idType?: 'NATIONAL_ID' | 'PASSPORT' | 'ALIEN_ID' | 'COMPANY_REG' | 'OTHER';
  idNumber?: string;
  kraPin?: string;
  phone?: string;
  altPhone?: string;
  email?: string;
  postalAddress?: string;
  zoneId: Types.ObjectId;
  location?: string;
  plotNo?: string;
  gps?: { lat: number; lng: number } | null;
  tariffId: Types.ObjectId;
  sewered?: boolean;
  notes?: string;
}

export interface CustomerQuery {
  search?: string;
  zoneId?: Types.ObjectId;
  status?: Status;
  category?: Category;
  inArrears?: boolean;
  page: number;
  pageSize: number;
}

/** Which status changes are allowed, and from where. */
const TRANSITIONS: Record<Status, Status[]> = {
  APPLIED: ['APPROVED', 'REJECTED'],
  APPROVED: ['ACTIVE', 'REJECTED'],
  ACTIVE: ['DISCONNECTED', 'CLOSED'],
  DISCONNECTED: ['ACTIVE', 'CLOSED'],
  CLOSED: [],
  REJECTED: [],
};

/** Account numbers carry the zone code so field staff can tell where a customer is: e.g. KAM-00042. */
export function accountNumber(zoneCode: string, sequence: number): string {
  return `${zoneCode}-${String(sequence).padStart(5, '0')}`;
}

export class CustomersService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly statement: StatementService,
  ) {}

  private async checkRefs(user: AuthUser, input: Pick<CustomerInput, 'zoneId' | 'tariffId' | 'category'>) {
    const [zone, tariff] = await Promise.all([
      this.db.zones.findOne({ _id: input.zoneId, organisationId: user.organisationId }).lean(),
      this.db.tariffs.findOne({ _id: input.tariffId, organisationId: user.organisationId }).lean(),
    ]);
    if (!zone) throw new BadRequestException('Unknown zone');
    if (!tariff) throw new BadRequestException('Unknown tariff');
    if (tariff.category !== input.category) throw new BadRequestException(`Tariff ${tariff.code} is for ${tariff.category.toLowerCase()} customers`);
    return { zone, tariff };
  }

  async list(user: AuthUser, q: CustomerQuery) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.zoneId) filter.zoneId = q.zoneId;
    if (q.status) filter.status = q.status;
    if (q.category) filter.category = q.category;
    if (q.inArrears) filter.balance = { $gt: toD128(0) };
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ accountNo: rx }, { name: rx }, { phone: rx }, { idNumber: rx }, { plotNo: rx }];
    }
    const [items, total] = await Promise.all([
      this.db.customers
        .find(filter, { statusHistory: 0 })
        .sort({ accountNo: 1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean(),
      this.db.customers.countDocuments(filter),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    const customer = await this.db.customers.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!customer) throw new NotFoundException('Customer not found');
    const [meter, zone, tariff, bills, payments, readings] = await Promise.all([
      customer.meterId ? this.db.meters.findById(customer.meterId, { history: 0 }).lean() : null,
      this.db.zones.findById(customer.zoneId).lean(),
      this.db.tariffs.findById(customer.tariffId).lean(),
      this.db.bills.find({ organisationId: user.organisationId, customerId: id, status: 'ISSUED' }).sort({ billDate: -1 }).limit(12).lean(),
      this.db.payments.find({ organisationId: user.organisationId, customerId: id }).sort({ paidAt: -1 }).limit(12).lean(),
      this.db.readings.find({ organisationId: user.organisationId, customerId: id }).sort({ readAt: -1 }).limit(12).lean(),
    ]);
    return { ...customer, meter, zone, tariff, bills, payments, readings };
  }

  async findByAccountNo(organisationId: Types.ObjectId, accountNo: string) {
    return this.db.customers.findOne({ organisationId, accountNo: accountNo.trim().toUpperCase() }).lean();
  }

  /** Registers a new connection application. */
  async create(user: AuthUser, input: CustomerInput & { openingBalance?: Decimal; status?: 'APPLIED' | 'ACTIVE' }) {
    const { zone } = await this.checkRefs(user, input);
    return this.db.transaction(async (session) => {
      const seq = await this.db.next(user.organisationId, `account:${zone.code}`, session);
      const status = input.status ?? 'APPLIED';
      const { openingBalance, ...data } = input;
      const [customer] = await this.db.customers.create(
        [
          {
            ...data,
            organisationId: user.organisationId,
            accountNo: accountNumber(zone.code, seq),
            status,
            ...(status === 'ACTIVE' && { connectionDate: new Date() }),
            statusHistory: [{ status, at: new Date(), by: user.id }],
          },
        ],
        { session },
      );
      if (openingBalance && !openingBalance.isZero()) {
        // Balances migrated from the legacy system.
        await this.statement.post(
          {
            organisationId: user.organisationId,
            customerId: customer._id,
            date: new Date(),
            type: 'OPENING',
            reference: 'OPENING',
            description: 'Balance brought forward from previous system',
            ...(openingBalance.isNegative() ? { credit: openingBalance.abs() } : { debit: openingBalance }),
          },
          session,
        );
      }
      await this.audit.record(user, 'customer.create', 'customer', customer._id, { accountNo: customer.accountNo }, session);
      return customer;
    });
  }

  async update(user: AuthUser, id: Types.ObjectId, input: CustomerInput) {
    const existing = await this.db.customers.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!existing) throw new NotFoundException('Customer not found');
    await this.checkRefs(user, input);
    // The account number keeps its original zone prefix; moving zone does not renumber the account.
    const customer = await this.db.customers.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, input, { new: true }).lean();
    await this.audit.record(user, 'customer.update', 'customer', id, input);
    return customer;
  }

  async changeStatus(user: AuthUser, id: Types.ObjectId, status: Status, reason?: string) {
    const customer = await this.db.customers.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!customer) throw new NotFoundException('Customer not found');
    const from = customer.status as Status;
    if (!TRANSITIONS[from].includes(status)) throw new BadRequestException(`A ${from.toLowerCase()} account cannot become ${status.toLowerCase()}`);
    if (status === 'ACTIVE' && !customer.meterId && customer.category !== 'KIOSK') throw new BadRequestException('Install a meter before activating the connection');
    if (status === 'CLOSED' && !new Decimal(customer.balance?.toString() ?? 0).isZero()) throw new BadRequestException('Clear the balance (or refund the credit) before closing the account');
    const update: Record<string, unknown> = { status, $push: { statusHistory: { status, at: new Date(), by: user.id, reason } } };
    if (status === 'ACTIVE' && !customer.connectionDate) update.connectionDate = new Date();
    const updated = await this.db.customers.findOneAndUpdate({ _id: id, organisationId: user.organisationId, status: from }, update, { new: true }).lean();
    await this.audit.record(user, 'customer.status', 'customer', id, { from, to: status, reason });
    return updated;
  }

  statementOf(user: AuthUser, id: Types.ObjectId, opts: { from?: Date; to?: Date }) {
    return this.statement.list(user.organisationId, id, opts);
  }
}
