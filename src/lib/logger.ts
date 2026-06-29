// Minimal leveled logger. Writes to stderr ONLY — stdout is reserved for the
// MCP stdio protocol. All messages are redacted of credentials.
import { redact } from "./errors.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

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

export function createLogger(level: LogLevel): Logger {
  const threshold = ORDER[level];

  function emit(lvl: Exclude<LogLevel, "silent">, msg: string, args: unknown[]): void {
    if (ORDER[lvl] < threshold) return;
    const extra = args.length ? " " + redact(args.map((a) => safeString(a)).join(" ")) : "";
    console.error(`[mal-mcp] ${lvl}: ${redact(msg)}${extra}`);
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
