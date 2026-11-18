// Typed errors for upstream API failures. Clients throw `ApiError`; tool
// handlers convert it into an MCP tool result (see lib/result.ts) so the
// agent gets an actionable, non-protocol error. Every known situation has its
// own code: the tool-facing text is built from code/status/detail only, and
// `message` is diagnostics for logs (it may hold a raw response body).

export type ApiErrorCode =
  | "invalid_key" // Steam rejected the configured API key (its "verify your key=" page, 403 or 401)
  | "unauthorized" // 401 — token missing/expired/invalid
  | "forbidden" // 403 — insufficient permissions/scope
  | "not_found" // 404 — no such resource
  | "rate_limited" // 429 (also 420, observed live from Steam) — slow down
  | "server_error" // 5xx — upstream broke
  | "network" // connection failed
  | "timeout" // request aborted by our timeout
  | "bad_request" // 400/405/422, or a request we can't serve as given
  | "bad_response" // a success status with a body we can't use (invalid JSON, empty dictionary)
  | "unknown"; // any other upstream status

interface ApiErrorOptions {
  code: ApiErrorCode;
  /** Diagnostics for the log; never shown to the agent. */
  message: string;
  /** Agent-facing specifics, appended to the code's fixed text: our own
   *  explanation (e.g. which appid wasn't found). Never upstream text. */
  detail?: string;
  status?: number;
  retryable?: boolean;
  /** Retry-After hint, in ms, for the retry backoff. */
  retryAfterMs?: number;
  /** An HTTP error whose body is a JSON object: the API method's own answer,
   *  not a page from the gateway in front of it (a route, key or edge error). */
  jsonBody?: boolean;
  /** The underlying error this one wraps (a fetch/JSON.parse failure, or the
   *  upstream ApiError a domain error explains). */
  cause?: unknown;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly detail: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly jsonBody: boolean;

  constructor(opts: ApiErrorOptions) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ApiError";
    this.code = opts.code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.detail = opts.detail;
    this.retryAfterMs = opts.retryAfterMs;
    this.jsonBody = opts.jsonBody ?? false;
  }
}

/** Map an HTTP status code to an ApiErrorCode and whether a retry may help. */
export function classifyStatus(status: number): { code: ApiErrorCode; retryable: boolean } {
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
