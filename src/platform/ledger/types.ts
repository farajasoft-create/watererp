import { Types } from 'mongoose';
import { dec } from '../common/money';

export interface JournalLine {
  accountId: string;
  description: string;
  debit?: string;
  credit?: string;
}

export interface Journal {
  /** YYYY-MM-DD */
  date: string;
  description: string;
  reference: string;
  lines: JournalLine[];
}

export interface LedgerAccount {
  id: string;
  code: string;
  name: string;
  type: string;
}

export interface LedgerConfig {
  baseUrl: string;
  apiKey: string;
  entityId: string;
  branchId: string;
  mode: 'DRAFT' | 'SUBMIT' | 'POST';
}

/**
 * Where journals go. The platform ships one that posts to FarajaSoft Accounting over its API; a finance
 * module can provide one that writes to its own ledger in the same database (and the same transaction).
 */
export interface LedgerProvider {
  name: string;
  isConnected(organisationId: Types.ObjectId): Promise<boolean>;
  /** Posts the journal once per idempotency key and returns its id. */
  post(organisationId: Types.ObjectId, journal: Journal, idempotencyKey: string): Promise<string>;
  /** Postable accounts, for the screens where modules map their accounts. */
  accounts(organisationId: Types.ObjectId): Promise<LedgerAccount[]>;
}

export function isBalanced(lines: JournalLine[]): boolean {
  const debit = lines.reduce((s, l) => s.plus(dec(l.debit)), dec(0));
  const credit = lines.reduce((s, l) => s.plus(dec(l.credit)), dec(0));
  return debit.eq(credit) && debit.gt(0);
}
