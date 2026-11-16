// The output end of the error pipeline: run a tool body and turn any failure
// into a tool result (never thrown), so the agent receives an actionable
// message — and turn what a successful answer had to do without into `notes`
// the model can read. Built once per server with its logger (see server.ts),
// because what's unexpected or degraded is logged here.
import type { ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CallCancelled, callScope, type CallState } from "../lib/call.ts";
import type { Logger } from "../lib/logger.ts";
import {
  STALE_META_KEY,
  jsonResult,
  ownProblem,
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

// The model reads only structuredContent (verified on Claude Code: extra
// content blocks and _meta never reach it), so a partial or stale answer is
// said there, in every tool's output — see withNotes.
const notesSchema = z
  .array(z.string())
  .optional()
  .describe(
    "Present only when part of this answer is missing or comes from an older cached copy " +
      "because Steam failed: what, and why. Read it before relying on the data — a missing " +
      "part is null/empty because it is unknown, not because Steam has none.",
  );

/** A tool's outputSchema plus the optional `notes` guard may add to any
 *  successful answer (every member of a union gets it). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rebuilt per Zod kind below
export function withNotes(schema: z.ZodType): any {
  const add = (s: z.ZodType) => (s as z.ZodObject).extend({ notes: notesSchema });
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = schema.options as z.ZodType[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return z.discriminatedUnion(schema.def.discriminator, options.map(add) as any);
  }
  if (schema instanceof z.ZodUnion) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return z.union((schema.options as z.ZodType[]).map(add) as any);
  }
  return add(schema);
}

export function toolOutput(logger: Logger): ToolOutput {
  // One sentence per gap, in the pipeline's own wording (toProblem), never an
  // error's raw message.
  function notesOf(state: CallState): string[] {
    const notes = new Set<string>();
    for (const { what, err } of state.degraded) {
      logger.warn(`partial answer, ${what} unavailable:`, err);
      notes.add(`${what} unavailable: ${toProblem(err, logger).detail}`);
    }
    for (const { err, storedAt } of state.stale) {
      logger.warn("served stale cache data after:", err);
      notes.add(
        `Part of this answer is a cached copy from ${new Date(storedAt).toISOString()}, ` +
          `because Steam failed: ${toProblem(err, logger).detail}`,
      );
    }
    return [...notes];
  }

  async function guard(fn: () => Promise<ToolResult>, ctx: CallContext): Promise<ToolResult> {
    // Every request made for this call sees its signal and records its gaps
    // here (lib/call.ts), however deep in the client it sits.
    const state: CallState = { signal: ctx.mcpReq.signal, degraded: [], stale: [] };
    let result: ToolResult;
    try {
      result = await callScope.run(state, fn);
    } catch (err) {
      // The client's own decision, not a failure: nothing to log. (The SDK
      // doesn't send a cancelled call's result anyway.)
      if (err instanceof CallCancelled || state.signal?.aborted) {
        return problemResult(ownProblem("cancelled"));
      }
      return problemResult(toProblem(err, logger));
    }
    const notes = notesOf(state);
    if (notes.length === 0 || !result.structuredContent) return result;
    const meta = state.stale.length ? { [STALE_META_KEY]: true } : {};
    const noted = jsonResult({ ...result.structuredContent, notes });
    return { ...noted, _meta: { ...(result._meta ?? {}), ...meta } };
  }
  return { guard, reply: (fn, ctx) => guard(async () => jsonResult(await fn()), ctx) };
}
