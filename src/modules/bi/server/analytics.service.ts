import { Types } from 'mongoose';
import { AuthUser, hasPermission } from '@/platform/auth';
import { ForbiddenException } from '@/platform/common/errors';
import { BiDb as Db } from './db';
import { auc, kmeans, LogisticModel, predict, seededOrder, trainLogistic } from './learn';

type Id = Types.ObjectId;
const DAY = 86_400_000;

/** A process measured from when it starts to when it is done, against its deadline where it has one. */
interface ProcessDef {
  key: string;
  label: string;
  module: string;
  collection: string;
  start: string;
  end: string;
  due?: string;
  /** Still open: not finished and not cancelled. */
  open: Record<string, unknown>;
  /** Finished (and counted for times). */
  done: Record<string, unknown>;
  /** Target hours when there is no per-record deadline. */
  targetHours?: number;
}

export const PROCESSES: ProcessDef[] = [
  { key: 'connections', label: 'New water connections (application to connection)', module: 'water', collection: 'water_customers', start: 'applicationDate', end: 'connectionDate', open: { status: { $in: ['APPLIED', 'APPROVED'] } }, done: { connectionDate: { $ne: null } }, targetHours: 14 * 24 },
  { key: 'complaints', label: 'Customer complaints (raised to resolved)', module: 'water', collection: 'water_tickets', start: 'createdAt', end: 'resolvedAt', due: 'slaDueAt', open: { status: { $in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED'] } }, done: { resolvedAt: { $ne: null } } },
  { key: 'workorders', label: 'Field jobs (raised to completed)', module: 'water', collection: 'water_work_orders', start: 'createdAt', end: 'completedAt', due: 'dueAt', open: { status: { $in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'] } }, done: { completedAt: { $ne: null } } },
  { key: 'helpdesk', label: 'IT help desk (raised to resolved)', module: 'ict', collection: 'ict_tickets', start: 'createdAt', end: 'resolvedAt', due: 'resolveBy', open: { status: { $in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED'] } }, done: { resolvedAt: { $ne: null } } },
  { key: 'leave', label: 'Leave requests (requested to decided)', module: 'hr', collection: 'hr_leave_requests', start: 'createdAt', end: 'reviewedAt', open: { status: 'PENDING' }, done: { reviewedAt: { $ne: null } }, targetHours: 48 },
  { key: 'approvals', label: 'Document approvals (submitted to decided)', module: 'core', collection: 'approval_requests', start: 'createdAt', end: 'updatedAt', open: { status: 'PENDING' }, done: { status: { $ne: 'PENDING' } }, targetHours: 72 },
  { key: 'tasks', label: 'Tasks (created to done)', module: 'core', collection: 'tasks', start: 'createdAt', end: 'completedAt', due: 'dueAt', open: { status: { $in: ['OPEN', 'IN_PROGRESS'] } }, done: { completedAt: { $ne: null } } },
  { key: 'auditActions', label: 'Audit recommendations (agreed to verified)', module: 'internalaudit', collection: 'internalaudit_findings', start: 'createdAt', end: 'verifiedAt', due: 'dueDate', open: { status: { $in: ['AGREED', 'IN_PROGRESS', 'IMPLEMENTED'] } }, done: { verifiedAt: { $ne: null } } },
];

const pctile = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10;
};
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

/** Probability (0–1) from a weighted score: a logistic curve centred on 0. */
const logistic = (z: number) => 1 / (1 + Math.exp(-z));

/**
 * Organisation-wide analytics: end-to-end turnaround of every process across the modules (with
 * bottlenecks named), and a customer risk model for arrears (likelihood of default, likelihood of
 * leaving) with the portfolio at risk.
 */
export class AnalyticsService {
  constructor(private readonly db: Db) {}

  async turnaround(user: AuthUser, from: Date, to: Date) {
    const end = new Date(to.getTime() + DAY);
    const now = new Date();
    const out = [];
    for (const p of PROCESSES.filter((x) => x.module === 'core' || user.modules.includes(x.module))) {
      const col = this.db.connection.collection(p.collection);
      const [finished, open] = await Promise.all([
        col
          .find({ organisationId: user.organisationId, ...p.done, [p.end]: { $gte: from, $lt: end } }, { projection: { [p.start]: 1, [p.end]: 1, ...(p.due && { [p.due]: 1 }) } })
          .limit(50_000)
          .toArray(),
        col.find({ organisationId: user.organisationId, ...p.open }, { projection: { [p.start]: 1, ...(p.due && { [p.due]: 1 }) } }).limit(50_000).toArray(),
      ]);
      const hours = finished.filter((r) => r[p.start] && r[p.end]).map((r) => ((r[p.end] as Date).getTime() - (r[p.start] as Date).getTime()) / 3_600_000);
      const onTime = finished.filter((r) => {
        if (!r[p.start] || !r[p.end]) return false;
        const due = p.due ? (r[p.due] as Date | null) : p.targetHours ? new Date((r[p.start] as Date).getTime() + p.targetHours * 3_600_000) : null;
        return due ? (r[p.end] as Date) <= due : true;
      }).length;
      const overdue = open.filter((r) => {
        const due = p.due ? (r[p.due] as Date | null) : p.targetHours && r[p.start] ? new Date((r[p.start] as Date).getTime() + p.targetHours * 3_600_000) : null;
        return due && due < now;
      }).length;
      const ages = open.filter((r) => r[p.start]).map((r) => (now.getTime() - (r[p.start] as Date).getTime()) / DAY);
      out.push({
        key: p.key,
        label: p.label,
        module: p.module,
        completed: finished.length,
        avgHours: hours.length ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : null,
        medianHours: pctile(hours, 0.5),
        p90Hours: pctile(hours, 0.9),
        onTimePct: pct(onTime, finished.length),
        open: open.length,
        overdue,
        oldestOpenDays: ages.length ? Math.floor(Math.max(...ages)) : null,
      });
    }
    // A bottleneck: work finishing late most of the time, or a backlog where most items are past due.
    const bottlenecks = out
      .map((r) => ({ key: r.key, label: r.label, reason: r.onTimePct !== null && r.onTimePct < 70 && r.completed >= 3 ? `Only ${r.onTimePct}% finished on time` : r.open >= 3 && r.overdue / r.open > 0.5 ? `${r.overdue} of ${r.open} open items are overdue` : null }))
      .filter((b) => b.reason);
    return { from, to, processes: out, bottlenecks };
  }

  /**
   * Water customer risk. Each active account with a balance gets a likelihood of default from its
   * arrears age and size against its bills, how recently and how fully it pays, broken payment plans
   * and past disconnections; and a likelihood of leaving from no payments, no consumption and being cut
   * off. The default likelihood comes from a logistic model trained on the organisation's own history
   * when there is enough of it (judged on held-back accounts), otherwise from transparent rule weights.
   */
  async customerRisk(user: AuthUser, limit = 50) {
    if (!user.modules.includes('water')) throw new ForbiddenException('The water module is not switched on');
    if (!user.isAdmin && !hasPermission(user, 'water.reports.view') && !hasPermission(user, 'bi.admin')) throw new ForbiddenException('You cannot see customer risk');
    const org = user.organisationId;
    const now = new Date();
    const since = new Date(now.getTime() - 180 * DAY);
    const c = (name: string) => this.db.connection.collection(name);
    const customers = await c('water_customers').find({ organisationId: org, status: { $in: ['ACTIVE', 'DISCONNECTED'] } }, { projection: { accountNo: 1, name: 1, category: 1, status: 1, balance: 1, oldestUnpaidDueDate: 1, zoneId: 1 } }).toArray();
    const ids = customers.map((x) => x._id as Id);
    const [payments, bills, plans, cuts] = await Promise.all([
      c('water_payments').aggregate<{ _id: Id; paid: number; n: number; last: Date }>([{ $match: { organisationId: org, customerId: { $in: ids }, status: { $ne: 'REVERSED' }, paidAt: { $gte: since } } }, { $group: { _id: '$customerId', paid: { $sum: { $toDouble: '$amount' } }, n: { $sum: 1 }, last: { $max: '$paidAt' } } }]).toArray(),
      c('water_bills').aggregate<{ _id: Id; billed: number; n: number; units: number }>([{ $match: { organisationId: org, customerId: { $in: ids }, billDate: { $gte: since } } }, { $group: { _id: '$customerId', billed: { $sum: { $toDouble: '$currentCharges' } }, n: { $sum: 1 }, units: { $sum: { $toDouble: '$units' } } } }]).toArray(),
      c('water_payment_plans').aggregate<{ _id: Id; n: number }>([{ $match: { organisationId: org, customerId: { $in: ids }, status: 'DEFAULTED' } }, { $group: { _id: '$customerId', n: { $sum: 1 } } }]).toArray(),
      c('water_disconnections').aggregate<{ _id: Id; n: number }>([{ $match: { organisationId: org, customerId: { $in: ids }, status: { $in: ['DISCONNECTED', 'RECONNECTED'] } } }, { $group: { _id: '$customerId', n: { $sum: 1 } } }]).toArray(),
    ]);
    const by = <T extends { _id: Id }>(rows: T[]) => new Map(rows.map((r) => [r._id.toHexString(), r]));
    const P = by(payments);
    const B = by(bills);
    const L = by(plans);
    const D = by(cuts);
    const scored = customers.map((cu) => {
      const k = (cu._id as Id).toHexString();
      const balance = Number(cu.balance?.toString() ?? 0);
      const pay = P.get(k);
      const bill = B.get(k);
      const monthly = bill && bill.n ? bill.billed / bill.n : 0;
      const arrearsDays = cu.oldestUnpaidDueDate ? Math.max(0, (now.getTime() - (cu.oldestUnpaidDueDate as Date).getTime()) / DAY) : 0;
      const sinceLastPay = pay ? (now.getTime() - pay.last.getTime()) / DAY : 365;
      const coverage = bill && bill.billed > 0 ? Math.min((pay?.paid ?? 0) / bill.billed, 1.5) : 1;
      const monthsOwed = monthly > 0 ? balance / monthly : balance > 0 ? 6 : 0;
      const factors = {
        arrearsAge: Math.min(arrearsDays / 90, 3) * 1.2,
        monthsOwed: Math.min(monthsOwed / 3, 3) * 0.9,
        noRecentPayment: Math.min(sinceLastPay / 60, 3) * 0.8,
        lowCoverage: (1 - Math.min(coverage, 1)) * 1.5,
        brokenPlans: Math.min(L.get(k)?.n ?? 0, 2) * 0.8,
        pastDisconnections: Math.min(D.get(k)?.n ?? 0, 3) * 0.5,
      };
      const z = Object.values(factors).reduce((a, b) => a + b, 0) - 3;
      const defaultRisk = balance > 0 ? Math.round(logistic(z) * 100) : 0;
      const noUse = bill ? bill.units <= 0 : true;
      const churnRisk = Math.round(logistic((cu.status === 'DISCONNECTED' ? 2 : 0) + (noUse ? 1.2 : 0) + (sinceLastPay > 90 ? 1.2 : 0) - 2.2) * 100);
      const band: 'HIGH' | 'MEDIUM' | 'LOW' = defaultRisk >= 70 ? 'HIGH' : defaultRisk >= 40 ? 'MEDIUM' : 'LOW';
      return { id: cu._id, accountNo: cu.accountNo, name: cu.name, category: cu.category, status: cu.status, balance, arrearsDays: Math.floor(arrearsDays), daysSinceLastPayment: pay ? Math.floor(sinceLastPay) : null, paidOfBilledPct: bill && bill.billed > 0 ? Math.round(Math.min(coverage, 9) * 100) : null, defaultRisk, churnRisk, band, expectedLoss: Math.round(balance * (defaultRisk / 100) * 100) / 100, factors };
    });
    // A model trained on this organisation's own history replaces the rule weights when there is enough of it.
    const model = await this.trainDefaultModel(org, now);
    if (model.method === 'TRAINED') {
      const current = await this.historyFeatures(org, ids, now);
      for (const s of scored) {
        if (s.balance <= 0) continue;
        s.defaultRisk = Math.round(predict(model.model!, current.get(String(s.id)) ?? [365, 0, 0, 0, 0, 0]) * 100);
        s.band = s.defaultRisk >= 70 ? 'HIGH' : s.defaultRisk >= 40 ? 'MEDIUM' : 'LOW';
        s.expectedLoss = Math.round(s.balance * (s.defaultRisk / 100) * 100) / 100;
      }
    }
    const bands = (['HIGH', 'MEDIUM', 'LOW'] as const).map((b) => {
      const rows = scored.filter((s) => s.band === b && s.balance > 0);
      return { band: b, accounts: rows.length, balance: Math.round(rows.reduce((a, r) => a + r.balance, 0) * 100) / 100, expectedLoss: Math.round(rows.reduce((a, r) => a + r.expectedLoss, 0) * 100) / 100 };
    });
    const totalBalance = scored.reduce((a, r) => a + Math.max(r.balance, 0), 0);
    return {
      scored: scored.length,
      portfolio: { balance: Math.round(totalBalance * 100) / 100, expectedLoss: Math.round(bands.reduce((a, b) => a + b.expectedLoss, 0) * 100) / 100, atRiskPct: pct(bands[0].balance, totalBalance), bands },
      churn: { likely: scored.filter((s) => s.churnRisk >= 60).length, ofActive: scored.filter((s) => s.status === 'ACTIVE').length },
      riskiest: [...scored].sort((a, b) => b.expectedLoss - a.expectedLoss || b.defaultRisk - a.defaultRisk).slice(0, limit),
      likelyToLeave: [...scored].filter((s) => s.churnRisk >= 60).sort((a, b) => b.churnRisk - a.churnRisk).slice(0, limit),
      model: { method: model.method, reason: model.reason, trainedOn: model.trainedOn, defaulters: model.positives, testAuc: model.auc, coefficients: model.coefficients },
      weights: { arrearsAge: '1.2 per 90 days overdue (max 3)', monthsOwed: '0.9 per 3 months of bills owed (max 3)', noRecentPayment: '0.8 per 60 days since paying (max 3)', lowCoverage: '1.5 × share of the last 6 months’ bills not paid', brokenPlans: '0.8 per defaulted payment plan', pastDisconnections: '0.5 per disconnection', centre: 'score − 3, through a logistic curve' },
    };
  }

  /**
   * Data mining: groups the water customers by behaviour (k-means on monthly consumption, monthly bill,
   * share of bills paid, days since last paying and balance owed over the last six months), names each
   * group from its centre, and lists its size and members so campaigns can be aimed at each.
   */
  async customerSegments(user: AuthUser, k = 4) {
    if (!user.modules.includes('water')) throw new ForbiddenException('The water module is not switched on');
    if (!user.isAdmin && !hasPermission(user, 'water.reports.view') && !hasPermission(user, 'bi.admin')) throw new ForbiddenException('You cannot see customer analytics');
    const org = user.organisationId;
    const now = new Date();
    const since = new Date(now.getTime() - 180 * DAY);
    const c = (name: string) => this.db.connection.collection(name);
    const customers = await c('water_customers').find({ organisationId: org, status: 'ACTIVE' }, { projection: { accountNo: 1, name: 1, category: 1, balance: 1 } }).limit(100_000).toArray();
    const ids = customers.map((x) => x._id as Id);
    const [bills, pays] = await Promise.all([
      c('water_bills').aggregate<{ _id: Id; units: number; billed: number; n: number }>([{ $match: { organisationId: org, customerId: { $in: ids }, billDate: { $gte: since } } }, { $group: { _id: '$customerId', units: { $sum: { $toDouble: '$units' } }, billed: { $sum: { $toDouble: '$currentCharges' } }, n: { $sum: 1 } } }]).toArray(),
      c('water_payments').aggregate<{ _id: Id; paid: number; last: Date }>([{ $match: { organisationId: org, customerId: { $in: ids }, status: { $ne: 'REVERSED' }, paidAt: { $gte: since } } }, { $group: { _id: '$customerId', paid: { $sum: { $toDouble: '$amount' } }, last: { $max: '$paidAt' } } }]).toArray(),
    ]);
    const B = new Map(bills.map((b) => [String(b._id), b]));
    const P = new Map(pays.map((p) => [String(p._id), p]));
    const rows = customers.map((cu) => {
      const b = B.get(String(cu._id));
      const p = P.get(String(cu._id));
      const months = b?.n || 1;
      return [b ? b.units / months : 0, b ? b.billed / months : 0, b && b.billed > 0 ? Math.min((p?.paid ?? 0) / b.billed, 1.5) : 1, p ? (now.getTime() - p.last.getTime()) / DAY : 180, Number(cu.balance?.toString() ?? 0)];
    });
    const groups = Math.max(2, Math.min(k, 8));
    if (rows.length < groups * 5) return { customers: rows.length, segments: [], note: `Too few active customers with history to group (${rows.length})` };
    const r = kmeans(rows, groups);
    const avgUse = rows.reduce((s, x) => s + x[0], 0) / rows.length;
    const name = (c: number[]) => [c[0] > avgUse * 1.5 ? 'High users' : c[0] < avgUse * 0.5 ? 'Low users' : 'Average users', c[2] >= 0.9 && c[3] < 45 ? 'who pay on time' : c[2] >= 0.6 ? 'who pay partly' : 'who seldom pay', c[4] > c[1] * 3 ? 'with large arrears' : ''].filter(Boolean).join(' ');
    const segments = r.centres
      .map((c, i) => {
        const members = customers.filter((_, j) => r.assign[j] === i);
        return {
          segment: i + 1,
          name: name(c),
          customers: r.sizes[i],
          share: Math.round((r.sizes[i] / rows.length) * 1000) / 10,
          centre: { monthlyUnits: Math.round(c[0] * 10) / 10, monthlyBill: Math.round(c[1]), paidShare: Math.round(c[2] * 100), daysSincePayment: Math.round(c[3]), balance: Math.round(c[4]) },
          balanceOwed: Math.round(members.reduce((s, m) => s + Math.max(Number(m.balance?.toString() ?? 0), 0), 0)),
          examples: members.slice(0, 5).map((m) => ({ accountNo: m.accountNo, name: m.name })),
        };
      })
      .sort((a, b) => b.customers - a.customers);
    return { customers: rows.length, features: ['monthly units', 'monthly bill', 'share of bills paid', 'days since paying', 'balance'], segments };
  }

  /** Payment behaviour of each customer over the six months before `asOf`, as model features. */
  private async historyFeatures(org: Id, ids: Id[], asOf: Date) {
    const from = new Date(asOf.getTime() - 180 * DAY);
    const c = (name: string) => this.db.connection.collection(name);
    const [pays, bills, plans, cuts] = await Promise.all([
      c('water_payments').aggregate<{ _id: Id; paid: number; last: Date }>([{ $match: { organisationId: org, customerId: { $in: ids }, status: { $ne: 'REVERSED' }, paidAt: { $gte: from, $lt: asOf } } }, { $group: { _id: '$customerId', paid: { $sum: { $toDouble: '$amount' } }, last: { $max: '$paidAt' } } }]).toArray(),
      c('water_bills').aggregate<{ _id: Id; billed: number; n: number }>([{ $match: { organisationId: org, customerId: { $in: ids }, billDate: { $gte: from, $lt: asOf } } }, { $group: { _id: '$customerId', billed: { $sum: { $toDouble: '$currentCharges' } }, n: { $sum: 1 } } }]).toArray(),
      c('water_payment_plans').aggregate<{ _id: Id; n: number }>([{ $match: { organisationId: org, customerId: { $in: ids }, status: 'DEFAULTED', createdAt: { $lt: asOf } } }, { $group: { _id: '$customerId', n: { $sum: 1 } } }]).toArray(),
      c('water_disconnections').aggregate<{ _id: Id; n: number }>([{ $match: { organisationId: org, customerId: { $in: ids }, disconnectedAt: { $lt: asOf } } }, { $group: { _id: '$customerId', n: { $sum: 1 } } }]).toArray(),
    ]);
    const m = <T extends { _id: Id }>(rows: T[]) => new Map(rows.map((r) => [String(r._id), r]));
    const [P, B, L, D] = [m(pays), m(bills), m(plans), m(cuts)];
    const out = new Map<string, number[]>();
    for (const id of ids) {
      const k = String(id);
      const pay = P.get(k);
      const bill = B.get(k);
      const billed = bill?.billed ?? 0;
      const paid = pay?.paid ?? 0;
      const monthly = bill?.n ? billed / bill.n : 0;
      out.set(k, [
        pay ? Math.min((asOf.getTime() - pay.last.getTime()) / DAY, 365) : 365,
        billed > 0 ? Math.min(paid / billed, 1.5) : 1,
        monthly > 0 ? Math.max(billed - paid, 0) / monthly : 0,
        bill?.n ?? 0,
        Math.min(L.get(k)?.n ?? 0, 3),
        Math.min(D.get(k)?.n ?? 0, 3),
      ]);
    }
    return out;
  }

  /**
   * Trains the default model on history: features as they stood six months ago, and whether the account
   * went on to default (listed for disconnection, or now more than 90 days in arrears). Judged on a third
   * of the accounts held back; used only if it beats chance clearly (AUC of at least 0.6).
   */
  private async trainDefaultModel(org: Id, now: Date): Promise<{ method: 'TRAINED' | 'RULES'; reason?: string; trainedOn: number; positives: number; auc: number | null; coefficients?: Record<string, number>; model?: LogisticModel }> {
    const asOf = new Date(now.getTime() - 180 * DAY);
    const c = (name: string) => this.db.connection.collection(name);
    const pop = await c('water_customers').find({ organisationId: org, createdAt: { $lt: asOf } }, { projection: { balance: 1, oldestUnpaidDueDate: 1 } }).limit(50_000).toArray();
    const ids = pop.map((p) => p._id as Id);
    const listed = new Set((await c('water_disconnections').distinct('customerId', { organisationId: org, customerId: { $in: ids }, listedAt: { $gte: asOf, $lt: now } })).map(String));
    const labels = pop.map((p) => (listed.has(String(p._id)) || (Number(p.balance?.toString() ?? 0) > 0 && p.oldestUnpaidDueDate && (now.getTime() - (p.oldestUnpaidDueDate as Date).getTime()) / DAY > 90) ? 1 : 0));
    const positives = labels.reduce<number>((a, b) => a + b, 0);
    if (pop.length < 40 || positives < 8 || pop.length - positives < 8) return { method: 'RULES', reason: `Not enough history to train on yet (${pop.length} accounts older than six months, ${positives} defaults; needs 40 and 8)`, trainedOn: pop.length, positives, auc: null };
    const f = await this.historyFeatures(org, ids, asOf);
    const rows = ids.map((id) => f.get(String(id))!);
    const order = seededOrder(rows.length);
    const cut = Math.floor(rows.length * 0.7);
    const train = order.slice(0, cut);
    const test = order.slice(cut);
    const trial = trainLogistic(train.map((i) => rows[i]), train.map((i) => labels[i]), RISK_FEATURES);
    const score = auc(test.map((i) => predict(trial, rows[i])), test.map((i) => labels[i]));
    if (score === null || score < 0.6) return { method: 'RULES', reason: `The trained model did not beat chance clearly on held-back accounts (AUC ${score?.toFixed(2) ?? 'n/a'})`, trainedOn: pop.length, positives, auc: score };
    const model = trainLogistic(rows, labels, RISK_FEATURES);
    return { method: 'TRAINED', trainedOn: pop.length, positives, auc: Math.round(score * 1000) / 1000, coefficients: Object.fromEntries(RISK_FEATURES.map((k, j) => [k, Math.round(model.weights[j + 1] * 1000) / 1000])), model };
  }
}

const RISK_FEATURES = ['daysSinceLastPayment', 'paidShareOfBills', 'monthsUnpaid', 'billsInSixMonths', 'defaultedPlans', 'pastDisconnections'];
