// Persists the MAL OAuth token state (access + rotated refresh token) so the
// silent-refresh flow survives restarts. MAL rotates the refresh token on each
// refresh, so we must write the new one back. The file is created 0600 inside
// the user's OS config directory.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "./logger.js";

export interface TokenState {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number;
}

export class TokenStore {
  readonly #path: string;
  readonly #logger: Logger;

  constructor(path: string, logger: Logger) {
    this.#path = path;
    this.#logger = logger;
  }

  get path(): string {
    return this.#path;
  }

  /** Returns persisted state, or undefined if absent/unreadable/corrupt. */
  load(): TokenState | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.#path, "utf8");
    } catch {
      return undefined; // not created yet
    }
    try {
      const parsed = JSON.parse(raw) as Partial<TokenState>;
      if (
        typeof parsed.accessToken === "string" &&
        typeof parsed.refreshToken === "string" &&
        typeof parsed.expiresAt === "number"
      ) {
        return parsed as TokenState;
      }
      this.#logger.warn(`token store at ${this.#path} is malformed; ignoring it`);
      return undefined;
    } catch {
      this.#logger.warn(`token store at ${this.#path} is not valid JSON; ignoring it`);
      return undefined;
    }
  }

  save(state: TokenState): void {
    // POSIX modes restrict access on macOS/Linux. Windows ignores them (the
    // file inherits directory ACLs) — best effort, no error there.
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    writeFileSync(this.#path, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
}

/** Default token store path, honoring MAL_TOKEN_STORE then OS conventions. */
export function defaultTokenStorePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MAL_TOKEN_STORE) return env.MAL_TOKEN_STORE;
  const base =
    platform() === "win32"
      ? (env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : (env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "mal-mcp", "tokens.json");
}
