// Helpers that build MCP tool results. Tool handlers return these objects;
// failures become { isError: true } results (never thrown) so the agent
// receives an actionable message instead of a protocol error.
import { ApiError, redact, type ApiErrorCode } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { META_PREFIX } from "../version.ts";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  // Matches the SDK's CallToolResult index signature.
  [key: string]: unknown;
}

/** Success result carrying both a text mirror and structured data.
 *
 * The text is compact (no indentation): MCP clients that don't read
 * `structuredContent` fall back to this string and feed it to the model, so
 * pretty-print whitespace would be pure token overhead. */
export function jsonResult(structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/**
 * A tool failure as an RFC 9457 problem details object. MCP has no HTTP
 * response, so RFC 9457's `status` (the status of *this* HTTP response) is
 * not used; Steam's status is the `upstream_status` extension, and
 * `retryable` tells the caller whether trying again can help. The model reads
 * `detail` as the result text; the whole object rides in `_meta`, never in
 * `structuredContent`, which MCP reserves for data matching the tool's
 * outputSchema. Same shape as the sibling servers (tmdb-mcp).
 */
export interface Problem {
  type: string;
  title: string;
  detail: string;
  retryable: boolean;
  upstream_status?: number;
}

/** `_meta` key for the Problem on an error result. */
export const PROBLEM_META_KEY = `${META_PREFIX}problem`;
/** `_meta` key flagging a result served from stale cache after an upstream failure. */
export const STALE_META_KEY = `${META_PREFIX}stale`;

// Each problem type's URI points at its section in docs/errors.md.
const TYPE_BASE = "https://github.com/Grinv/steam-games-mcp/blob/main/docs/errors.md#";

type OwnCode = "internal" | "not_configured" | "cancelled";
type ProblemCode = ApiErrorCode | OwnCode;

// One entry per problem type — a Record, so the compiler rejects a code
// without one. `title` is fixed per type (as RFC 9457 requires); toProblem
// alone composes each occurrence's `detail` from typed fields, never from an
// error's free-text message.
const PROBLEMS: Record<
  ProblemCode,
  { title: string; advice?: string | ((err: ApiError) => string) }
> = {
  invalid_key: {
    title: "Steam rejected the configured STEAM_API_KEY",
    advice:
      "Check the key, or get a new free one at https://steamcommunity.com/dev/apikey. " +
      "Retrying won't help.",
  },
  unauthorized: {
    title: "The upstream service rejected the request",
    advice: (err) =>
      err.hadCredentials === false
        ? "This tool sends no credentials at all, so this isn't a credentials problem — retry, " +
          "or check for an upstream outage."
        : "The credentials may be missing or expired — check the configured API key.",
  },
  forbidden: {
    title: "The upstream service denied access",
    advice: (err) => {
      if (err.hadCredentials === false) {
        return (
          "This tool sends no credentials at all, so this isn't a credentials problem — it's " +
          "more likely an unrelated upstream security block (e.g. a request that resembles an " +
          "injection attempt). Try different input."
        );
      }
      if (err.hadCredentials === true) {
        return (
          "The configured credentials are likely invalid, expired, or lack permission for this " +
          "request."
        );
      }
      return (
        "This can be a genuine credentials/permission issue, but many of this server's tools " +
        "call Steam without any credentials at all — a 403 there is more likely an unrelated " +
        "upstream security block (e.g. a request that resembles an injection attempt). Try " +
        "different input first, and only suspect the configured API key if this tool actually " +
        "requires one."
      );
    },
  },
  not_found: { title: "No matching resource was found" },
  rate_limited: {
    title: "The upstream service is rate-limiting requests",
    advice: "Please retry in a few seconds.",
  },
  server_error: { title: "The upstream service returned an error", advice: "Please retry later." },
  network: {
    title: "Could not reach the upstream service (network error)",
    advice: "Check connectivity and retry.",
  },
  timeout: { title: "The upstream request timed out", advice: "Please retry." },
  cancelled: { title: "The request was cancelled" },
  bad_request: { title: "The request is invalid" },
  bad_response: {
    title: "The upstream service returned an unusable response",
    advice: "Please retry later.",
  },
  unknown: { title: "Unexpected error talking to the upstream service" },
  internal: {
    title: "Internal error in steam-games-mcp",
    advice: "Details are in the server log (stderr); please report it.",
  },
  not_configured: { title: "This tool is not configured" },
};

/** Every problem type; each `type` URI's section must exist in docs/errors.md. */
export const PROBLEM_CODES = Object.keys(PROBLEMS) as ProblemCode[];

/**
 * The one place a failure becomes tool-facing text. An ApiError is described
 * by its code, status and agent-safe `detail` — never by its `message`, which
 * is diagnostics and may hold a raw response body. Anything else is a bug in
 * this server: it is logged in full (stack and cause chain) and the caller
 * gets a stable "internal error" instead of its internals.
 */
export function toProblem(err: unknown, logger: Logger): Problem {
  if (err instanceof ApiError) {
    return {
      type: TYPE_BASE + err.code,
      title: PROBLEMS[err.code].title,
      detail: problemDetail(err),
      retryable: err.retryable,
      ...(err.status ? { upstream_status: err.status } : {}),
    };
  }
  // Reported as a tool error, not a JSON-RPC one: it originates while the
  // tool runs, so the model must see the call failed (MCP's isError rule) —
  // the reference SDK's reading too. See docs/errors.md#internal.
  logger.error("internal error in a tool call:", err);
  return ownProblem("internal");
}

/** Just what happened — the code's title and Steam's status — for when the
 *  error's own reading (its detail, the advice) doesn't apply: a stale copy
 *  answered it, so it was taken as a passing failure, not Steam's verdict. */
export function problemSummary(err: ApiError): string {
  return `${PROBLEMS[err.code].title}${err.status ? ` (${err.status})` : ""}`;
}

/** An upstream failure as the one sentence the agent reads — pure (no
 *  logging), so a formatter can use it for a per-item failure inside a
 *  successful result (find_friends_who_own's unavailable_friends). */
export function problemDetail(err: ApiError): string {
  const { title, advice } = PROBLEMS[err.code];
  const status = err.status ? ` (${err.status})` : "";
  const adviceText = typeof advice === "function" ? advice(err) : advice;
  // redact(): a detail is our own text, but a credential must never reach
  // the agent even if a future change folds a request URL into one.
  return redact([`${title}${status}.`, err.detail, adviceText].filter(Boolean).join(" "));
}

/** A problem this server raises itself (no thrown error): its own `detail`,
 *  or the type's title and advice. */
export function ownProblem(code: OwnCode, detail?: string): Problem {
  const { title, advice } = PROBLEMS[code];
  return {
    type: TYPE_BASE + code,
    title,
    detail: detail ?? [`${title}.`, advice].filter(Boolean).join(" "),
    retryable: false,
  };
}

/** An isError tool result: the model reads `detail`; the Problem is `_meta`. */
export function problemResult(problem: Problem): ToolResult {
  return {
    content: [{ type: "text", text: problem.detail }],
    isError: true,
    _meta: { [PROBLEM_META_KEY]: problem },
  };
}
