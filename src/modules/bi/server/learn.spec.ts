import { describe, expect, it } from 'vitest';
import { auc, kmeans, predict, seededOrder, trainLogistic } from './learn';

describe('logistic regression', () => {
  it('learns which feature drives the outcome and ranks well', () => {
    const order = seededOrder(400, 7);
    const rows: number[][] = [];
    const labels: number[] = [];
    for (const i of order) {
      const arrears = (i % 20) * 10; // days in arrears
      const noise = (i * 37) % 11;
      rows.push([arrears, noise]);
      labels.push(arrears + ((i * 13) % 40) > 120 ? 1 : 0);
    }
    const m = trainLogistic(rows, labels, ['arrears', 'noise']);
    expect(m.weights[1]).toBeGreaterThan(1); // arrears matters
    expect(Math.abs(m.weights[2])).toBeLessThan(0.5); // noise does not
    const score = auc(rows.map((r) => predict(m, r)), labels)!;
    expect(score).toBeGreaterThan(0.9);
    expect(predict(m, [190, 5])).toBeGreaterThan(predict(m, [10, 5]));
  });

  it('computes AUC for perfect, random-like and degenerate cases', () => {
    expect(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
    expect(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])).toBe(0);
    expect(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1])).toBe(0.5);
    expect(auc([0.3, 0.4], [1, 1])).toBeNull();
  });

  it('finds natural groups with k-means', () => {
    const rows: number[][] = [];
    for (let i = 0; i < 30; i++) rows.push([5 + (i % 3), 100 + (i % 5)]); // small users who pay
    for (let i = 0; i < 30; i++) rows.push([40 + (i % 4), 95 + (i % 3)]); // big users who pay
    for (let i = 0; i < 30; i++) rows.push([8 + (i % 3), 20 + (i % 6)]); // small users who do not
    const r = kmeans(rows, 3);
    expect([...r.sizes].sort()).toEqual([30, 30, 30]);
    expect(new Set(r.assign.slice(0, 30)).size).toBe(1);
    expect(new Set(r.assign.slice(30, 60)).size).toBe(1);
    expect(r.assign[0]).not.toBe(r.assign[30]);
    const big = r.centres[r.assign[30]];
    expect(big[0]).toBeGreaterThan(35);
    expect(kmeans(rows, 3)).toEqual(r); // repeatable
  });

  it('shuffles the same way for the same seed', () => {
    expect(seededOrder(10, 3)).toEqual(seededOrder(10, 3));
    expect(seededOrder(10, 3)).not.toEqual(seededOrder(10, 4));
    expect([...seededOrder(10, 3)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
