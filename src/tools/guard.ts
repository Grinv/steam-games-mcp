// The output end of the error pipeline: run a tool body and turn any failure
// into a tool result (never thrown), so the agent receives an actionable
// message. Built once per server with its logger (see server.ts), because an
// unexpected error is logged here rather than shown to the agent.
import { staleScope } from "../lib/http.ts";
import type { Logger } from "../lib/logger.ts";
import {
  STALE_META_KEY,
  jsonResult,
  problemResult,
  toProblem,
  type ToolResult,
} from "../lib/result.ts";

export interface ToolOutput {
  /** Run a body that builds its own ToolResult; failures become problem results. */
  guard(fn: () => Promise<ToolResult>): Promise<ToolResult>;
  /** Run a formatter and wrap its result as a JSON ToolResult, guarded. */
  reply(fn: () => Promise<Record<string, unknown>>): Promise<ToolResult>;
}

export function toolOutput(logger: Logger): ToolOutput {
  async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
    const scope = { errors: [] as unknown[] };
    let result: ToolResult;
    try {
      result = await staleScope.run(scope, fn);
    } catch (err) {
      return problemResult(toProblem(err, logger));
    }
    if (scope.errors.length === 0) return result;
    for (const err of scope.errors) logger.warn("served stale cache data after:", err);
    return { ...result, _meta: { ...(result._meta ?? {}), [STALE_META_KEY]: true } };
  }
  return { guard, reply: (fn) => guard(async () => jsonResult(await fn())) };
}
