// Typed errors for upstream API failures. Clients throw `ApiError`; tool
// handlers convert it into an MCP tool result (see lib/result.ts) so the
// agent gets an actionable, non-protocol error.

export type ApiErrorCode =
  | "unauthorized" // 401 — token missing/expired/invalid
  | "forbidden" // 403 — insufficient permissions/scope
  | "not_found" // 404 — no such resource
  | "not_modified" // 304 — cached content still fresh (conditional request)
  | "rate_limited" // 429 — slow down
  | "server_error" // 5xx — upstream broke
  | "network" // connection failed
  | "timeout" // request aborted by our timeout
  | "bad_request" // 400/405/422 — malformed or unsupported request
  | "unknown";

export interface ApiErrorOptions {
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
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly hadCredentials: boolean | undefined;

  constructor(opts: ApiErrorOptions) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ApiError";
    this.code = opts.code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.hadCredentials = opts.hadCredentials;
  }
}

/** Map an HTTP status code to an ApiErrorCode and whether a retry may help. */
export function classifyStatus(status: number): { code: ApiErrorCode; retryable: boolean } {
  if (status === 304) return { code: "not_modified", retryable: false };
  if (status === 401) return { code: "unauthorized", retryable: false };
  if (status === 403) return { code: "forbidden", retryable: false };
  if (status === 404) return { code: "not_found", retryable: false };
  if (status === 429) return { code: "rate_limited", retryable: true };
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
