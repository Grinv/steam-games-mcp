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
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(opts: ApiErrorOptions) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ApiError";
    this.code = opts.code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
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

/** Strip anything that looks like a credential before logging. */
export function redact(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***")
    .replace(/\b(access_token|refresh_token|client_secret|client_id)=([^&\s"]+)/gi, "$1=***");
}
