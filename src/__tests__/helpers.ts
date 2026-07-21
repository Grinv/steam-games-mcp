// Shared test helpers. Not a test file (no *.test suffix) so the runner skips it.
import type { TestContext } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import assert from "node:assert/strict";
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

/** The text of a tool result's first content block. `CallToolResult.content`
 *  is typed as a union of content block kinds (text/image/audio/...), so
 *  every caller would otherwise repeat the same `as { text: string }[]` cast —
 *  one cast here instead of at each assertion site. */
export function textOf(res: unknown): string {
  const content = (res as { content?: { text?: string }[] })?.content;
  return content?.[0]?.text ?? "";
}

/** Install a fetch mock for the duration of the current test. Scoped to `t.mock`
 * (Node 20's stable node:test mocking), which auto-restores the original
 * `globalThis.fetch` when the test finishes — callers don't call anything to
 * undo it themselves. */
export function installFetch(t: TestContext, mock: FetchMock): void {
  t.mock.method(globalThis, "fetch", mock.fn);
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

/** The near-universal integration-test setup: mock fetch (if a handler is
 *  given), connect a server, and register its teardown on `t` — collapsing
 *  the installFetch + connectServer + t.after(close) triple that otherwise
 *  repeats at nearly every call site. Returns `mock` too, for the tests that
 *  assert on the upstream URL/params a tool call produced. */
export async function setupServer(
  t: TestContext,
  env: NodeJS.ProcessEnv = {},
  handler?: (url: string, init: FetchArgs[1]) => Response | Promise<Response>,
): Promise<{ client: Client; mock: FetchMock }> {
  const mock = mockFetch(handler ?? (() => jsonResponse({})));
  installFetch(t, mock);
  const { client, close } = await connectServer(env);
  t.after(close);
  return { client, mock };
}

/** Assert a tool call failed with an actionable message matching `re`. */
export function assertToolError(res: unknown, re: RegExp): void {
  assert.equal((res as { isError?: boolean }).isError, true);
  assert.match(textOf(res), re);
}
