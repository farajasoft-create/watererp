/**
 * Small, dependency-free machine learning used by the analytics: logistic regression trained by gradient
 * descent on standardised features with L2 regularisation, and the area under the ROC curve to judge it.
 */

export interface LogisticModel {
  features: string[];
  /** Per-feature mean and spread used to standardise inputs. */
  mean: number[];
  sd: number[];
  /** Intercept first, then one weight per (standardised) feature. */
  weights: number[];
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function trainLogistic(rows: number[][], labels: number[], features: string[], opts: { epochs?: number; rate?: number; l2?: number } = {}): LogisticModel {
  const n = rows.length;
  const k = features.length;
  const mean = Array.from({ length: k }, (_, j) => rows.reduce((s, r) => s + r[j], 0) / n);
  const sd = Array.from({ length: k }, (_, j) => Math.sqrt(rows.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / n) || 1);
  const x = rows.map((r) => r.map((v, j) => (v - mean[j]) / sd[j]));
  const w = new Array(k + 1).fill(0);
  const epochs = opts.epochs ?? 600;
  const rate = opts.rate ?? 0.3;
  const l2 = opts.l2 ?? 0.01;
  // Weight the rarer class up so a few defaulters are not drowned out.
  const pos = labels.filter((y) => y === 1).length;
  const wPos = pos ? n / (2 * pos) : 1;
  const wNeg = n - pos ? n / (2 * (n - pos)) : 1;
  for (let e = 0; e < epochs; e++) {
    const grad = new Array(k + 1).fill(0);
    for (let i = 0; i < n; i++) {
      const p = sigmoid(w[0] + x[i].reduce((s, v, j) => s + v * w[j + 1], 0));
      const err = (p - labels[i]) * (labels[i] === 1 ? wPos : wNeg);
      grad[0] += err;
      for (let j = 0; j < k; j++) grad[j + 1] += err * x[i][j];
    }
    for (let j = 0; j <= k; j++) w[j] -= rate * (grad[j] / n + (j ? l2 * w[j] : 0));
  }
  return { features, mean, sd, weights: w };
}

export function predict(m: LogisticModel, row: number[]) {
  return sigmoid(m.weights[0] + row.reduce((s, v, j) => s + ((v - m.mean[j]) / m.sd[j]) * m.weights[j + 1], 0));
}

/** Area under the ROC curve: the chance a random positive scores above a random negative (0.5 = no skill). */
export function auc(scores: number[], labels: number[]) {
  const pairs = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s);
  let rank = 0;
  let sumPos = 0;
  let pos = 0;
  for (let i = 0; i < pairs.length; ) {
    let j = i;
    while (j < pairs.length && pairs[j].s === pairs[i].s) j++;
    const avg = (rank + 1 + rank + (j - i)) / 2;
    for (let t = i; t < j; t++) if (pairs[t].y === 1) {
      sumPos += avg;
      pos++;
    }
    rank += j - i;
    i = j;
  }
  const neg = pairs.length - pos;
  return pos && neg ? (sumPos - (pos * (pos + 1)) / 2) / (pos * neg) : null;
}

/**
 * k-means clustering on standardised features (k-means++ seeding, eight seeded starts, repeatable): returns each row's cluster,
 * the cluster centres in the original units, and their sizes.
 */
export function kmeans(rows: number[][], k: number, opts: { seed?: number; iterations?: number } = {}) {
  const n = rows.length;
  const dims = rows[0]?.length ?? 0;
  if (n < k) throw new Error(`Need at least ${k} rows to make ${k} groups`);
  const mean = Array.from({ length: dims }, (_, j) => rows.reduce((s, r) => s + r[j], 0) / n);
  const sd = Array.from({ length: dims }, (_, j) => Math.sqrt(rows.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / n) || 1);
  const x = rows.map((r) => r.map((v, j) => (v - mean[j]) / sd[j]));
  const dist = (a: number[], b: number[]) => a.reduce((s, v, j) => s + (v - b[j]) ** 2, 0);
  const run = (seed: number) => {
    let s = seed >>> 0;
    const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 2 ** 32);
    // k-means++: each next centre is drawn with probability proportional to its squared distance.
    const centres: number[][] = [[...x[Math.floor(rnd() * n)]]];
    while (centres.length < k) {
      const d = x.map((p) => Math.min(...centres.map((c) => dist(p, c))));
      const total = d.reduce((a, b) => a + b, 0);
      let r = rnd() * total;
      let pick = n - 1;
      for (let i = 0; i < n; i++) {
        r -= d[i];
        if (r <= 0) {
          pick = i;
          break;
        }
      }
      centres.push([...x[pick]]);
    }
    let assign = new Array(n).fill(0);
    for (let it = 0; it < (opts.iterations ?? 50); it++) {
      const next = x.map((p) => centres.reduce((bi, c, ci) => (dist(p, c) < dist(p, centres[bi]) ? ci : bi), 0));
      const changed = next.some((c, i) => c !== assign[i]);
      assign = next;
      for (let c = 0; c < k; c++) {
        const members = x.filter((_, i) => assign[i] === c);
        if (members.length) centres[c] = Array.from({ length: dims }, (_, j) => members.reduce((t, m) => t + m[j], 0) / members.length);
      }
      if (!changed && it > 0) break;
    }
    const inertia = x.reduce((t, p, i) => t + dist(p, centres[assign[i]]), 0);
    return { centres, assign, inertia };
  };
  // Several seeded starts; the tightest grouping wins.
  let best = run(opts.seed ?? 11);
  for (let r = 1; r < 8; r++) {
    const next = run((opts.seed ?? 11) + r * 7919);
    if (next.inertia < best.inertia - 1e-9) best = next;
  }
  const { centres, assign } = best;
  return {
    assign,
    centres: centres.map((c) => c.map((v, j) => v * sd[j] + mean[j])),
    sizes: Array.from({ length: k }, (_, c) => assign.filter((a) => a === c).length),
  };
}

/** A repeatable shuffle (seeded), for splitting training and test rows. */
export function seededOrder(n: number, seed = 42) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 2 ** 32);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
