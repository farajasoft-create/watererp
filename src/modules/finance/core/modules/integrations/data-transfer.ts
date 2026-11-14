import { Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException } from '../../common/errors';
import { Db } from '../../database/db.service';

/** Codes ↔ ids for the references that appear in import and export files. */
export interface Refs {
  accountId: (code: string) => Types.ObjectId;
  accountCode: (id: unknown) => string;
  taxId: (code: string) => Types.ObjectId;
  taxCode: (id: unknown) => string;
  entityId: (code: string) => Types.ObjectId;
  entityCode: (id: unknown) => string;
}

export async function loadRefs(db: Db, user: AuthUser): Promise<Refs> {
  const org = user.organisationId;
  const [accounts, taxCodes, entities] = await Promise.all([
    db.accounts.find({ organisationId: org }, { code: 1 }).lean(),
    db.taxCodes.find({ organisationId: org }, { code: 1 }).lean(),
    db.entities.find({ organisationId: org }, { code: 1 }).lean(),
  ]);
  const lookup = (rows: { _id: Types.ObjectId; code: string }[], label: string) => {
    const byCode = new Map(rows.map((r) => [r.code.toUpperCase(), r._id]));
    const byId = new Map(rows.map((r) => [r._id.toHexString(), r.code]));
    return {
      id: (code: string) => {
        const id = byCode.get(code.toUpperCase());
        if (!id) throw new BadRequestException(`Unknown ${label} ${code}`);
        return id;
      },
      code: (id: unknown) => (id ? (byId.get(String(id)) ?? '') : ''),
    };
  };
  const a = lookup(accounts, 'account');
  const t = lookup(taxCodes, 'tax code');
  const e = lookup(entities, 'entity');
  return { accountId: a.id, accountCode: a.code, taxId: t.id, taxCode: t.code, entityId: e.id, entityCode: e.code };
}

type Row = Record<string, string>;
type Doc = Record<string, unknown>;

const bool = (v: string, column: string) => {
  const s = v.toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  throw new BadRequestException(`${column}: expected true or false`);
};
const int = (v: string, column: string) => {
  if (!/^\d+$/.test(v)) throw new BadRequestException(`${column}: expected a whole number`);
  return Number(v);
};
const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export interface TransferKind {
  /** API path the rows are created through (and updated through, at path/:id). */
  path: string;
  label: string;
  permissionHint: string;
  columns: string[];
  required: string[];
  find: (db: Db, user: AuthUser) => Promise<Doc[]>;
  /** Builds the API request body from a CSV row; only non-empty cells are sent. */
  toBody: (row: Row, refs: Refs) => Doc;
  toRow: (doc: Doc, refs: Refs) => unknown[];
}

const PARTY_COLUMNS = ['code', 'name', 'legalName', 'email', 'phone', 'address', 'city', 'country', 'taxId', 'currency', 'paymentTermsDays', 'defaultAccount', 'defaultTaxCode', 'creditLimit', 'onHold', 'withholdingTaxCode', 'bankName', 'bankAccountName', 'bankAccountNumber', 'bankBranch', 'notes', 'isActive'];

function partyKind(type: 'CUSTOMER' | 'SUPPLIER'): TransferKind {
  const customer = type === 'CUSTOMER';
  const columns = PARTY_COLUMNS.filter((c) => (customer ? c !== 'withholdingTaxCode' : c !== 'creditLimit' && c !== 'onHold'));
  return {
    path: customer ? '/customers' : '/suppliers',
    label: customer ? 'Customers' : 'Suppliers',
    permissionHint: customer ? 'ar.manage' : 'ap.manage',
    columns,
    required: ['code', 'name', 'currency'],
    find: (db, user) => (customer ? db.customers : db.suppliers).find({ organisationId: user.organisationId }).sort({ code: 1 }).lean() as Promise<Doc[]>,
    toBody: (row, refs) => {
      const body: Doc = {};
      for (const c of columns) {
        const v = row[c];
        if (v === undefined || v === '') continue;
        if (c === 'paymentTermsDays') body[c] = int(v, c);
        else if (c === 'onHold' || c === 'isActive') body[c] = bool(v, c);
        else if (c === 'defaultAccount') body.defaultAccountId = refs.accountId(v).toHexString();
        else if (c === 'defaultTaxCode') body.defaultTaxCodeId = refs.taxId(v).toHexString();
        else if (c === 'withholdingTaxCode') body.withholdingTaxCodeId = refs.taxId(v).toHexString();
        else body[c] = v;
      }
      return body;
    },
    toRow: (d, refs) =>
      columns.map((c) =>
        c === 'defaultAccount' ? refs.accountCode(d.defaultAccountId) : c === 'defaultTaxCode' ? refs.taxCode(d.defaultTaxCodeId) : c === 'withholdingTaxCode' ? refs.taxCode(d.withholdingTaxCodeId) : text(d[c]),
      ),
  };
}

const ITEM_COLUMNS = ['code', 'name', 'description', 'type', 'category', 'unit', 'inventoryAccount', 'cogsAccount', 'salesAccount', 'purchaseAccount', 'salesTaxCode', 'purchaseTaxCode', 'salesPrice', 'reorderLevel', 'isActive'];
const ITEM_ACCOUNT_COLUMNS: Record<string, string> = { inventoryAccount: 'inventoryAccountId', cogsAccount: 'cogsAccountId', salesAccount: 'salesAccountId', purchaseAccount: 'purchaseAccountId' };
const ITEM_TAX_COLUMNS: Record<string, string> = { salesTaxCode: 'salesTaxCodeId', purchaseTaxCode: 'purchaseTaxCodeId' };

const items: TransferKind = {
  path: '/items',
  label: 'Items',
  permissionHint: 'inventory.manage',
  columns: ITEM_COLUMNS,
  required: ['code', 'name', 'type'],
  find: (db, user) => db.items.find({ organisationId: user.organisationId }).sort({ code: 1 }).lean() as Promise<Doc[]>,
  toBody: (row, refs) => {
    const body: Doc = {};
    for (const c of ITEM_COLUMNS) {
      const v = row[c];
      if (v === undefined || v === '') continue;
      if (ITEM_ACCOUNT_COLUMNS[c]) body[ITEM_ACCOUNT_COLUMNS[c]] = refs.accountId(v).toHexString();
      else if (ITEM_TAX_COLUMNS[c]) body[ITEM_TAX_COLUMNS[c]] = refs.taxId(v).toHexString();
      else if (c === 'isActive') body[c] = bool(v, c);
      else if (c === 'type') body[c] = v.toUpperCase().replace(/[\s-]/g, '_');
      else body[c] = v;
    }
    return body;
  },
  toRow: (d, refs) => ITEM_COLUMNS.map((c) => (ITEM_ACCOUNT_COLUMNS[c] ? refs.accountCode(d[ITEM_ACCOUNT_COLUMNS[c]]) : ITEM_TAX_COLUMNS[c] ? refs.taxCode(d[ITEM_TAX_COLUMNS[c]]) : text(d[c]))),
};

const ACCOUNT_COLUMNS = ['code', 'name', 'accountClass', 'accountType', 'parent', 'currency', 'description', 'isPostable', 'requiresDepartment', 'requiresCostCentre', 'requiresProject', 'isActive'];
const accounts: TransferKind = {
  path: '/accounts',
  label: 'Chart of accounts',
  permissionHint: 'coa.manage',
  columns: ACCOUNT_COLUMNS,
  required: ['code', 'name', 'accountClass', 'accountType'],
  find: (db, user) => db.accounts.find({ organisationId: user.organisationId }).sort({ code: 1 }).lean() as Promise<Doc[]>,
  toBody: (row, refs) => {
    const body: Doc = {};
    for (const c of ACCOUNT_COLUMNS) {
      const v = row[c];
      if (v === undefined || v === '') continue;
      if (c === 'parent') body.parentId = refs.accountId(v).toHexString();
      else if (c.startsWith('is') || c.startsWith('requires')) body[c] = bool(v, c);
      else if (c === 'accountClass' || c === 'accountType') body[c] = v.toUpperCase();
      else body[c] = v;
    }
    return body;
  },
  toRow: (d, refs) => ACCOUNT_COLUMNS.map((c) => (c === 'parent' ? refs.accountCode(d.parentId) : text(d[c]))),
};

export const TRANSFER_KINDS: Record<string, TransferKind> = {
  customers: partyKind('CUSTOMER'),
  suppliers: partyKind('SUPPLIER'),
  items,
  accounts,
};

export const LEDGER_EXPORT_COLUMNS = [
  'date',
  'journalNumber',
  'lineNo',
  'entity',
  'branch',
  'accountCode',
  'accountName',
  'accountClass',
  'department',
  'costCentre',
  'project',
  'fund',
  'partyType',
  'party',
  'description',
  'currency',
  'exchangeRate',
  'debitTx',
  'creditTx',
  'debit',
  'credit',
  'source',
];

/** Flat ledger detail for BI tools and auditors, one row per posted ledger line. */
export async function ledgerExport(db: Db, user: AuthUser, q: { entityId: Types.ObjectId; from: Date; to: Date; branchIds: Types.ObjectId[] | null }, max = 100_000) {
  const org = user.organisationId;
  const filter: Record<string, unknown> = { organisationId: org, entityId: q.entityId, date: { $gte: q.from, $lte: q.to } };
  if (q.branchIds) filter.branchId = { $in: q.branchIds };
  const count = await db.ledger.countDocuments(filter);
  if (count > max) throw new BadRequestException(`${count} ledger lines match; narrow the date range to at most ${max}`);
  const [rows, accounts, branches, dims, entity, customers, suppliers] = await Promise.all([
    db.ledger.find(filter).sort({ date: 1, journalNumber: 1, lineNo: 1 }).lean(),
    db.accounts.find({ organisationId: org }, { code: 1, name: 1 }).lean(),
    db.branches.find({ organisationId: org }, { code: 1 }).lean(),
    db.dimensions.find({ organisationId: org }, { code: 1 }).lean(),
    db.entities.findById(q.entityId, { code: 1 }).lean(),
    db.customers.find({ organisationId: org }, { code: 1 }).lean(),
    db.suppliers.find({ organisationId: org }, { code: 1 }).lean(),
  ]);
  const map = <T extends { _id: Types.ObjectId }>(xs: T[]) => new Map(xs.map((x) => [x._id.toHexString(), x]));
  const [A, B, D, C, S] = [map(accounts), map(branches), map(dims), map(customers), map(suppliers)];
  const code = (m: Map<string, { code: string }>, id: unknown) => (id ? (m.get(String(id))?.code ?? '') : '');
  return rows.map((r) => [
    r.date.toISOString().slice(0, 10),
    r.journalNumber,
    r.lineNo,
    entity?.code ?? '',
    code(B, r.branchId),
    code(A, r.accountId),
    A.get(r.accountId.toHexString())?.name ?? '',
    r.accountClass,
    code(D, r.departmentId),
    code(D, r.costCentreId),
    code(D, r.projectId),
    code(D, r.fundId),
    r.partyType ?? '',
    r.partyType === 'CUSTOMER' ? code(C, r.partyId) : r.partyType === 'SUPPLIER' ? code(S, r.partyId) : '',
    r.description,
    r.currency,
    r.exchangeRate.toString(),
    r.debitTx.toString(),
    r.creditTx.toString(),
    r.debit.toString(),
    r.credit.toString(),
    r.source,
  ]);
}
