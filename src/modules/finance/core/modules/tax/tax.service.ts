import { BadRequestException, NotFoundException } from '../../common/errors';
import { ClientSession, Types } from 'mongoose';
import { allowedBranches } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { Decimal, dec, round, toD128 } from '../../common/money';
import { TaxCode, TaxTransaction } from '../../database/commercial.schemas';
import { Db } from '../../database/db.service';

export interface LineAmounts {
  net: Decimal;
  tax: Decimal;
}

/**
 * Net and tax for one document line, rounded to the currency's precision. With tax-inclusive
 * pricing the entered amount is gross and tax is backed out of it.
 */
export function computeLine(input: {
  quantity: Decimal;
  unitPrice: Decimal;
  discountPercent?: Decimal | null;
  ratePercent: Decimal;
  inclusive: boolean;
  precision: number;
}): LineAmounts {
  const discount = dec(input.discountPercent);
  const amount = round(input.quantity.times(input.unitPrice).times(new Decimal(100).minus(discount)).div(100), input.precision);
  if (input.inclusive) {
    const net = round(amount.times(100).div(new Decimal(100).plus(input.ratePercent)), input.precision);
    return { net, tax: amount.minus(net) };
  }
  return { net: amount, tax: round(amount.times(input.ratePercent).div(100), input.precision) };
}

export type TaxRow = Omit<TaxTransaction, '_id' | 'createdAt'>;

export class TaxService {
  constructor(private readonly db: Db) {}

  /** The rate (percent) in force on `date`: the latest rate whose effective date is on or before it. */
  rateOn(code: Pick<TaxCode, 'code' | 'rates'>, date: Date): Decimal {
    const applicable = code.rates
      .filter((r) => r.effectiveFrom <= date)
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
    if (!applicable) throw new BadRequestException(`Tax code ${code.code} has no rate effective on ${date.toISOString().slice(0, 10)}`);
    return dec(applicable.rate);
  }

  async codes(organisationId: Types.ObjectId, ids: (Types.ObjectId | null | undefined)[], session?: ClientSession) {
    const unique = [...new Set(ids.filter(Boolean).map(String))];
    const codes = unique.length
      ? await this.db.taxCodes.find({ organisationId, _id: { $in: unique } }).session(session ?? null).lean()
      : [];
    return new Map(codes.map((c) => [c._id.toHexString(), c]));
  }

  /** Checks that a tax code can be used by an entity in the given role. */
  assertUsable(code: TaxCode | undefined, entityCountry: string, kind: TaxCode['kind'], label: string): TaxCode {
    if (!code) throw new BadRequestException(`${label}: tax code not found`);
    if (!code.isActive) throw new BadRequestException(`${label}: tax code ${code.code} is inactive`);
    if (code.kind !== kind) throw new BadRequestException(`${label}: ${code.code} is a ${code.kind.toLowerCase()} code`);
    if (code.country && entityCountry && code.country.toLowerCase() !== entityCountry.toLowerCase()) {
      throw new BadRequestException(`${label}: tax code ${code.code} applies to ${code.country}, not ${entityCountry}`);
    }
    return code;
  }

  async record(rows: TaxRow[], session: ClientSession) {
    if (rows.length) await this.db.taxTransactions.insertMany(rows, { session });
  }

  /** Writes negating rows for a voided source, dated on the void so closed returns are not restated. */
  async reverse(organisationId: Types.ObjectId, sourceId: Types.ObjectId, date: Date, journalId: Types.ObjectId | null, session: ClientSession) {
    const rows = await this.db.taxTransactions.find({ organisationId, sourceId }).session(session).lean();
    await this.record(
      rows.map(({ _id, createdAt: _c, ...r }) => ({
        ...r,
        date,
        journalId,
        taxableAmountTx: toD128(dec(r.taxableAmountTx).neg()),
        taxAmountTx: toD128(dec(r.taxAmountTx).neg()),
        taxableAmount: toD128(dec(r.taxableAmount).neg()),
        taxAmount: toD128(dec(r.taxAmount).neg()),
      })) as TaxRow[],
      session,
    );
  }

  /**
   * Tax return support: output and input VAT and withholding tax for a period, summarised by code
   * and rate, with the underlying transactions.
   */
  async report(user: AuthUser, entityId: Types.ObjectId, from: Date, to: Date) {
    if (from > to) throw new BadRequestException('"from" must be on or before "to"');
    const entity = await this.db.entities.findOne({ _id: entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new NotFoundException('Entity not found');
    const match: Record<string, unknown> = { organisationId: user.organisationId, entityId, date: { $gte: from, $lte: to } };
    const restricted = allowedBranches(user);
    if (restricted) match.branchId = { $in: restricted };

    const rows = await this.db.taxTransactions.find(match).sort({ date: 1, documentNumber: 1 }).limit(5001).lean();
    const summary = new Map<string, { direction: string; taxCode: string; rate: string; taxable: Decimal; tax: Decimal; count: number }>();
    for (const r of rows.slice(0, 5000)) {
      const key = `${r.direction}|${r.taxCode}|${dec(r.rate).toFixed()}`;
      const s = summary.get(key) ?? { direction: r.direction, taxCode: r.taxCode, rate: dec(r.rate).toFixed(), taxable: new Decimal(0), tax: new Decimal(0), count: 0 };
      s.taxable = s.taxable.plus(dec(r.taxableAmount));
      s.tax = s.tax.plus(dec(r.taxAmount));
      s.count++;
      summary.set(key, s);
    }
    const all = [...summary.values()].sort((a, b) => a.direction.localeCompare(b.direction) || a.taxCode.localeCompare(b.taxCode));
    const total = (direction: string) => all.filter((s) => s.direction === direction).reduce((a, s) => a.plus(s.tax), new Decimal(0));
    const output = total('OUTPUT');
    const input = total('INPUT');
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name, taxId: entity.taxId },
      currency: entity.functionalCurrency,
      from,
      to,
      summary: all,
      totals: {
        outputTax: output,
        inputTax: input,
        netVatPayable: output.minus(input),
        withholdingTax: total('WITHHOLDING'),
        /** Tax customers withheld from receipts: VAT withheld reduces VAT payable; income tax is a credit against income tax. */
        withheldByCustomers: total('WITHHELD'),
        vatWithheldByCustomers: all.filter((s) => s.direction === 'WITHHELD' && /VAT/i.test(s.taxCode)).reduce((a, s) => a.plus(s.tax), new Decimal(0)),
      },
      transactions: rows.slice(0, 5000),
      truncated: rows.length > 5000,
    };
  }
}
