// Tiny in-memory TTL cache for read endpoints. Caching cuts latency and eases
// pressure on rate-limited upstreams. Expired entries are retained (bounded by
// max size) so they can be served as a stale fallback when the upstream is down.

interface Entry<T> {
  value: T;
  expires: number;
}

export class TtlCache<T> {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #map = new Map<string, Entry<T>>();
  // In-flight compute() promises, keyed like #map. Without this, two callers
  // racing on the same cold/expired key (e.g. two tools reading the same
  // cached dictionary at once) would each fire their own upstream request;
  // the second now shares the first's promise instead.
  readonly #pending = new Map<string, Promise<T>>();

  constructor(ttlMs: number, max = 500) {
    this.#ttlMs = ttlMs;
    this.#max = max;
  }

  /** Fresh (non-expired) value, or undefined. */
  get(key: string): T | undefined {
    const hit = this.#map.get(key);
    if (!hit) return undefined;
    return hit.expires > Date.now() ? hit.value : undefined;
  }

  /** Any cached value regardless of freshness — used for stale fallback. */
  getStale(key: string): T | undefined {
    return this.#map.get(key)?.value;
  }

  set(key: string, value: T): void {
    if (this.#ttlMs <= 0) return;
    if (!this.#map.has(key) && this.#map.size >= this.#max) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    this.#map.set(key, { value, expires: Date.now() + this.#ttlMs });
  }

  /** Get-or-compute, caching the resolved value. */
  async wrap(key: string, compute: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    return this.#dedupe(key, compute);
  }

  /**
   * Like wrap, but if `compute` throws and a previously-cached (possibly stale)
   * value exists, serve that instead of failing. Lets reads degrade gracefully
   * when the upstream is temporarily down.
   */
  async wrapStaleOnError(key: string, compute: () => Promise<T>): Promise<T> {
    const fresh = this.get(key);
    if (fresh !== undefined) return fresh;
    try {
      return await this.#dedupe(key, compute);
    } catch (err) {
      const stale = this.getStale(key);
      if (stale !== undefined) return stale;
      throw err;
    }
  }

  // Share one in-flight compute() promise across concurrent callers of the
  // same key, so a cold/expired key triggers exactly one upstream fetch no
  // matter how many callers race on it. The resolved value is cached exactly
  // once (by the shared promise's own .then, not per-caller); a rejection
  // propagates to every waiter and clears the slot so the next call retries.
  #dedupe(key: string, compute: () => Promise<T>): Promise<T> {
    const inFlight = this.#pending.get(key);
    if (inFlight) return inFlight;
    const promise = compute()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.#pending.delete(key));
    this.#pending.set(key, promise);
    return promise;
  }
}
