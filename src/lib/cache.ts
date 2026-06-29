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
    const value = await compute();
    this.set(key, value);
    return value;
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
      const value = await compute();
      this.set(key, value);
      return value;
    } catch (err) {
      const stale = this.getStale(key);
      if (stale !== undefined) return stale;
      throw err;
    }
  }
}
