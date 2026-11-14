import { describe, expect, it } from 'vitest';
import { accountNumber } from '../customers/customers.service';
import { penalty, dueForDisconnection, ageingBucket } from '../billing/arrears';
import { accountCandidates, parseTransTime } from './mpesa';

describe('M-Pesa C2B', () => {
  it('reads TransTime as East Africa Time', () => {
    expect(parseTransTime('20261031143000').toISOString()).toBe('2026-10-31T11:30:00.000Z');
  });

  it('matches loosely typed account numbers', () => {
    expect(accountCandidates(' kam 42 ')).toEqual(['KAM42', 'KAM-00042']);
    expect(accountCandidates('KAM-00042')).toEqual(['KAM-00042']);
    expect(accountCandidates('kam-042')).toContain('KAM-00042');
    expect(accountCandidates('')).toEqual([]);
  });

  it('agrees with the account number format', () => {
    expect(accountCandidates('kam42')).toContain(accountNumber('KAM', 42));
  });
});

describe('arrears', () => {
  const today = new Date('2026-11-02T00:00:00Z');

  it('charges a penalty only on an overdue balance', () => {
    expect(penalty(2000, 2).toFixed(2)).toBe('40.00');
    expect(penalty(-50, 2).toFixed(2)).toBe('0.00');
    expect(penalty(2000, 0).toFixed(2)).toBe('0.00');
  });

  it('lists connections past the grace period with enough arrears', () => {
    const policy = { minArrears: 500, graceDays: 30 };
    expect(dueForDisconnection(1200, new Date('2026-09-15T00:00:00Z'), policy, today)).toBe(true);
    expect(dueForDisconnection(1200, new Date('2026-10-20T00:00:00Z'), policy, today)).toBe(false);
    expect(dueForDisconnection(300, new Date('2026-09-15T00:00:00Z'), policy, today)).toBe(false);
    expect(dueForDisconnection(1200, null, policy, today)).toBe(false);
  });

  it('buckets debt by days past due', () => {
    expect(ageingBucket(new Date('2026-11-10T00:00:00Z'), today)).toBe('current');
    expect(ageingBucket(new Date('2026-10-15T00:00:00Z'), today)).toBe('d30');
    expect(ageingBucket(new Date('2026-06-01T00:00:00Z'), today)).toBe('over90');
  });
});
