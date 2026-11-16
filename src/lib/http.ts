// Thin fetch wrapper shared by both API clients: timeouts, bounded retries
// with exponential backoff (honoring Retry-After), a default User-Agent,
// uniform mapping of failures to ApiError, and the response cache.
import { AsyncLocalStorage } from "node:async_hooks";
// A namespace import, not a destructured one: node:test's mocked timers only
// replace what's looked up on the module at call time.
import * as timers from "node:timers/promises";
import { ApiError, classifyStatus, type ApiErrorCode } from "./errors.ts";
import { TtlCache } from "./cache.ts";
import type { Logger } from "./logger.ts";
import { USER_AGENT } from "../version.ts";

/** One tool call, as the requests made on its behalf see it: the call's
 *  cancellation `signal`, and the upstream failures it was answered around
 *  with stale cache data (`staleErrors`, logged and flagged in the result's
 *  _meta by tools/guard.ts, which runs each call inside one scope). Outside a
 *  scope (e.g. prompt completions) both are no-ops. Async context rather than
 *  parameters threaded through every client method: a request can sit many
 *  calls deep. */
export const callScope = new AsyncLocalStorage<{
  signal?: AbortSignal;
  staleErrors: unknown[];
}>();

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** Per-request override of HttpClientOptions.hasCredentials — for a call that
   *  opportunistically attaches a credential without needing one (e.g. a
   *  keyless-by-design endpoint sent a key anyway because one happens to be
   *  configured), so a 401/403 there is attributed correctly instead of
   *  blaming the client's overall credential state. */
  hasCredentials?: boolean;
  /** Cache the response for HttpClientOptions.cacheTtlMs, keyed by the URL,
   *  and serve a stale copy if Steam fails transiently. Only for answers that
   *  don't depend on who asks or need to be live (catalog data, dictionaries,
   *  charts) — never for a player's library or friends. */
  cache?: boolean;
  /** Codes that, for this endpoint, are as likely a passing hiccup as a real
   *  answer, so a stale copy is preferred to them too (besides any `retryable`
   *  failure). An endpoint quirk, declared at its call site. */
  staleOn?: readonly ApiErrorCode[];
}

interface HttpClientOptions {
  baseUrl: string;
  logger: Logger;
  timeoutMs?: number;
  /** Max retry attempts for retryable failures (network/timeout/5xx/429). */
  retries?: number;
  /** Called before each request; lets callers throttle (rate limiting). It
   *  gets the call's cancellation signal, to stop waiting once it fires. */
  beforeRequest?: (signal?: AbortSignal) => Promise<void> | void;
  /** Whether this client ever sends a credential (API key/token) — fixed per
   *  client instance, not per request. Attached to any resulting ApiError so
   *  a 401/403 message can be precise instead of guessing. */
  hasCredentials?: boolean;
  /** How long a `cache: true` response stays fresh; 0 disables caching. */
  cacheTtlMs?: number;
}

const MAX_BACKOFF_MS = 8000;

export class HttpClient {
  readonly #opts: HttpClientOptions;
  readonly #cache: TtlCache;

  constructor(opts: HttpClientOptions) {
    this.#opts = opts;
    this.#cache = new TtlCache(opts.cacheTtlMs ?? 0);
  }

  async getJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.#buildUrl(path, options.query);
    const signal = callScope.getStore()?.signal;
    const text = options.cache
      ? await this.#cached(url, options, signal)
      : ((await this.#request(url, options, "application/json", signal)) ?? "");
    return text.length === 0 ? (undefined as T) : (parseJson(text) as T);
  }

  /** The raw response body, for the rare upstream that doesn't speak JSON —
   *  Steam's community profile view (`?xml=1`) is the only one here. Same
   *  timeouts, retries and ApiError mapping as getJson. */
  async getText(path: string, options: RequestOptions = {}): Promise<string> {
    const url = this.#buildUrl(path, options.query);
    return (await this.#request(url, options, "*/*", callScope.getStore()?.signal)) ?? "";
  }

  // A fresh cached body, else a request — shared with concurrent callers of
  // the same URL. A body that isn't JSON fails like a request (bad_response)
  // and is never cached. Steam failing transiently (`retryable`, or a code the
  // call site declared ambiguous via `staleOn`) is answered with the stale
  // copy if there is one; a definitive answer (4xx) or a bug propagates.
  //
  // The request is shared, so a cancelled call only stops waiting for it: the
  // other waiters still get its answer, and so does the cache.
  async #cached(url: string, options: RequestOptions, signal?: AbortSignal): Promise<string> {
    const stale = this.#cache.getStale(url);
    try {
      const shared = this.#cache.wrap(url, async () => {
        // With a stale copy to fall back on, a retry would only delay the
        // answer it ends in (up to ~45 s of timeouts with the defaults).
        const retries = stale === undefined ? undefined : 0;
        const text =
          (await this.#request(url, options, "application/json", undefined, retries)) ?? "";
        if (text.length > 0) parseJson(text);
        return text;
      });
      return await untilCancelled(shared, signal);
    } catch (err) {
      const staleWins =
        err instanceof ApiError && (err.retryable || options.staleOn?.includes(err.code));
      if (stale === undefined || !staleWins) throw err;
      callScope.getStore()?.staleErrors.push(err);
      return stale;
    }
  }

  // `signal` (the call's cancellation) aborts the rate-limit wait, the fetch
  // and the backoff between retries alike; any of them ends in `cancelled`.
  async #request(
    url: string,
    options: RequestOptions,
    accept: string,
    signal?: AbortSignal,
    retriesOverride?: number,
  ): Promise<string | undefined> {
    const retries = retriesOverride ?? this.#opts.retries ?? 2;
    const timeoutMs = this.#opts.timeoutMs ?? 15000;

    let attempt = 0;
    for (;;) {
      try {
        if (this.#opts.beforeRequest) await this.#opts.beforeRequest(signal);
        return await this.#once(url, options, accept, timeoutMs, signal);
      } catch (err) {
        if (signal?.aborted) throw cancelled(signal);
        const apiErr = err instanceof ApiError ? err : toNetworkError(err);
        if (!apiErr.retryable || attempt >= retries) throw apiErr;
        const backoff = backoffMs(attempt, apiErr);
        // Log the path only, never the query string — it can carry player
        // identifiers (steamid/vanity) that redact() (credentials-only) leaves
        // untouched. The endpoint alone is enough to debug a retry.
        this.#opts.logger.debug(
          `retrying ${url.split("?")[0]} after ${backoff}ms (attempt ${attempt + 1}/${retries}, ${apiErr.code})`,
        );
        try {
          await timers.setTimeout(backoff, undefined, { signal });
        } catch {
          throw cancelled(signal!); // only an abort rejects it
        }
        attempt += 1;
      }
    }
  }

  async #once(
    url: string,
    options: RequestOptions,
    accept: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    // Deliberately NOT AbortSignal.timeout(): its internal timer is unref'd
    // by design (won't keep the event loop alive on its own). On Node 22 a
    // test whose mocked fetch has no other pending I/O gets cancelled ("event
    // loop has already resolved") before the timeout fires; Node 24+ passes.
    // Revisit once the floor reaches 24. A plain (ref'd) setTimeout doesn't
    // have that risk on any version.
    // The timer stays armed until the body is read, not just the headers: an
    // upstream that sends headers and then stalls mid-body would otherwise
    // hang res.text() forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: accept },
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      });
      if (!res.ok) {
        throw await toHttpError(res, options.hasCredentials ?? this.#opts.hasCredentials);
      }
      if (res.status === 204) return undefined;
      return await res.text();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (signal?.aborted) throw cancelled(signal);
      if (controller.signal.aborted) {
        throw new ApiError({
          code: "timeout",
          message: `Request timed out after ${timeoutMs}ms`,
          retryable: true,
          cause: err,
        });
      }
      throw toNetworkError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  #buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(path.replace(/^\//, ""), ensureTrailingSlash(this.#opts.baseUrl));
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

async function toHttpError(res: Response, hasCredentials?: boolean): Promise<ApiError> {
  const { code, retryable } = classifyStatus(res.status);
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    /* ignore body read errors */
  }
  // The body is log-only: Steam answers errors with HTML pages (a CDN's, or
  // "verify your key="), never a structured reason worth showing the agent.
  return new ApiError({
    code,
    status: res.status,
    retryable,
    hadCredentials: hasCredentials,
    message: `HTTP ${res.status} ${res.statusText}${raw ? `: ${raw.slice(0, 500)}` : ""}`,
    retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ApiError({
      code: "bad_response",
      message: `Upstream returned invalid JSON (${text.length} bytes)`,
      retryable: true,
      cause: err,
    });
  }
}

function toNetworkError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError({
    code: "network",
    message: err instanceof Error ? `Network error: ${err.message}` : "Network error",
    retryable: true,
    cause: err,
  });
}

function backoffMs(attempt: number, err: ApiError): number {
  const hinted = err.retryAfterMs;
  if (hinted !== undefined && hinted > 0) return Math.min(hinted, MAX_BACKOFF_MS);
  const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
  // Random, not derived from `attempt`: concurrent requests failing together
  // (e.g. a burst answered with 429) must not all retry at the same instant.
  return base + Math.floor(base * 0.25 * Math.random());
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function ensureTrailingSlash(s: string): string {
  return s.endsWith("/") ? s : s + "/";
}

function cancelled(signal: AbortSignal): ApiError {
  return new ApiError({
    code: "cancelled",
    message: "Request cancelled by the caller",
    cause: signal.reason,
  });
}

// Settle with `promise`, or reject as cancelled as soon as `signal` fires —
// without touching `promise` itself, which other callers may share.
function untilCancelled<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
