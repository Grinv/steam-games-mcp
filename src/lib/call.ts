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

/** Record that `what` is missing from this call's answer because of `err`. */
export function noteDegraded(what: string, err: ApiError): void {
  callScope.getStore()?.degraded.push({ what, err });
}

/**
 * Await an optional part of a tool's answer: what Steam fails to provide is
 * recorded (so the model is told, and the log has it) and becomes `undefined`
 * — the formatter's "unknown", never a negative fact. A bug, or the call's own
 * cancellation, still propagates. A required part is a plain `await`.
 */
export async function optional<T>(what: string, work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch (err) {
    if (!(err instanceof ApiError) || err.code === "cancelled") throw err;
    noteDegraded(what, err);
    return undefined;
  }
}
