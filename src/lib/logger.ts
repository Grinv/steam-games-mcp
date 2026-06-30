// Minimal leveled logger. Always writes to stderr (stdout is reserved for the
// MCP stdio protocol); an optional sink can mirror each line onto a second
// channel (e.g. MCP `notifications/message`). All messages are redacted of
// credentials before either channel sees them.
import { redact } from "./errors.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

/** A secondary log destination. Receives the level and the already-redacted
 *  message, gated by the same threshold as stderr. Must never throw. */
export type LogSink = (level: Exclude<LogLevel, "silent">, message: string) => void;

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

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
