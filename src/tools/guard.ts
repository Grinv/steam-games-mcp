// The output end of the error pipeline: run a tool body and turn any failure
// into a tool result (never thrown), so the agent receives an actionable
// message — and turn what a successful answer had to do without into `notes`
// the model can read. Built once per server with its logger (see server.ts),
// because what's unexpected or degraded is logged here.
import type {
  McpServer,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { CallCancelled, callScope, type CallState } from "../lib/call.ts";
import { ApiError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import {
  STALE_META_KEY,
  jsonResult,
  ownProblem,
  problemResult,
  type Problem,
  problemDetail,
  problemSummary,
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
function withNotes(schema: z.ZodType): any {
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
  // One line each: an expected Steam failure, not a bug — stacks are for
  // the internal-error path (toProblem), where they're the diagnostics.
  const line = (err: ApiError) =>
    `${err.code}${err.status ? ` ${err.status}` : ""}: ${err.message.split("\n")[0]}`;

  // One sentence per gap, in the pipeline's own wording (problemDetail), never
  // an error's raw message.
  function gapNotes(state: CallState): string[] {
    const notes: string[] = [];
    // Counted, not collapsed: two chunks missing alike ("Prices of 100
    // appids") are two gaps, and the model must know both. Grouped by what is
    // missing and why (the data), never by the sentence it renders to.
    const gaps = new Map<string, { what: string; err: ApiError; n: number }>();
    for (const { what, err } of state.degraded) {
      logger.warn(`partial answer, ${what} unavailable: ${line(err)}`);
      const key = JSON.stringify([what, err.code, err.status ?? null, err.detail ?? null]);
      const gap = gaps.get(key);
      if (gap) gap.n += 1;
      else gaps.set(key, { what, err, n: 1 });
    }
    for (const { what, err, n } of gaps.values()) {
      const gap = `${what} unavailable: ${problemDetail(err)}`;
      notes.push(n > 1 ? `${n}× ${gap}` : gap);
    }
    return notes;
  }

  function staleNotes(state: CallState): string[] {
    const notes: string[] = [];
    const staleSeen = new Set<string>();
    for (const { err, storedAt } of state.stale) {
      logger.warn(`served stale cache data after ${line(err)}`);
      // problemSummary, not the full detail: answering with a stale copy
      // means the failure was taken as passing, so its definitive reading
      // (e.g. "your language is invalid") would mislead. One sentence per
      // copy time and failure: it states the same fact for each such part.
      const key = JSON.stringify([storedAt, err.code, err.status ?? null]);
      if (staleSeen.has(key)) continue;
      staleSeen.add(key);
      notes.push(
        `Part of this answer is a cached copy from ${new Date(storedAt).toISOString()}, ` +
          `because Steam's latest answer failed: ${problemSummary(err)}.`,
      );
    }
    return notes;
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
      // doesn't send a cancelled call's result anyway.) Only CallCancelled
      // itself — every abort path raises it — so a bug that happens to land
      // alongside a cancel is still logged.
      if (err instanceof CallCancelled) return problemResult(ownProblem("cancelled"));
      if (err instanceof ApiError) {
        // The agent gets the error; the log gets it too, with the gaps met
        // on the way (their notes have no result to ride in).
        gapNotes(state);
        logger.warn(`tool call failed: ${line(err)}`);
        // An error read off a cached copy (an old "no such app") is as old as
        // that copy: said so, as on a successful answer.
        const stale = staleNotes(state);
        if (stale.length) {
          const problem = toProblem(err, logger);
          const res = problemResult({ ...problem, detail: [problem.detail, ...stale].join(" ") });
          return { ...res, _meta: { ...(res._meta ?? {}), [STALE_META_KEY]: true } };
        }
      }
      return problemResult(toProblem(err, logger));
    }
    const notes = [...gapNotes(state), ...staleNotes(state)];
    if (notes.length === 0 || !result.structuredContent) return result;
    const meta = state.stale.length ? { [STALE_META_KEY]: true } : {};
    const noted = jsonResult({ ...result.structuredContent, notes });
    return { ...noted, _meta: { ...(result._meta ?? {}), ...meta } };
  }
  return { guard, reply: (fn, ctx) => guard(async () => jsonResult(await fn()), ctx) };
}

/** A tool's validated input, as the SDK infers it from the input schema. */
type ToolInput<I extends StandardSchemaWithJSON> = Parameters<ToolCallback<I>>[0];

/** A tool's registration, minus what `tool()` wires itself. */
export interface ToolConfig<I extends z.ZodType & StandardSchemaWithJSON> {
  title: string;
  description: string;
  inputSchema: I;
  outputSchema: z.ZodType;
  annotations: ToolAnnotations;
}

/** Registers tools on `server` so every one gets the same output end: the
 *  handler just returns its structured result, and `reply` (errors, notes,
 *  the call's cancellation via ctx) and the outputSchema's `notes` are wired
 *  here, once — not repeated per tool, where one could be forgotten. `gate`
 *  answers before the handler runs (e.g. no API key configured). */
export function toolRegistrar(server: McpServer, out: ToolOutput) {
  return function tool<I extends z.ZodType & StandardSchemaWithJSON>(
    name: string,
    config: ToolConfig<I>,
    handler: (input: ToolInput<I>) => Promise<Record<string, unknown>>,
    opts: { gate?: () => Problem | undefined } = {},
  ): void {
    // The SDK's callback type is conditional on the schema, which TypeScript
    // can't resolve for a generic one; callers stay fully typed through
    // ToolInput<I>, so the bridge is this one cast.
    const callback = ((input: ToolInput<I>, ctx: ServerContext) => {
      const blocked = opts.gate?.();
      if (blocked) return Promise.resolve(problemResult(blocked));
      return out.reply(() => handler(input), ctx);
    }) as unknown as ToolCallback<I>;
    server.registerTool(
      name,
      { ...config, outputSchema: withNotes(config.outputSchema) },
      callback,
    );
  };
}
