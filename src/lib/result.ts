// Helpers that build MCP tool results. Tool handlers return these objects;
// failures become { isError: true } results (never thrown) so the agent
// receives an actionable message instead of a protocol error.
import type { ApiError } from "./errors.js";

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

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Translate an upstream ApiError into a friendly, actionable tool error. */
export function apiErrorToResult(err: ApiError): ToolResult {
  return errorResult(messageFor(err));
}

/** Translate an upstream ApiError into a friendly, actionable message. Exported
 *  (not just used via apiErrorToResult) so callers that embed an upstream
 *  failure into a structured sub-field — e.g. find_friends_who_own's
 *  `unavailable_friends[].reason` — can reuse the same sanitized wording
 *  instead of surfacing `err.message` (which may carry raw upstream HTML/body
 *  text, per lib/http.ts's toHttpError) directly to the agent. */
export function messageFor(err: ApiError): string {
  switch (err.code) {
    case "unauthorized":
      if (err.hadCredentials === false) {
        return (
          "The upstream service rejected the request (401), but this tool sends no credentials at " +
          "all, so this isn't a credentials problem — retry, or check for an upstream outage."
        );
      }
      return (
        "The upstream service rejected the credentials (401). They may be missing or expired — " +
        "check the configured API key / token."
      );
    case "forbidden":
      if (err.hadCredentials === false) {
        return (
          "The upstream service denied access (403), but this tool sends no credentials at all, so " +
          "this isn't a credentials problem — it's more likely an unrelated upstream security block " +
          "(e.g. a request that resembles an injection attempt). Try different input."
        );
      }
      if (err.hadCredentials === true) {
        return (
          "The upstream service denied access (403). The configured credentials are likely invalid, " +
          "expired, or lack permission for this request."
        );
      }
      return (
        "The upstream service denied access (403). This can be a genuine credentials/permission " +
        "issue, but many of this server's tools call it without any credentials at all — a 403 " +
        "there is more likely an unrelated upstream security block (e.g. a request that resembles " +
        "an injection attempt). Try different input first, and only suspect the configured API key " +
        "if this tool actually requires one."
      );
    case "not_found":
      // Domain code throws `not_found` with a specific, agent-facing message
      // (e.g. "No Steam app with id 123") — folding it in here, the same way
      // `bad_request` below does, instead of discarding it for a generic
      // string that was silently swallowing that detail on every not-found.
      return `No matching resource was found (404): ${err.message}`;
    case "not_modified":
      return "The content has not changed since the last request (304).";
    case "rate_limited":
      return "Upstream rate limit hit (429). Please retry in a few seconds.";
    case "server_error":
      return "The upstream service returned an error (5xx). Please retry later.";
    case "network":
      return "Could not reach the upstream service (network error). Check connectivity and retry.";
    case "timeout":
      return "The upstream request timed out. Please retry.";
    case "bad_request":
      return `The request was rejected as invalid: ${err.message}`;
    default:
      return `Unexpected error talking to the upstream service: ${err.message}`;
  }
}
