import { BadRequestException } from '../../common/errors';
import { ClientSession, Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { Decimal, dec } from '../../common/money';
import { Db } from '../../database/db.service';
import { RateType } from '../../database/schemas';

export interface ResolvedRate {
  rate: Decimal;
  rateId: Types.ObjectId;
  effectiveDate: Date;
  inverted: boolean;
}

export class CurrenciesService {
  private precisionCache: Map<string, number> | null = null;

  constructor(private readonly db: Db) {}

  async precision(code: string): Promise<number> {
    if (!this.precisionCache) {
      const all = await this.db.currencies.find({}, { code: 1, precision: 1 }).lean();
      this.precisionCache = new Map(all.map((c) => [c.code, c.precision]));
    }
    const p = this.precisionCache.get(code);
    if (p === undefined) throw new BadRequestException(`Unknown currency ${code}`);
    return p;
  }

  invalidateCache() {
    this.precisionCache = null;
  }

  async ensureActive(user: Pick<AuthUser, 'organisationId'>, code: string, session?: ClientSession) {
    const exists = await this.db.currencies.exists({ code }).session(session ?? null);
    if (!exists) throw new BadRequestException(`Unknown currency ${code}`);
    await this.db.organisations.updateOne(
      { _id: user.organisationId },
      { $addToSet: { activeCurrencies: code } },
      { session },
    );
  }

  /**
   * Finds the most recent approved rate on or before `date`. Falls back to the inverse pair
   * (e.g. KES→USD when USD→KES is requested) so organisations only need to maintain one direction.
   */
  async findRate(
    organisationId: Types.ObjectId,
    from: string,
    to: string,
    date: Date,
    rateType: RateType = 'SPOT',
    session?: ClientSession,
  ): Promise<ResolvedRate | null> {
    if (from === to) return { rate: new Decimal(1), rateId: new Types.ObjectId(), effectiveDate: date, inverted: false };
    const base = { organisationId, rateType, status: 'APPROVED', effectiveDate: { $lte: date } };
    const [direct, inverse] = await Promise.all([
      this.db.exchangeRates
        .findOne({ ...base, fromCurrency: from, toCurrency: to })
        .sort({ effectiveDate: -1, createdAt: -1 })
        .session(session ?? null)
        .lean(),
      this.db.exchangeRates
        .findOne({ ...base, fromCurrency: to, toCurrency: from })
        .sort({ effectiveDate: -1, createdAt: -1 })
        .session(session ?? null)
        .lean(),
    ]);
    // Prefer whichever direction is more recent; on a tie prefer the direct quote.
    if (direct && (!inverse || direct.effectiveDate >= inverse.effectiveDate)) {
      return { rate: dec(direct.rate), rateId: direct._id, effectiveDate: direct.effectiveDate, inverted: false };
    }
    if (inverse) {
      return {
        rate: new Decimal(1).div(dec(inverse.rate)).toDecimalPlaces(10),
        rateId: inverse._id,
        effectiveDate: inverse.effectiveDate,
        inverted: true,
      };
    }
    return null;
  }
}
