// Bounded-concurrency fan-out. Promise.allSettled over a whole list is fine
// when the list is small and bounded, but not when its length comes from
// upstream data and each item is its own request: a Steam friend list can hold
// ~2000 entries, and STEAM_API_MIN_INTERVAL_MS defaults to 0, so the
// RateLimiter grants every permit immediately and all ~2000 requests go out at
// once — rate-limiting the very calls the fan-out is trying to make.

/**
 * Run `task` over every item with at most `limit` in flight, preserving input
 * order in the result. Never rejects: like Promise.allSettled, each item's
 * outcome is reported individually.
 */
export async function settledWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await task(items[i]!, i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
