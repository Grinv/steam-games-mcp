// Serializes calls and spaces them to respect both a minimum interval and any
// number of sliding-window limits (e.g. an upstream that allows N req/s AND
// M req/min). A single min-interval can satisfy a per-second cap but not a
// sustained per-minute one, so the window rules are what keep sustained traffic
// under the published ceiling.
//
// Acquisitions are ordered through a tail-promise chain, so only one runs at a
// time and the window bookkeeping stays consistent. In-flight network time still
// overlaps because acquire() resolves before the request itself runs.

export interface RateRule {
  /** Max granted acquisitions allowed within any `windowMs` span. */
  limit: number;
  windowMs: number;
}

export class RateLimiter {
  readonly #minIntervalMs: number;
  readonly #rules: RateRule[];
  readonly #maxWindowMs: number;
  // Ascending timestamps of granted acquisitions, pruned to the largest window.
  readonly #history: number[] = [];
  #tail: Promise<void> = Promise.resolve();
  #lastStart = 0;

  constructor(minIntervalMs: number, rules: RateRule[] = []) {
    this.#minIntervalMs = Math.max(0, minIntervalMs);
    this.#rules = rules;
    this.#maxWindowMs = rules.reduce((max, r) => Math.max(max, r.windowMs), 0);
  }

  /** Resolves when the caller is allowed to proceed. */
  acquire(): Promise<void> {
    const prev = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    return prev.then(async () => {
      const wait = this.#delayUntilAllowed();
      if (wait > 0) await delay(wait);
      const now = Date.now();
      this.#lastStart = now;
      this.#record(now);
      // Release the next waiter's gate; the spacing above keeps them in line.
      release();
    });
  }

  /** Earliest delay (ms) before another acquisition stays within every limit. */
  #delayUntilAllowed(): number {
    const now = Date.now();
    let until = this.#lastStart + this.#minIntervalMs;
    for (const rule of this.#rules) {
      if (this.#history.length < rule.limit) continue;
      // Once the `limit`-th most recent request leaves the window, there is
      // room for one more. Stale entries land in the past and drop out via max.
      const nth = this.#history[this.#history.length - rule.limit]!;
      until = Math.max(until, nth + rule.windowMs);
    }
    return Math.max(0, until - now);
  }

  #record(ts: number): void {
    this.#history.push(ts);
    const cutoff = ts - this.#maxWindowMs;
    let stale = 0;
    while (stale < this.#history.length && this.#history[stale]! <= cutoff) stale += 1;
    if (stale > 0) this.#history.splice(0, stale);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
