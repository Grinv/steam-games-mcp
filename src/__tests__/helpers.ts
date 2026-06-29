// Shared test helpers. Not a test file (no *.test suffix) so the runner skips it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLogger, type Logger } from "../lib/logger.js";
import { buildServer } from "../server.js";
import { loadConfig } from "../config.js";

export function silentLogger(): Logger {
  return createLogger("silent");
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

type FetchArgs = Parameters<typeof fetch>;

export interface FetchMock {
  fn: typeof fetch;
  calls: { url: string; init: FetchArgs[1] }[];
}

/** Build a fetch mock from a handler, recording every call. */
export function mockFetch(
  handler: (url: string, init: FetchArgs[1]) => Response | Promise<Response>,
): FetchMock {
  const calls: FetchMock["calls"] = [];
  const fn = (async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as { url: string }).url;
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** Install a fetch mock and return a restore function. */
export function installFetch(mock: FetchMock): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = mock.fn;
  return () => {
    globalThis.fetch = original;
  };
}

/** Build the server and connect an in-memory client for end-to-end tool tests. */
export async function connectServer(
  env: NodeJS.ProcessEnv = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildServer(loadConfig(env), silentLogger());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
