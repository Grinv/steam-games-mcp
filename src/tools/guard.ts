// The output end of the error pipeline: run a tool body and turn any failure
// into a tool result (never thrown), so the agent receives an actionable
// message. Built once per server with its logger (see server.ts), because an
// unexpected error is logged here rather than shown to the agent.
import type { ServerContext } from "@modelcontextprotocol/server";
import { callScope } from "../lib/http.ts";
import type { Logger } from "../lib/logger.ts";
import {
  STALE_META_KEY,
  jsonResult,
  problemResult,
  toProblem,
  type ToolResult,
} from "../lib/result.ts";

/** What guard needs from the SDK's per-call context: the cancellation signal
 *  that fires on the client's notifications/cancelled. */
export type CallContext = Pick<ServerContext, "mcpReq">;

export interface ToolOutput {
  /** Run a body that builds its own ToolResult; failures become problem results. */
  guard(fn: () => Promise<ToolResult>, ctx: CallContext): Promise<ToolResult>;
  /** Run a formatter and wrap its result as a JSON ToolResult, guarded. */
  reply(fn: () => Promise<Record<string, unknown>>, ctx: CallContext): Promise<ToolResult>;
}

export function toolOutput(logger: Logger): ToolOutput {
  async function guard(fn: () => Promise<ToolResult>, ctx: CallContext): Promise<ToolResult> {
    // Every request made for this call sees its signal and reports its stale
    // fallbacks here (lib/http.ts), however deep in the client it sits.
    const scope = { signal: ctx.mcpReq.signal, staleErrors: [] as unknown[] };
    let result: ToolResult;
    try {
      result = await callScope.run(scope, fn);
    } catch (err) {
      return problemResult(toProblem(err, logger));
    }
    if (scope.staleErrors.length === 0) return result;
    for (const err of scope.staleErrors) logger.warn("served stale cache data after:", err);
    return { ...result, _meta: { ...(result._meta ?? {}), [STALE_META_KEY]: true } };
  }
  return { guard, reply: (fn, ctx) => guard(async () => jsonResult(await fn()), ctx) };
}
