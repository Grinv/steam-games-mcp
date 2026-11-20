// Minimal leveled logger. Always writes to stderr (stdout is reserved for the
// MCP stdio protocol); an optional sink can mirror each line onto a second
// channel (MCP log mirroring was removed: see src/server.ts). All messages are redacted of
// credentials before either channel sees them.
import { redact } from "./errors.ts";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

/** A secondary log destination. Receives the level and the already-redacted
 *  message, gated by the same threshold as stderr. Must never throw. */
type LogSink = (level: Exclude<LogLevel, "silent">, message: string) => void;

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export function createLogger(level: LogLevel, sink?: LogSink): Logger {
  const threshold = ORDER[level];

  function emit(lvl: Exclude<LogLevel, "silent">, msg: string, args: unknown[]): void {
    if (ORDER[lvl] < threshold) return;
    const extra = args.length ? " " + redact(args.map((a) => safeString(a)).join(" ")) : "";
    const text = `${redact(msg)}${extra}`;
    console.error(`[steam-games-mcp] ${lvl}: ${text}`);
    if (sink) {
      // The sink must never break logging (or the app); swallow anything it throws.
      try {
        sink(lvl, text);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    debug: (m, ...a) => emit("debug", m, a),
    info: (m, ...a) => emit("info", m, a),
    warn: (m, ...a) => emit("warn", m, a),
    error: (m, ...a) => emit("error", m, a),
  };
}

function safeString(value: unknown, seen = new Set<unknown>()): string {
  if (typeof value === "string") return value;
  // An error's stack (it opens with "Name: message") and its cause chain are
  // the diagnostics: internal errors are logged rather than shown to the agent
  // (lib/result.ts's toProblem), so the log is the only place they surface.
  // The joined text is still redacted by emit().
  if (value instanceof Error) {
    seen.add(value);
    const cause =
      value.cause === undefined || seen.has(value.cause)
        ? ""
        : `\ncaused by: ${safeString(value.cause, seen)}`;
    return `${value.stack ?? `${value.name}: ${value.message}`}${cause}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
