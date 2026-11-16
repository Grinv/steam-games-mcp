// One tool call, as the code working on its behalf sees it, many calls deep:
// its cancellation signal, and what its answer had to do without. tools/
// guard.ts runs each call inside one scope and turns what was recorded into
// the result's `notes` (the model reads structuredContent only) and log
// lines. Async context rather than parameters threaded through every client
// method. Outside a scope (e.g. prompt completions) recording is a no-op.
import { AsyncLocalStorage } from "node:async_hooks";
import { ApiError } from "./errors.ts";

export interface CallState {
  signal?: AbortSignal;
  /** Optional parts of the answer that Steam failed to provide. */
  degraded: { what: string; err: ApiError }[];
  /** Upstream failures answered with a stale cached copy stored at `storedAt`. */
  stale: { err: ApiError; storedAt: number }[];
}

export const callScope = new AsyncLocalStorage<CallState>();

/** The client cancelled this call. Deliberately not an ApiError: it isn't
 *  Steam failing, so no code that answers around an upstream failure (an
 *  optional part, a stale copy, a lookup fallback) may treat it as one —
 *  catching ApiError lets it through untouched, and guard reports it. */
export class CallCancelled extends Error {
  constructor(reason?: unknown) {
    super("Call cancelled by the client", reason === undefined ? undefined : { cause: reason });
    this.name = "CallCancelled";
  }
}

/** Settle with `promise`, or reject with CallCancelled as soon as `signal`
 *  fires — without touching `promise` itself, which others may share. */
export function untilCancelled<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new CallCancelled(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CallCancelled(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Record that `what` is missing from this call's answer because of `err`. */
export function noteDegraded(what: string, err: ApiError): void {
  callScope.getStore()?.degraded.push({ what, err });
}

/**
 * Await an optional part of a tool's answer: what Steam fails to provide is
 * recorded (so the model is told, and the log has it) and becomes `undefined`
 * — the formatter's "unknown", never a negative fact. A bug, or the call's own
 * cancellation (not an ApiError), still propagates. A required part is a
 * plain `await`.
 */
export async function optional<T>(what: string, work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    noteDegraded(what, err);
    return undefined;
  }
}

/**
 * optional() for a batch: the parts that came back, in order. Each part
 * Steam failed to provide is noted as `what(i)` (its index in `settled`); a
 * bug or the call's cancellation in any part propagates.
 */
export function optionalParts<T>(
  settled: PromiseSettledResult<T>[],
  what: (i: number) => string,
): T[] {
  const parts: T[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") parts.push(r.value);
    else if (r.reason instanceof ApiError) noteDegraded(what(i), r.reason);
    else throw r.reason;
  });
  return parts;
}
