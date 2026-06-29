// Shared helper: run a tool body and convert any failure into a tool result
// (never throw), so the agent receives an actionable message.
import { ApiError } from "../lib/errors.js";
import { apiErrorToResult, errorResult, type ToolResult } from "../lib/result.js";

export async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) return apiErrorToResult(err);
    return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
