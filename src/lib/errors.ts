// Typed errors for upstream API failures. Clients throw `ApiError`; tool
// handlers convert it into an MCP tool result (see lib/result.ts) so the
// agent gets an actionable, non-protocol error.

export type ApiErrorCode =
  | "unauthorized" // 401 — token missing/expired/invalid
  | "forbidden" // 403 — insufficient permissions/scope
  | "not_found" // 404 — no such resource
  | "not_modified" // 304 — cached content still fresh (conditional request)
  | "rate_limited" // 429 (also 420, observed live from Steam) — slow down
  | "server_error" // 5xx — upstream broke
  | "network" // connection failed
  | "timeout" // request aborted by our timeout
  | "bad_request" // 400/405/422 — malformed or unsupported request
  | "unknown";

interface ApiErrorOptions {
  code: ApiErrorCode;
  message: string;
  status?: number;
  retryable?: boolean;
  cause?: unknown;
  /** Whether the request that failed carried a credential (API key/token).
   *  Set by the client, not guessed from the error itself — lets a 401/403
   *  message be precise instead of hedging between "bad credentials" and
   *  "this endpoint never sends any" (see lib/result.ts's messageFor). */
  hadCredentials?: boolean;
  /** True when `message` may embed raw, untrusted upstream response body text
   *  (e.g. an HTML error page from a CDN/edge) rather than a curated domain
   *  message or Steam's own structured JSON error field. Set only by
   *  `lib/http.ts`'s `toHttpError` — `messageFor()` (lib/result.ts) uses this
   *  to avoid echoing that text verbatim to the agent. */
  unsafeDetail?: boolean;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly hadCredentials: boolean | undefined;
  readonly unsafeDetail: boolean;

  constructor(opts: ApiErrorOptions) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ApiError";
    this.code = opts.code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.hadCredentials = opts.hadCredentials;
    this.unsafeDetail = opts.unsafeDetail ?? false;
  }
}

/** Run `fn`; if it rejects with an ApiError of the given `code`, resolve to
 *  `fallback` instead of propagating. Several Steam endpoints answer a raw
 *  HTTP error for some malformed/out-of-range input (e.g. a SteamID64 outside
 *  the valid 64-bit range) instead of their usual "nothing here" response —
 *  callers normalize that case to the same shape their usual empty response
 *  gets, rather than leaking the raw upstream error. */
export async function withFallbackOn<T>(
  code: ApiErrorCode,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.code === code) return fallback;
    throw e;
  }
}

/** Map an HTTP status code to an ApiErrorCode and whether a retry may help. */
export function classifyStatus(status: number): { code: ApiErrorCode; retryable: boolean } {
  if (status === 304) return { code: "not_modified", retryable: false };
  if (status === 401) return { code: "unauthorized", retryable: false };
  if (status === 403) return { code: "forbidden", retryable: false };
  if (status === 404) return { code: "not_found", retryable: false };
  // 420 isn't in Steam's documented status list, but the Store/Community
  // endpoints are observed live to answer it under load — the same
  // "slow down" signal as 429 (historically popularized by Twitter's API).
  if (status === 429 || status === 420) return { code: "rate_limited", retryable: true };
  if (status === 400 || status === 405 || status === 422)
    return { code: "bad_request", retryable: false };
  if (status >= 500) return { code: "server_error", retryable: true };
  return { code: "unknown", retryable: false };
}

/** Strip anything that looks like a credential before logging. The Steam Web
 *  API key travels as a `key` query param (e.g. logged request URLs), so it is
 *  redacted alongside the OAuth-style token params and the `apikey`/`api_key`
 *  spellings other upstreams use — `\b` alone doesn't stop `key` from matching
 *  mid-word (no boundary between word characters), hence the explicit variants. */
export function redact(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***")
    .replace(
      /\b(access_token|refresh_token|client_secret|client_id|api_key|apikey|key)=([^&\s"]+)/gi,
      "$1=***",
    );
}
