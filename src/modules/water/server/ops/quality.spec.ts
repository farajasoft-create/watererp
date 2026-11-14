import { describe, expect, it } from 'vitest';
import { assessQuality, hoursPerDay } from './quality';

describe('drinking water quality', () => {
  it('passes a good network sample and lists every failure of a bad one', () => {
    expect(assessQuality('NETWORK', { residualChlorine: '0.3', turbidity: '1.2', ph: '7.1', eColi: '0' })).toEqual({ passed: true, failures: [] });
    const bad = assessQuality('CONSUMER_TAP', { residualChlorine: '0.1', turbidity: '7', ph: '9', eColi: '3' });
    expect(bad.passed).toBe(false);
    expect(bad.failures).toHaveLength(4);
  });

  it('allows more chlorine leaving the works, and does not judge raw water', () => {
    expect(assessQuality('TREATED', { residualChlorine: '0.9' }).passed).toBe(true);
    expect(assessQuality('NETWORK', { residualChlorine: '0.9' }).passed).toBe(false);
    expect(assessQuality('RAW', { turbidity: '80', eColi: '200' }).passed).toBe(true);
  });
});

describe('hours of supply', () => {
  it('averages a rationing timetable over the week', () => {
    expect(hoursPerDay([])).toBe(24);
    // 06:00–18:00 on Mon, Wed, Fri: 36 hours a week.
    expect(hoursPerDay([{ days: [1, 3, 5], from: '06:00', to: '18:00' }])).toBe(5.1);
    expect(hoursPerDay([{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '00:00' }])).toBe(24);
  });
});
