import { describe, expect, it } from 'vitest';
import { Decimal } from '../../common/money';
import { buildSale, etimsDateTime, itemCode, receiptUrl, SaleLine } from './etims';

const line = (over: Partial<SaleLine>): SaleLine => ({
  itemCd: 'KE3NTU0000001',
  itemClsCd: '8111150000',
  itemNm: 'Consulting',
  quantity: new Decimal(1),
  unitPrice: new Decimal(1000),
  priceIncludesTax: false,
  discountPercent: null,
  netAmount: new Decimal(1000),
  taxAmount: new Decimal(160),
  taxTyCd: 'B',
  ...over,
});

const sale = (lines: SaleLine[], over: Partial<Parameters<typeof buildSale>[0]> = {}) =>
  buildSale({
    tin: 'P051234567A',
    bhfId: '00',
    invcNo: 7,
    orgInvcNo: 0,
    kind: 'SALE',
    documentNumber: 'INV-KE01-000007',
    customerTin: null,
    customerName: 'Acme Ltd',
    date: new Date('2026-03-10T00:00:00Z'),
    confirmedAt: new Date('2026-03-10T09:15:00Z'),
    exchangeRate: new Decimal(1),
    paymentTypeCode: '02',
    lines,
    user: { id: 'u1', name: 'Reviewer' },
    ...over,
  });

describe('eTIMS sales payload', () => {
  it('reports tax-inclusive amounts by tax type, adding up exactly', () => {
    const p = sale([
      line({ quantity: new Decimal(3), unitPrice: new Decimal(333.33), netAmount: new Decimal(999.99), taxAmount: new Decimal(160) }),
      line({ itemNm: 'Exempt training', taxTyCd: 'A', netAmount: new Decimal(500), taxAmount: new Decimal(0), unitPrice: new Decimal(500) }),
    ]);
    expect(p.itemList[0]).toMatchObject({ qty: 3, taxTyCd: 'B', taxblAmt: 1159.99, taxAmt: 160, totAmt: 1159.99 });
    // 333.33 × 1.16 = 386.66 → 3 × 386.66 = 1159.98, a cent below the posted total: restated, no discount.
    expect(p.itemList[0].splyAmt - p.itemList[0].dcAmt).toBeCloseTo(p.itemList[0].totAmt, 2);
    expect(p.itemList[0].dcAmt).toBe(0);
    expect(p).toMatchObject({ taxblAmtA: 500, taxAmtA: 0, taxblAmtB: 1159.99, taxAmtB: 160, taxRtB: 16, taxRtE: 8, totTaxblAmt: 1659.99, totTaxAmt: 160, totAmt: 1659.99, totItemCnt: 2, rcptTyCd: 'S' });
  });

  it('shows discounts as the difference between the list price and the line total', () => {
    const p = sale([line({ quantity: new Decimal(10), unitPrice: new Decimal(100), discountPercent: new Decimal(10), netAmount: new Decimal(900), taxAmount: new Decimal(144) })]);
    expect(p.itemList[0]).toMatchObject({ prc: 116, splyAmt: 1160, dcRt: 10, dcAmt: 116, totAmt: 1044, taxAmt: 144 });
  });

  it('keeps tax-inclusive prices as entered', () => {
    const p = sale([line({ quantity: new Decimal(60), unitPrice: new Decimal(11020), priceIncludesTax: true, netAmount: new Decimal(570000), taxAmount: new Decimal(91200) })]);
    expect(p.itemList[0]).toMatchObject({ prc: 11020, splyAmt: 661200, dcAmt: 0, totAmt: 661200 });
  });

  it('converts foreign-currency documents to KES', () => {
    const p = sale([line({ unitPrice: new Decimal(100), netAmount: new Decimal(100), taxAmount: new Decimal(16) })], { exchangeRate: new Decimal(130) });
    expect(p.itemList[0]).toMatchObject({ prc: 15080, totAmt: 15080, taxAmt: 2080 });
  });

  it('marks credit notes with the invoice they correct', () => {
    const p = sale([line({})], { kind: 'CREDIT', orgInvcNo: 7, invcNo: 9 });
    expect(p).toMatchObject({ rcptTyCd: 'R', orgInvcNo: 7, invcNo: 9, rfdRsnCd: '06' });
  });

  it('formats codes, dates and the receipt link', () => {
    expect(itemCode('3', 42)).toBe('KE3NTU0000042');
    expect(etimsDateTime(new Date('2026-03-10T09:15:30Z'))).toBe('20260310121530');
    expect(receiptUrl('sandbox', 'P051234567A', '00', 'ABC/123')).toBe('https://etims-sbx.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=P051234567A00ABC%2F123');
  });
});
