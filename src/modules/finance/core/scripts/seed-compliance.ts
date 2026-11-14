/**
 * Demo data for Phase 10: a county government customer that withholds income tax and VAT (one
 * certificate received, one awaited), and the head office connected to KRA eTIMS in the sandbox but not
 * yet initialised (that needs the device serial KRA issues). Text messages stay off.
 */
import { Types } from 'mongoose';
import { AuthUser } from '../common/auth';
import { Decimal, toD128 } from '../common/money';
import { Services } from '../container';
import { Branch, LegalEntity } from '../database/schemas';

interface Context {
  s: Services;
  organisationId: Types.ObjectId;
  ke: LegalEntity & { _id: Types.ObjectId };
  hq: Branch & { _id: Types.ObjectId };
  accountant: AuthUser;
  approver: AuthUser;
  director: AuthUser;
}

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const D = (v: string | number) => new Decimal(v);

export async function seedCompliance(c: Context) {
  const { s, organisationId, ke, hq, accountant, approver, director } = c;
  const code = async (c: string) => (await s.db.taxCodes.findOne({ organisationId, code: c }).lean())!._id;
  const [vat16, wht5, whvat2] = [await code('VAT16'), await code('WHT5'), await code('WHVAT2')];
  const account = (await s.db.accounts.findOne({ organisationId, code: '4200' }).lean())!._id;
  const bank = (await s.db.bankAccounts.findOne({ organisationId, entityId: ke._id, currency: 'KES', type: 'BANK' }).lean())!;

  const [county] = await s.db.customers.create([
    {
      organisationId,
      code: 'NCCG',
      name: 'Nairobi City County',
      email: 'procurement@nairobi.example',
      phone: '0709 000 200',
      city: 'Nairobi',
      country: 'Kenya',
      taxId: 'P051000111Z',
      currency: 'KES',
      paymentTermsDays: 30,
      defaultAccountId: account,
      defaultTaxCodeId: vat16,
      withholdingTaxCodeIds: [wht5, whvat2],
    },
  ]);

  const post = async (date: string, description: string, amount: number) => {
    const doc = await s.documents.create(accountant, { entityId: ke._id, branchId: hq._id, kind: 'SALES_INVOICE', partyId: county._id, date: d(date), reference: `LPO ${date.replace(/-/g, '').slice(2)}`, lines: [{ description, quantity: D(1), unitPrice: D(amount), accountId: account, taxCodeId: vat16 }] });
    await s.documents.submit(accountant, doc._id);
    return (await s.documents.approve(approver, doc._id))!;
  };
  const july = await post('2026-07-15', 'ICT support services – Q3 retainer', 450000);
  const sept = await post('2026-09-10', 'Systems training for revenue staff', 280000);

  // The county pays the invoice less 5% income tax and 2% VAT withheld (on the net amount).
  const receipt = async (invoice: { _id: Types.ObjectId; total: unknown; subtotal: unknown }, date: string, reference: string) => {
    const total = D(String(invoice.total));
    const net = D(String(invoice.subtotal));
    const withheld = net.times(0.07);
    return s.payments.create(
      accountant,
      { entityId: ke._id, kind: 'RECEIPT', partyId: county._id, date: d(date), bankAccountId: bank._id, amount: total.minus(withheld), reference, withholdingTaxCodeIds: [wht5, whvat2], allocations: [{ documentId: invoice._id, amount: total }] },
      { post: true },
    );
  };
  const first = await receipt(july, '2026-08-20', 'RTGS NCCG 0820');
  await receipt(sept, '2026-10-01', 'RTGS NCCG 1001');
  await s.payments.recordCertificate(accountant, first!._id, { taxCodeId: wht5, certificateNumber: 'KRAWHT2026081544', certificateDate: d('2026-09-05') });
  await s.payments.recordCertificate(accountant, first!._id, { taxCodeId: whvat2, certificateNumber: 'KRAVWH2026081902', certificateDate: d('2026-09-05') });

  // Head office connected to KRA eTIMS (sandbox); initialising needs the serial KRA issues for the OSCU.
  const device = await s.etims.configure(director, { branchId: hq._id, enabled: true, environment: 'sandbox', tin: 'P051234500K', bhfId: '00', dvcSrlNo: 'OSCU-DEMO-0001', defaultItemClassCode: '8111150000', defaultTaxType: 'D' });

  // Supplier invoices as KRA would list them for our PIN, waiting in the eTIMS inbox.
  const officepro = await s.db.suppliers.findOne({ organisationId, code: 'OFFICEPRO' }, { _id: 1 }).lean();
  const item = (itemNm: string, qty: number, prc: number, taxTyCd: 'A' | 'B') => {
    const total = qty * prc;
    const tax = taxTyCd === 'B' ? Math.round((total * 16) / 116 * 100) / 100 : 0;
    return { itemNm, qty, prc, splyAmt: total, dcAmt: 0, taxTyCd, taxblAmt: total, taxAmt: tax, totAmt: total };
  };
  const inbox = [
    { tin: 'P051333444D', name: 'OFFICEPRO SUPPLIES LTD', invcNo: '3381', date: '2026-10-01', supplierId: officepro?._id ?? null, items: [item('Printer toner HP 26A', 4, 9860, 'B'), item('A4 paper ream', 20, 696, 'B')] },
    { tin: 'P051777666M', name: 'KAHAWA FRESH SUPPLIES', invcNo: '118', date: '2026-10-02', supplierId: null, items: [item('Coffee beans 1kg', 6, 1450, 'B'), item('Maize flour 2kg', 10, 180, 'A')] },
  ];
  // Two items customs cleared at Mombasa, waiting to be approved as stock items.
  for (const [itemSeq, itemName, hsCode, quantity, amount] of [
    [1, 'SOLAR PANELS 450W MONOCRYSTALLINE', '8541430000', 120, 14400],
    [2, 'LITHIUM BATTERY 5KWH', '8507600000', 30, 21000],
  ] as const) {
    await s.db.etimsImports.create([
      {
        organisationId,
        deviceId: device._id,
        branchId: hq._id,
        taskCd: 'TK20260918001',
        declarationNumber: '2026 MSA IM4 004512',
        declarationDate: '20260918',
        itemSeq,
        hsCode,
        itemName,
        originCountry: 'CN',
        exportCountry: 'CN',
        quantity,
        quantityUnit: 'U',
        supplierName: 'NINGBO SOLARTECH CO LTD',
        agentName: 'BAHARI CLEARING & FORWARDING',
        invoiceAmount: amount,
        invoiceCurrency: 'USD',
        invoiceExchangeRate: 129.4,
      },
    ]);
  }
  for (const p of inbox) {
    const total = p.items.reduce((t, i) => t + i.totAmt, 0);
    const tax = p.items.reduce((t, i) => t + i.taxAmt, 0);
    const raw = { spplrTin: p.tin, spplrNm: p.name, spplrBhfId: '00', spplrInvcNo: Number(p.invcNo), rcptTyCd: 'S', pmtTyCd: '02', salesDt: p.date.replace(/-/g, ''), totTaxblAmt: total, totTaxAmt: tax, totAmt: total, itemList: p.items };
    await s.db.etimsPurchases.create([
      { organisationId, deviceId: device._id, branchId: hq._id, supplierTin: p.tin, supplierName: p.name, supplierBhfId: '00', supplierInvcNo: p.invcNo, date: d(p.date), taxableAmount: toD128(D(total)), taxAmount: toD128(D(tax.toFixed(2))), totalAmount: toD128(D(total)), items: p.items, raw, supplierId: p.supplierId },
    ]);
  }
}
