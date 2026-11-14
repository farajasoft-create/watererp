/**
 * Fixed-window, in-memory rate limiter. On serverless platforms each instance keeps its own
 * counters, so this is a best-effort brake against brute force; put a shared limiter (e.g. the
 * Vercel firewall or a Redis-backed limiter) in front for hard guarantees.
 */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      if (this.windows.size > 10_000) this.prune(now);
      return true;
    }
    w.count++;
    return w.count <= this.limit;
  }

  private prune(now: number) {
    for (const [key, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(key);
  }
}
