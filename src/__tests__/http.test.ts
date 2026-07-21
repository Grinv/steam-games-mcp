import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HttpClient } from "../lib/http.js";
import { ApiError } from "../lib/errors.js";
import { silentLogger, jsonResponse, mockFetch, installFetch } from "./helpers.js";
import { USER_AGENT } from "../version.js";

function client(extra: { retries?: number; timeoutMs?: number } = {}): HttpClient {
  return new HttpClient({ baseUrl: "https://example.test/api", logger: silentLogger(), ...extra });
}

test("getJson parses the body and sends a User-Agent + query params", async (t) => {
  const mock = mockFetch((_url) => jsonResponse({ ok: true }));
  installFetch(t, mock);
  const res = await client().getJson<{ ok: boolean }>("thing", {
    query: { q: "frieren", limit: 5, skip: undefined },
  });
  assert.equal(res.ok, true);
  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0]!;
  assert.match(call.url, /q=frieren/);
  assert.match(call.url, /limit=5/);
  assert.ok(!call.url.includes("skip")); // undefined dropped
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers["User-Agent"], USER_AGENT);
});

describe("retry/backoff behavior", () => {
  test("does not retry a 404 and maps it to not_found", async (t) => {
    const mock = mockFetch(() => jsonResponse({ error: "nope" }, { status: 404 }));
    installFetch(t, mock);
    await assert.rejects(
      () => client({ retries: 2 }).getJson("missing"),
      (err: unknown) => err instanceof ApiError && err.code === "not_found",
    );
    assert.equal(mock.calls.length, 1);
  });

  test("retries a 5xx then succeeds", async (t) => {
    let n = 0;
    const mock = mockFetch(() => {
      n += 1;
      return n === 1 ? jsonResponse({ e: 1 }, { status: 500 }) : jsonResponse({ ok: true });
    });
    installFetch(t, mock);
    const res = await client({ retries: 1 }).getJson<{ ok: boolean }>("flaky");
    assert.equal(res.ok, true);
    assert.equal(mock.calls.length, 2);
  });

  test("gives up once retries are exhausted (exactly `retries + 1` attempts, then throws)", async (t) => {
    const mock = mockFetch(() => jsonResponse({ e: 1 }, { status: 500 }));
    installFetch(t, mock);
    await assert.rejects(
      () => client({ retries: 2 }).getJson("always-down"),
      (err: unknown) => err instanceof ApiError && err.code === "server_error",
    );
    assert.equal(mock.calls.length, 3); // the initial attempt + 2 retries, then give up
  });

  test("honors Retry-After on 429", async (t) => {
    let n = 0;
    const mock = mockFetch(() => {
      n += 1;
      return n === 1
        ? jsonResponse({}, { status: 429, headers: { "retry-after": "0" } })
        : jsonResponse({ ok: true });
    });
    installFetch(t, mock);
    const res = await client({ retries: 1 }).getJson<{ ok: boolean }>("limited");
    assert.equal(res.ok, true);
    assert.equal(mock.calls.length, 2);
  });

  test("aborts on timeout and maps to a timeout error", async (t) => {
    const mock = mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    installFetch(t, mock);
    await assert.rejects(
      () => client({ retries: 0, timeoutMs: 30 }).getJson("slow"),
      (err: unknown) => err instanceof ApiError && err.code === "timeout",
    );
  });

  test("a caller-cancelled request (external AbortSignal) is a network error, not retryable", async (t) => {
    // Distinct from our own internal timeout abort: cancelling on purpose
    // should never be retried, so `retryable` must stay false here even
    // though the same DOMException shape is involved.
    const controller = new AbortController();
    const mock = mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    installFetch(t, mock);
    const promise = client({ retries: 2 }).getJson("cancel-me", { signal: controller.signal });
    controller.abort();
    await assert.rejects(
      () => promise,
      (err: unknown) =>
        err instanceof ApiError && err.code === "network" && err.retryable === false,
    );
    assert.equal(mock.calls.length, 1); // never retried
  });
});
