import { describe, expect, it } from 'vitest';
import { Decimal } from '../../common/money';
import { buildStockIO } from './etims';
import { sarTypeFor } from './etims-stock.service';

describe('eTIMS stock reporting', () => {
  it('maps movement types and directions to KRA stock in/out types', () => {
    const d = (n: number) => new Decimal(n);
    expect(sarTypeFor('PURCHASE', d(5))).toBe('02');
    expect(sarTypeFor('PURCHASE', d(-5))).toBe('12');
    expect(sarTypeFor('SALE', d(-3))).toBe('11');
    expect(sarTypeFor('SALE', d(3))).toBe('03');
    expect(sarTypeFor('SALES_RETURN', d(1))).toBe('03');
    expect(sarTypeFor('PURCHASE_RETURN', d(-1))).toBe('12');
    expect(sarTypeFor('TRANSFER_IN', d(2))).toBe('04');
    expect(sarTypeFor('TRANSFER_OUT', d(-2))).toBe('13');
    expect(sarTypeFor('ADJUSTMENT', d(4))).toBe('06');
    expect(sarTypeFor('ADJUSTMENT', d(-4))).toBe('16');
    expect(sarTypeFor('OPENING', d(10))).toBe('06');
    expect(sarTypeFor('REVERSAL', d(-10))).toBe('16');
  });

  it('reports quantities and cost as positive amounts that add up', () => {
    const p = buildStockIO({
      tin: 'P051234567A',
      bhfId: '00',
      sarNo: 3,
      sarTyCd: '11',
      date: new Date('2026-03-02T00:00:00Z'),
      remark: 'INV-KE01-000002',
      user: { id: 'u', name: 'User' },
      lines: [
        { itemCd: 'KE2NTU0000001', itemClsCd: '5020230500', itemNm: 'Widget', quantity: new Decimal(-3), value: new Decimal(-345), taxTyCd: 'B' },
        { itemCd: 'KE2NTU0000002', itemClsCd: '5020230500', itemNm: 'Gadget', quantity: new Decimal(-1), value: new Decimal(-99.995), taxTyCd: 'A' },
      ],
    });
    expect(p).toMatchObject({ sarNo: 3, orgSarNo: 0, sarTyCd: '11', ocrnDt: '20260302', totItemCnt: 2, totAmt: 445, totTaxAmt: 0 });
    expect(p.itemList[0]).toMatchObject({ qty: 3, prc: 115, splyAmt: 345, totAmt: 345 });
    expect(p.itemList[1]).toMatchObject({ qty: 1, prc: 100, splyAmt: 100 });
  });
});
