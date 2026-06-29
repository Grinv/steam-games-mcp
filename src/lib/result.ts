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

function messageFor(err: ApiError): string {
  switch (err.code) {
    case "unauthorized":
      return (
        "The upstream service rejected the credentials (401). They may be missing or expired — " +
        "check the configured API key / token."
      );
    case "forbidden":
      return "The upstream service denied access (403). The credentials may lack permission.";
    case "not_found":
      return "No matching resource was found (404).";
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
