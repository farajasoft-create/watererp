import { Decimal } from '../../common/money';

/**
 * KRA eTIMS through an Online Sales Control Unit (OSCU), per KRA's OSCU specification: device
 * initialisation, item registration and sales reporting. Amounts sent to KRA are tax-inclusive and in
 * KES; tax types are A (exempt), B (16%), C (zero-rated), D (non-VAT) and E (8%).
 */

export type EtimsEnvironment = 'sandbox' | 'production';
export type EtimsTaxType = 'A' | 'B' | 'C' | 'D' | 'E';

const BASE: Record<EtimsEnvironment, string> = {
  sandbox: 'https://etims-api-sbx.kra.go.ke/etims-api',
  production: 'https://etims-api.kra.go.ke/etims-api',
};
const RECEIPT_HOST: Record<EtimsEnvironment, string> = { sandbox: 'https://etims-sbx.kra.go.ke', production: 'https://etims.kra.go.ke' };

export const TAX_RATES: Record<EtimsTaxType, number> = { A: 0, B: 16, C: 0, D: 0, E: 8 };
const TYPES: EtimsTaxType[] = ['A', 'B', 'C', 'D', 'E'];

export class EtimsError extends Error {
  constructor(
    message: string,
    public readonly resultCd: string | null,
  ) {
    super(message);
  }
}

/** Where a customer can check the receipt with KRA (encoded in the QR code on the invoice). */
export function receiptUrl(environment: EtimsEnvironment, tin: string, bhfId: string, rcptSign: string) {
  return `${RECEIPT_HOST[environment]}/common/link/etims/receipt/indexEtimsReceiptData?Data=${encodeURIComponent(`${tin}${bhfId}${rcptSign}`)}`;
}

/** YYYYMMDDHHmmss in East Africa Time. */
export function etimsDateTime(d: Date) {
  return new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 19).replace(/[-T:]/g, '');
}
export const etimsDate = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');

/** KRA item codes: country, type, packaging unit, quantity unit and a 7-digit sequence (e.g. KE2NTU0000001). */
export function itemCode(type: '1' | '2' | '3', sequence: number, pkg = 'NT', qty = 'U') {
  return `KE${type}${pkg}${qty}${String(sequence).padStart(7, '0')}`;
}

export interface SaleLine {
  itemCd: string;
  itemClsCd: string;
  itemNm: string;
  quantity: Decimal;
  /** Unit price as entered on the document. */
  unitPrice: Decimal;
  priceIncludesTax: boolean;
  discountPercent: Decimal | null;
  /** Line net and tax as posted (after discount), in the document currency. */
  netAmount: Decimal;
  taxAmount: Decimal;
  taxTyCd: EtimsTaxType;
}

export interface SaleInput {
  tin: string;
  bhfId: string;
  invcNo: number;
  orgInvcNo: number;
  kind: 'SALE' | 'CREDIT';
  documentNumber: string;
  customerTin: string | null;
  customerName: string;
  date: Date;
  confirmedAt: Date;
  /** Converts document-currency amounts to KES (1 for KES documents). */
  exchangeRate: Decimal;
  paymentTypeCode: string;
  lines: SaleLine[];
  user: { id: string; name: string };
}

const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const n = (d: Decimal) => Number(r2(d).toFixed(2));

/**
 * Builds the saveTrnsSalesOsdc request. Line totals are tax-inclusive (taxblAmt = totAmt); the unit price
 * is restated tax-inclusive and any difference to the posted line (discounts, rounding) is the discount
 * amount, so every line and the header add up exactly.
 */
export function buildSale(input: SaleInput) {
  const fx = (d: Decimal) => r2(d.times(input.exchangeRate));
  const itemList = input.lines.map((l, i) => {
    const total = fx(l.netAmount.plus(l.taxAmount));
    const tax = fx(l.taxAmount);
    const qty = l.quantity.isZero() ? new Decimal(1) : l.quantity;
    const unitInclusive = l.priceIncludesTax ? l.unitPrice : l.unitPrice.times(new Decimal(100).plus(TAX_RATES[l.taxTyCd])).div(100);
    let prc = fx(unitInclusive);
    let supply = r2(prc.times(qty));
    let discount = supply.minus(total);
    // Rounding (not a discount) can leave the restated supply a little below the posted total.
    if (discount.isNeg() || (!l.discountPercent && discount.abs().lte(0.05))) {
      supply = total;
      prc = r2(total.div(qty));
      discount = new Decimal(0);
    }
    return {
      itemSeq: i + 1,
      itemCd: l.itemCd,
      itemClsCd: l.itemClsCd,
      itemNm: l.itemNm.slice(0, 200),
      bcd: null,
      pkgUnitCd: 'NT',
      pkg: n(qty),
      qtyUnitCd: 'U',
      qty: n(qty),
      prc: n(prc),
      splyAmt: n(supply),
      dcRt: l.discountPercent ? Number(l.discountPercent.toFixed(2)) : 0,
      dcAmt: n(discount),
      isrccCd: null,
      isrccNm: null,
      isrcRt: null,
      isrcAmt: null,
      taxTyCd: l.taxTyCd,
      taxblAmt: n(total),
      taxAmt: n(tax),
      totAmt: n(total),
    };
  });
  const by = (t: EtimsTaxType, f: 'taxblAmt' | 'taxAmt') => itemList.filter((l) => l.taxTyCd === t).reduce((s, l) => s.plus(l[f]), new Decimal(0));
  const header: Record<string, unknown> = {};
  for (const t of TYPES) {
    header[`taxblAmt${t}`] = n(by(t, 'taxblAmt'));
    header[`taxRt${t}`] = TAX_RATES[t];
    header[`taxAmt${t}`] = n(by(t, 'taxAmt'));
  }
  const totTaxbl = itemList.reduce((s, l) => s.plus(l.taxblAmt), new Decimal(0));
  const totTax = itemList.reduce((s, l) => s.plus(l.taxAmt), new Decimal(0));
  return {
    tin: input.tin,
    bhfId: input.bhfId,
    invcNo: input.invcNo,
    orgInvcNo: input.orgInvcNo,
    custTin: input.customerTin,
    custNm: input.customerName.slice(0, 60),
    salesTyCd: 'N',
    rcptTyCd: input.kind === 'CREDIT' ? 'R' : 'S',
    pmtTyCd: input.paymentTypeCode,
    salesSttsCd: '02',
    cfmDt: etimsDateTime(input.confirmedAt),
    salesDt: etimsDate(input.date),
    stockRlsDt: null,
    cnclReqDt: null,
    cnclDt: null,
    rfdDt: input.kind === 'CREDIT' ? etimsDateTime(input.confirmedAt) : null,
    rfdRsnCd: input.kind === 'CREDIT' ? '06' : null,
    totItemCnt: itemList.length,
    ...header,
    totTaxblAmt: n(totTaxbl),
    totTaxAmt: n(totTax),
    totAmt: n(totTaxbl),
    prchrAcptcYn: 'N',
    remark: input.documentNumber,
    regrId: input.user.id,
    regrNm: input.user.name.slice(0, 60),
    modrId: input.user.id,
    modrNm: input.user.name.slice(0, 60),
    receipt: {
      custTin: input.customerTin,
      custMblNo: null,
      rptNo: null,
      trdeNm: null,
      adrs: null,
      topMsg: null,
      btmMsg: null,
      prchrAcptcYn: 'N',
    },
    itemList,
  };
}

export interface SaleResult {
  curRcptNo: number;
  totRcptNo: number;
  intrlData: string;
  rcptSign: string;
  sdcDateTime: string;
}

export class EtimsClient {
  private readonly base: string;

  constructor(
    environment: EtimsEnvironment,
    private readonly tin: string,
    private readonly bhfId: string,
    private readonly cmcKey: string | null,
  ) {
    // Tests point this at a stand-in server.
    this.base = (process.env.ETIMS_BASE_URL ?? BASE[environment]).replace(/\/$/, '');
  }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', tin: this.tin, bhfId: this.bhfId, ...(this.cmcKey && { cmcKey: this.cmcKey }) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => null)) as { resultCd?: string; resultMsg?: string; data?: T } | null;
    if (!res.ok || !data) throw new EtimsError(`KRA eTIMS did not answer (${res.status})`, null);
    // Result codes are strings; "000" is success. Never compare as numbers.
    if (String(data.resultCd) !== '000') throw new EtimsError(`KRA eTIMS ${data.resultCd}: ${data.resultMsg ?? 'rejected'}`, String(data.resultCd ?? ''));
    return (data.data ?? {}) as T;
  }

  /** Initialises the device; returns the communication key (store it encrypted). */
  async initialise(dvcSrlNo: string) {
    const data = await this.call<{ info?: { cmcKey?: string; sdcId?: string; mrcNo?: string; taxprNm?: string; bhfNm?: string } }>('/selectInitOsdcInfo', { tin: this.tin, bhfId: this.bhfId, dvcSrlNo });
    const info = data.info ?? (data as { cmcKey?: string; sdcId?: string; mrcNo?: string; taxprNm?: string });
    if (!info.cmcKey) throw new EtimsError('KRA eTIMS did not return a communication key', null);
    return { cmcKey: info.cmcKey, sdcId: info.sdcId ?? '', mrcNo: info.mrcNo ?? '', tradeName: info.taxprNm ?? '' };
  }

  saveItem(item: { itemCd: string; itemClsCd: string; itemTyCd: string; itemNm: string; taxTyCd: string; dftPrc: number; user: { id: string; name: string } }) {
    return this.call('/saveItem', {
      tin: this.tin,
      bhfId: this.bhfId,
      itemCd: item.itemCd,
      itemClsCd: item.itemClsCd,
      itemTyCd: item.itemTyCd,
      itemNm: item.itemNm.slice(0, 200),
      itemStdNm: null,
      orgnNatCd: 'KE',
      pkgUnitCd: 'NT',
      qtyUnitCd: 'U',
      taxTyCd: item.taxTyCd,
      btchNo: null,
      bcd: null,
      dftPrc: item.dftPrc,
      grpPrcL1: item.dftPrc,
      grpPrcL2: item.dftPrc,
      grpPrcL3: item.dftPrc,
      grpPrcL4: item.dftPrc,
      grpPrcL5: null,
      addInfo: null,
      sftyQty: null,
      isrcAplcbYn: 'N',
      useYn: 'Y',
      regrId: item.user.id,
      regrNm: item.user.name.slice(0, 60),
      modrId: item.user.id,
      modrNm: item.user.name.slice(0, 60),
    });
  }

  saveSale(payload: ReturnType<typeof buildSale>) {
    return this.call<SaleResult>('/saveTrnsSalesOsdc', payload);
  }

  /**
   * Sales invoices suppliers registered against our PIN since `lastReqDt` (YYYYMMDDHHmmss). KRA answers
   * "001" when there is nothing new.
   */
  async purchases(lastReqDt: string): Promise<SupplierSale[]> {
    try {
      const data = await this.call<{ saleList?: SupplierSale[] }>('/selectTrnsPurchaseSalesList', { tin: this.tin, bhfId: this.bhfId, lastReqDt });
      return data.saleList ?? [];
    } catch (err) {
      if (err instanceof EtimsError && err.resultCd === '001') return [];
      throw err;
    }
  }

  savePurchase(payload: ReturnType<typeof buildPurchase>) {
    return this.call('/insertTrnsPurchase', payload);
  }

  /** Items declared at customs for our PIN since `lastReqDt`. KRA answers "001" when there is nothing new. */
  async imports(lastReqDt: string): Promise<ImportItem[]> {
    try {
      const data = await this.call<{ itemList?: ImportItem[] }>('/selectImportItemList', { tin: this.tin, bhfId: this.bhfId, lastReqDt });
      return data.itemList ?? [];
    } catch (err) {
      if (err instanceof EtimsError && err.resultCd === '001') return [];
      throw err;
    }
  }

  /** Approves ("3") or rejects ("4") a declared item, naming the item code it was received as. */
  updateImport(input: { taskCd: string; dclDe: string; itemSeq: number; hsCd: string; itemClsCd: string | null; itemCd: string | null; approved: boolean; remark: string; user: { id: string; name: string } }) {
    return this.call('/updateImportItem', {
      tin: this.tin,
      bhfId: this.bhfId,
      taskCd: input.taskCd,
      dclDe: input.dclDe,
      itemSeq: input.itemSeq,
      hsCd: input.hsCd,
      itemClsCd: input.itemClsCd,
      itemCd: input.itemCd,
      imptItemSttsCd: input.approved ? '3' : '4',
      remark: input.remark.slice(0, 400),
      modrNm: input.user.name.slice(0, 60),
      modrId: input.user.id,
    });
  }

  saveStockIO(payload: ReturnType<typeof buildStockIO>) {
    return this.call('/insertStockIO', payload);
  }

  /** The quantity of an item left at the branch after its movements. */
  saveStockMaster(input: { itemCd: string; rsdQty: number; user: { id: string; name: string } }) {
    return this.call('/saveStockMaster', { tin: this.tin, bhfId: this.bhfId, itemCd: input.itemCd, rsdQty: input.rsdQty, regrId: input.user.id, regrNm: input.user.name.slice(0, 60), modrId: input.user.id, modrNm: input.user.name.slice(0, 60) });
  }
}

/** One supplier invoice as KRA lists it for the buyer. */
export interface SupplierSale {
  spplrTin: string;
  spplrNm?: string;
  spplrBhfId?: string;
  spplrInvcNo: number | string;
  rcptTyCd?: string;
  pmtTyCd?: string;
  cfmDt?: string;
  salesDt: string;
  totTaxblAmt: number;
  totTaxAmt: number;
  totAmt: number;
  itemList?: SupplierSaleItem[];
  [key: string]: unknown;
}

export interface SupplierSaleItem {
  itemSeq?: number;
  itemCd?: string | null;
  itemClsCd?: string | null;
  itemNm: string;
  pkgUnitCd?: string | null;
  pkg?: number;
  qtyUnitCd?: string | null;
  qty: number;
  prc: number;
  splyAmt: number;
  dcRt?: number;
  dcAmt?: number;
  taxTyCd: EtimsTaxType;
  taxblAmt: number;
  taxAmt: number;
  totAmt: number;
}

/**
 * Builds the insertTrnsPurchase request reporting our decision on a supplier invoice: accepted ("02")
 * when the bill is posted, or rejected ("04"). The lines are reported as the supplier registered them.
 */
export function buildPurchase(input: {
  tin: string;
  bhfId: string;
  invcNo: number;
  sale: SupplierSale;
  accepted: boolean;
  confirmedAt: Date;
  remark: string;
  user: { id: string; name: string };
}) {
  const items = (input.sale.itemList ?? []).map((i, n) => ({
    itemSeq: i.itemSeq ?? n + 1,
    itemCd: i.itemCd ?? null,
    itemClsCd: i.itemClsCd ?? null,
    itemNm: i.itemNm,
    bcd: null,
    spplrItemClsCd: i.itemClsCd ?? null,
    spplrItemCd: i.itemCd ?? null,
    spplrItemNm: i.itemNm,
    pkgUnitCd: i.pkgUnitCd ?? 'NT',
    pkg: i.pkg ?? i.qty,
    qtyUnitCd: i.qtyUnitCd ?? 'U',
    qty: i.qty,
    prc: i.prc,
    splyAmt: i.splyAmt,
    dcRt: i.dcRt ?? 0,
    dcAmt: i.dcAmt ?? 0,
    taxTyCd: i.taxTyCd,
    taxblAmt: i.taxblAmt,
    taxAmt: i.taxAmt,
    totAmt: i.totAmt,
    itemExprDt: null,
  }));
  const header: Record<string, unknown> = {};
  for (const t of TYPES) {
    header[`taxblAmt${t}`] = n(items.filter((i) => i.taxTyCd === t).reduce((s, i) => s.plus(i.taxblAmt), new Decimal(0)));
    header[`taxRt${t}`] = TAX_RATES[t];
    header[`taxAmt${t}`] = n(items.filter((i) => i.taxTyCd === t).reduce((s, i) => s.plus(i.taxAmt), new Decimal(0)));
  }
  return {
    tin: input.tin,
    bhfId: input.bhfId,
    invcNo: input.invcNo,
    orgInvcNo: 0,
    spplrTin: input.sale.spplrTin,
    spplrBhfId: input.sale.spplrBhfId ?? null,
    spplrNm: input.sale.spplrNm ?? null,
    spplrInvcNo: Number(input.sale.spplrInvcNo),
    regTyCd: 'A',
    pchsTyCd: 'N',
    rcptTyCd: 'P',
    pmtTyCd: input.sale.pmtTyCd ?? '02',
    pchsSttsCd: input.accepted ? '02' : '04',
    cfmDt: etimsDateTime(input.confirmedAt),
    pchsDt: input.sale.salesDt,
    wrhsDt: null,
    cnclReqDt: null,
    cnclDt: input.accepted ? null : etimsDateTime(input.confirmedAt),
    rfdDt: null,
    totItemCnt: items.length,
    ...header,
    totTaxblAmt: input.sale.totTaxblAmt,
    totTaxAmt: input.sale.totTaxAmt,
    totAmt: input.sale.totAmt,
    remark: input.remark.slice(0, 400),
    regrId: input.user.id,
    regrNm: input.user.name.slice(0, 60),
    modrId: input.user.id,
    modrNm: input.user.name.slice(0, 60),
    itemList: items,
  };
}

export interface StockLine {
  itemCd: string;
  itemClsCd: string;
  itemNm: string;
  quantity: Decimal;
  /** Value at cost in KES (positive). */
  value: Decimal;
  taxTyCd: EtimsTaxType;
}

/**
 * Builds the insertStockIO request for one source document's movements. Stock is reported at cost; the
 * stored-and-released number (sarNo) runs per branch.
 */
export function buildStockIO(input: { tin: string; bhfId: string; sarNo: number; sarTyCd: string; date: Date; remark: string; lines: StockLine[]; user: { id: string; name: string } }) {
  const itemList = input.lines.map((l, i) => {
    const qty = l.quantity.abs();
    const value = r2(l.value.abs());
    const prc = qty.isZero() ? new Decimal(0) : r2(value.div(qty));
    return {
      itemSeq: i + 1,
      itemCd: l.itemCd,
      itemClsCd: l.itemClsCd,
      itemNm: l.itemNm.slice(0, 200),
      bcd: null,
      pkgUnitCd: 'NT',
      pkg: n(qty),
      qtyUnitCd: 'U',
      qty: n(qty),
      itemExprDt: null,
      prc: n(prc),
      splyAmt: n(value),
      totDcAmt: 0,
      taxblAmt: n(value),
      taxTyCd: l.taxTyCd,
      taxAmt: 0,
      totAmt: n(value),
    };
  });
  const total = itemList.reduce((s, l) => s.plus(l.totAmt), new Decimal(0));
  return {
    tin: input.tin,
    bhfId: input.bhfId,
    sarNo: input.sarNo,
    orgSarNo: 0,
    regTyCd: 'M',
    custTin: null,
    custNm: null,
    custBhfId: null,
    sarTyCd: input.sarTyCd,
    ocrnDt: etimsDate(input.date),
    totItemCnt: itemList.length,
    totTaxblAmt: n(total),
    totTaxAmt: 0,
    totAmt: n(total),
    remark: input.remark.slice(0, 400),
    regrId: input.user.id,
    regrNm: input.user.name.slice(0, 60),
    modrId: input.user.id,
    modrNm: input.user.name.slice(0, 60),
    itemList,
  };
}

/** One item of a customs declaration, as KRA lists it for the importer. */
export interface ImportItem {
  taskCd: string;
  dclDe: string;
  itemSeq: number;
  dclNo?: string;
  hsCd?: string;
  itemNm: string;
  imptItemsttsCd?: string;
  orgnNatCd?: string;
  exptNatCd?: string;
  pkg?: number;
  pkgUnitCd?: string;
  qty: number;
  qtyUnitCd?: string;
  totWt?: number;
  netWt?: number;
  spplrNm?: string;
  agntNm?: string;
  invcFcurAmt?: number;
  invcFcurCd?: string;
  invcFcurExcrt?: number;
}
