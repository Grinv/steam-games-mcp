// Thin fetch wrapper shared by both API clients: timeouts, bounded retries
// with exponential backoff (honoring Retry-After), a default User-Agent,
// uniform mapping of failures to ApiError, and the response cache.
// A namespace import, not a destructured one: node:test's mocked timers only
// replace what's looked up on the module at call time.
import * as timers from "node:timers/promises";
import { ApiError, classifyStatus } from "./errors.ts";
import { TtlCache } from "./cache.ts";
import { CallCancelled, callScope, untilCancelled } from "./call.ts";
import type { Logger } from "./logger.ts";
import { USER_AGENT } from "../version.ts";

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** Cache the response for HttpClientOptions.cacheTtlMs, keyed by the URL,
   *  and serve a stale copy if Steam fails transiently. Only for answers that
   *  don't depend on who asks or need to be live (catalog data, dictionaries,
   *  charts) — never for a player's library or friends. */
  cache?: boolean;
  /** Throws (an ApiError) when Steam answered with a body this call can't use
   *  — e.g. an empty tag dictionary. Runs before caching, so such a body is
   *  never cached over a good one, and fails like any other request (a stale
   *  copy stands in if the error is retryable). */
  validate?: (body: unknown) => void;
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
  /** How long a `cache: true` response stays fresh; 0 disables caching. */
  cacheTtlMs?: number;
  /** This upstream's own reading of an HTTP failure from its full body (e.g.
   *  Steam's bad-key page → invalid_key) — not from `message`, which is
   *  truncated log text. Applied before retries and the cache decide
   *  anything, so they act on what actually happened. */
  classify?: (err: ApiError, body: string) => ApiError;
  /** This upstream's paths name a player (e.g. a community profile): log the
   *  origin only, and keep its error pages (which may echo the path) out of
   *  the error message, which is logged. */
  privatePaths?: boolean;
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
    if (!options.cache) {
      // The check parses the body; keep that, rather than parsing it again.
      let body: object | undefined;
      const check = (text: string) => void (body = checked(text, options));
      await this.#request(url, "application/json", signal, check);
      return body as T;
    }
    return (await this.#cached(url, options, signal)) as T;
  }

  /** The raw response body, for the rare upstream that doesn't speak JSON —
   *  Steam's community profile view (`?xml=1`) is the only one here. Same
   *  timeouts, retries and ApiError mapping as getJson. */
  async getText(path: string, options: Pick<RequestOptions, "query"> = {}): Promise<string> {
    const url = this.#buildUrl(path, options.query);
    return (await this.#request(url, "*/*", callScope.getStore()?.signal)) ?? "";
  }

  // A fresh cached body, else a request — shared with concurrent callers of
  // the same URL. A body that isn't JSON fails like a request (bad_response)
  // and is never cached. Steam failing transiently (`retryable`) is answered
  // with the stale copy if there is one; a definitive answer (4xx) or a bug
  // propagates.
  //
  // The request is shared, so a cancelled call only stops waiting for it: the
  // other waiters still get its answer, and so does the cache.
  // Resolves to the parsed body (checked before it was cached, so an object).
  async #cached(url: string, options: RequestOptions, signal?: AbortSignal): Promise<unknown> {
    // Before starting a request nobody would wait for (or handle the failure of).
    if (signal?.aborted) throw cancelled(signal);
    const stale = this.#cache.getStale(url);
    // The caller whose request this is keeps the body its check parsed;
    // anyone answered from cache (or sharing that request) parses the text.
    let parsed: object | undefined;
    try {
      const shared = this.#cache.wrap(url, async () => {
        // With a stale copy to fall back on, a retry would only delay the
        // answer it ends in (up to ~45 s of timeouts with the defaults).
        // However old the copy, the agent is told when it was stored (a
        // note); a maximum age would turn that answer into an error.
        const retries = stale === undefined ? undefined : 0;
        const check = (text: string) => void (parsed = checked(text, options));
        return (await this.#request(url, "application/json", undefined, check, retries)) ?? "";
      });
      const text = await untilCancelled(shared, signal);
      return parsed ?? parseJson(text);
    } catch (err) {
      // A definitive answer is Steam's latest word: the copy before it no
      // longer stands in for a later failure (as a new body replaces it).
      if (err instanceof ApiError && !err.retryable) this.#cache.delete(url);
      if (stale === undefined || !(err instanceof ApiError && err.retryable)) throw err;
      callScope.getStore()?.stale.push({ err: err as ApiError, storedAt: stale.storedAt });
      return parseJson(stale.value);
    }
  }

  // `signal` (the call's cancellation) aborts the rate-limit wait, the fetch
  // and the backoff between retries alike; any of them ends in CallCancelled.
  // `check` vets the body inside the attempt, so an unusable answer that may
  // be a hiccup (a retryable bad_response) is retried like a 5xx.
  async #request(
    url: string,
    accept: string,
    signal?: AbortSignal,
    check?: (text: string) => void,
    retriesOverride?: number,
  ): Promise<string | undefined> {
    const retries = retriesOverride ?? this.#opts.retries ?? 2;
    const timeoutMs = this.#opts.timeoutMs ?? 15000;

    let attempt = 0;
    for (;;) {
      try {
        if (this.#opts.beforeRequest) await this.#opts.beforeRequest(signal);
        const text = await this.#once(url, accept, timeoutMs, signal);
        check?.(text ?? "");
        return text;
      } catch (err) {
        // #once already turns every fetch failure into an ApiError, so
        // anything else here — a bug in `check`/`validate` — is a bug, never
        // a "network" failure to retry or answer with a stale copy; checked
        // before cancellation, so a bug landing alongside a cancel is still one.
        if (!(err instanceof ApiError)) throw err;
        if (signal?.aborted) throw cancelled(signal);
        const apiErr = err;
        if (!apiErr.retryable || attempt >= retries) throw apiErr;
        const backoff = backoffMs(attempt, apiErr);
        // Never log a player identifier (steamid/vanity), which redact()
        // (credentials-only) leaves untouched: it rides in the query string,
        // or in the path where privatePaths says so.
        const where = this.#opts.privatePaths ? new URL(url).origin : url.split("?")[0];
        this.#opts.logger.debug(
          `retrying ${where} after ${backoff}ms (attempt ${attempt + 1}/${retries}, ${apiErr.code})`,
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
    // The one place a non-ApiError becomes an ApiError, bound to the I/O
    // itself (the fetch, reading the body) rather than to a block of code:
    // whatever else runs here — classify, building the error — fails as the
    // bug it is, not as "network".
    const io = <T>(op: Promise<T>): Promise<T> =>
      op.catch((err: unknown) => {
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
      });
    try {
      const res = await io(
        fetch(url, {
          headers: { "User-Agent": USER_AGENT, Accept: accept },
          signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        }),
      );
      if (res.ok) return res.status === 204 ? undefined : await io(res.text());
      // The body is what classify reads (e.g. Steam's bad-key page): when it
      // can't be read, what this failure means is unknown — an I/O failure,
      // not an answer to read off the status alone.
      const raw = await io(res.text());
      const err = toHttpError(res, raw, !this.#opts.privatePaths);
      throw this.#opts.classify ? this.#opts.classify(err, raw) : err;
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

function toHttpError(res: Response, raw: string, logBody: boolean): ApiError {
  const { code, retryable } = classifyStatus(res.status);
  // The body is log-only text, never shown to the agent; that it is a JSON
  // object at all (the method answered, not a gateway page) is the one fact
  // read from it.
  return new ApiError({
    code,
    status: res.status,
    retryable,
    message: `HTTP ${res.status} ${res.statusText}${raw && logBody ? `: ${raw.slice(0, 500)}` : ""}`,
    retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    jsonBody: isJsonObject(raw),
  });
}

function isJsonObject(text: string): boolean {
  try {
    return isObject(JSON.parse(text));
  } catch {
    return false; // an HTML page, or nothing: not JSON is the answer here
  }
}

// What Steam answers with, as data or as an error's own body: a JSON object.
function isObject(v: unknown): v is object {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// The parsed body, after the call's own validation: what may be cached.
// getJson<T> promises an object, and every Steam JSON endpoint answers with
// one — so an empty body, `null` or any non-object is an unusable answer
// (retryable), not data: it used to come back as `undefined as T`, which
// callers then dereferenced into an internal error.
function checked(text: string, options: RequestOptions): object {
  const body = parseJson(text);
  if (!isObject(body)) {
    throw new ApiError({
      code: "bad_response",
      message: `Upstream returned ${text.length === 0 ? "an empty body" : `a non-object JSON body (${text.slice(0, 20)})`}`,
      retryable: true,
    });
  }
  options.validate?.(body);
  return body;
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined; // checked() reports it
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

function cancelled(signal: AbortSignal): CallCancelled {
  return new CallCancelled(signal.reason);
}
