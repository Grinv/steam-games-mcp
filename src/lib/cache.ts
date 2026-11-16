// In-memory TTL cache behind HttpClient: one entry per request URL, holding
// Steam's raw response body. Caching a request — not a shaped result — keeps
// the cache out of every decision about what a response means: shaping,
// validation and combining several requests all run on the way out, so a
// partial or definitive answer is never mistaken for a failure, or stored as
// if it were complete. Expired entries are retained (bounded by size) so
// HttpClient can serve one as a stale fallback while Steam is down.
//
// Bodies are kept as text and parsed per read: a cached value can't be
// mutated by whoever shapes it, and its size is known for the bound. Ages are
// measured on the monotonic performance.now(): a wall clock stepped back would
// otherwise keep entries "fresh" for as long as the step.

interface Entry {
  value: string;
  expires: number;
  /** Wall-clock time it was stored, for telling a reader how old a stale copy
   *  is — display only; freshness is judged on `expires` (monotonic). */
  storedAt: number;
}

export class TtlCache {
  readonly #ttlMs: number;
  readonly #maxSize: number;
  #size = 0;
  readonly #map = new Map<string, Entry>();
  // In-flight compute() promises, keyed like #map. Without this, two callers
  // racing on the same cold/expired key (e.g. two tools reading the same
  // cached dictionary at once) would each fire their own upstream request;
  // the second now shares the first's promise instead.
  readonly #pending = new Map<string, Promise<string>>();

  /** `maxSize` bounds the total cached text in characters; the oldest
   *  entries are evicted past it. V8 keeps a string with any non-Latin-1
   *  character (a Russian or Chinese store page) at 2 bytes per character, so
   *  the default 16M characters is at most ~32 MB of memory per client. */
  constructor(ttlMs: number, maxSize = 16 * 1024 * 1024) {
    this.#ttlMs = ttlMs;
    this.#maxSize = maxSize;
  }

  /** Fresh (non-expired) value, or undefined. */
  get(key: string): string | undefined {
    const hit = this.#map.get(key);
    if (!hit) return undefined;
    return hit.expires > performance.now() ? hit.value : undefined;
  }

  /** Any cached value regardless of freshness, and when it was stored — used
   *  for stale fallback. */
  getStale(key: string): { value: string; storedAt: number } | undefined {
    const hit = this.#map.get(key);
    return hit && { value: hit.value, storedAt: hit.storedAt };
  }

  set(key: string, value: string): void {
    if (this.#ttlMs <= 0) return;
    // Re-inserted, not updated in place: a Map keeps a key's first insertion
    // position, so a key refreshed every TTL (the tag dictionary) would
    // otherwise be the first evicted and lose its stale fallback. Dropped
    // even when the new value is too big to keep: an older copy would no
    // longer be Steam's latest answer.
    this.#delete(key);
    if (value.length > this.#maxSize) return;
    this.#map.set(key, { value, expires: performance.now() + this.#ttlMs, storedAt: Date.now() });
    this.#size += value.length;
    for (const oldest of this.#map.keys()) {
      if (this.#size <= this.#maxSize) break;
      this.#delete(oldest);
    }
  }

  /** Fresh value, or compute() it — shared across concurrent callers of the
   *  same key — and cache what it resolves to. A rejection propagates to every
   *  waiter, is never cached, and clears the slot so the next call retries. */
  wrap(key: string, compute: () => Promise<string>): Promise<string> {
    const fresh = this.get(key);
    if (fresh !== undefined) return Promise.resolve(fresh);
    const inFlight = this.#pending.get(key);
    if (inFlight) return inFlight;
    const promise = compute()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.#pending.delete(key));
    // The cache owns this shared promise; each waiter observes it through its
    // own chain. Marked handled here, so a failure that every waiter has
    // stopped waiting for (e.g. all of them cancelled) isn't an unhandled
    // rejection — whoever still awaits it gets the error as before.
    promise.catch(() => {});
    this.#pending.set(key, promise);
    return promise;
  }

  #delete(key: string): void {
    const hit = this.#map.get(key);
    if (!hit) return;
    this.#size -= hit.value.length;
    this.#map.delete(key);
  }
}
