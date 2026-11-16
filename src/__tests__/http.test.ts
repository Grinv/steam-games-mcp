import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HttpClient, staleScope } from "../lib/http.ts";
import { ApiError } from "../lib/errors.ts";
import { silentLogger, jsonResponse, htmlResponse, mockFetch, installFetch } from "./helpers.ts";
import { USER_AGENT } from "../version.ts";

function client(
  extra: { retries?: number; timeoutMs?: number; cacheTtlMs?: number } = {},
): HttpClient {
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

// The raw body is diagnostics: it stays in `message` (the log) and never
// becomes agent-facing `detail` — Steam's error bodies are HTML pages.
test("toHttpError keeps the raw body for the log only", async (t) => {
  const mock = mockFetch(() =>
    htmlResponse("<html><body><h1>Bad Gateway</h1>edge error page</body></html>", { status: 400 }),
  );
  installFetch(t, mock);
  await assert.rejects(
    () => client().getJson("thing"),
    (err: unknown) =>
      err instanceof ApiError &&
      err.code === "bad_request" &&
      /edge error page/.test(err.message) &&
      err.detail === undefined,
  );
});

test("a 200 whose body isn't JSON is a retryable bad_response", async (t) => {
  installFetch(
    t,
    mockFetch(() => htmlResponse("<html>not json</html>", { status: 200 })),
  );
  await assert.rejects(
    () => client().getJson("thing"),
    (err: unknown) =>
      err instanceof ApiError &&
      err.code === "bad_response" &&
      err.retryable &&
      err.cause instanceof SyntaxError,
  );
});

test("Retry-After lands on the typed retryAfterMs field, not in cause", async (t) => {
  installFetch(
    t,
    mockFetch(() => jsonResponse({}, { status: 429, headers: { "retry-after": "2" } })),
  );
  await assert.rejects(
    () => client({ retries: 0 }).getJson("thing"),
    (err: unknown) =>
      err instanceof ApiError && err.retryAfterMs === 2000 && err.cause === undefined,
  );
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

  test("times out a body that stalls after the headers arrive", async (t) => {
    // Headers sent, then the body never finishes — real fetch errors the
    // body stream on abort, which this stream mimics. Before the fix the
    // timer was cleared once headers arrived, so res.text() hung forever.
    const mock = mockFetch(
      (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"a":'));
              init?.signal?.addEventListener("abort", () =>
                controller.error(new DOMException("aborted", "AbortError")),
              );
            },
          }),
          { status: 200 },
        ),
    );
    installFetch(t, mock);
    await assert.rejects(
      () => client({ retries: 0, timeoutMs: 30 }).getJson("stalled-body"),
      (err: unknown) => err instanceof ApiError && err.code === "timeout",
    );
  });
});

describe("response cache (cache: true)", () => {
  // A 1 ms TTL and a short real wait: ages are monotonic (performance.now),
  // which mocked timers don't control.
  async function warmThenExpire(c: HttpClient) {
    assert.deepEqual(await c.getJson("thing", { cache: true }), { v: 1 });
    await new Promise((r) => setTimeout(r, 5));
  }

  test("a fresh entry is served without a request, keyed by the full URL", async (t) => {
    const mock = mockFetch(() => jsonResponse({ v: 1 }));
    installFetch(t, mock);
    const c = client({ cacheTtlMs: 60_000 });
    await c.getJson("thing", { query: { a: 1 }, cache: true });
    await c.getJson("thing", { query: { a: 1 }, cache: true });
    await c.getJson("thing", { query: { a: 2 }, cache: true }); // another URL
    await c.getJson("thing", { query: { a: 1 } }); // not opted in
    assert.equal(mock.calls.length, 3);
  });

  test("a transient failure is answered with the stale copy, at once, and flagged", async (t) => {
    let fail = false;
    const mock = mockFetch(() =>
      fail ? jsonResponse({}, { status: 503 }) : jsonResponse({ v: 1 }),
    );
    installFetch(t, mock);
    const c = client({ cacheTtlMs: 1, retries: 2 });
    await warmThenExpire(c);
    fail = true;
    const scope = { errors: [] as unknown[] };
    const v = await staleScope.run(scope, () => c.getJson("thing", { cache: true }));
    assert.deepEqual(v, { v: 1 });
    // One request, not three: with a stale copy to fall back on, retrying
    // would only have delayed the same answer.
    assert.equal(mock.calls.length, 2);
    assert.equal(scope.errors.length, 1);
  });

  test("a definitive answer (4xx) is never papered over with a stale copy", async (t) => {
    let fail = false;
    installFetch(
      t,
      mockFetch(() => (fail ? jsonResponse({}, { status: 404 }) : jsonResponse({ v: 1 }))),
    );
    const c = client({ cacheTtlMs: 1 });
    await warmThenExpire(c);
    fail = true;
    await assert.rejects(
      () => c.getJson("thing", { cache: true }),
      (err: unknown) => err instanceof ApiError && err.code === "not_found",
    );
  });

  test("a code the call site declared ambiguous (staleOn) is answered with the stale copy", async (t) => {
    let fail = false;
    installFetch(
      t,
      mockFetch(() => (fail ? jsonResponse({}, { status: 403 }) : jsonResponse({ v: 1 }))),
    );
    const c = client({ cacheTtlMs: 1 });
    await warmThenExpire(c);
    fail = true;
    assert.deepEqual(await c.getJson("thing", { cache: true, staleOn: ["forbidden"] }), { v: 1 });
    await assert.rejects(() => c.getJson("thing", { cache: true })); // not declared: propagates
  });

  test("a body that isn't JSON fails like a request and is never cached", async (t) => {
    let calls = 0;
    installFetch(
      t,
      mockFetch(() => {
        calls += 1;
        return calls === 1
          ? htmlResponse("<html>garbled</html>", { status: 200 })
          : jsonResponse({ v: 1 });
      }),
    );
    const c = client({ cacheTtlMs: 60_000, retries: 0 });
    await assert.rejects(
      () => c.getJson("thing", { cache: true }),
      (err: unknown) => err instanceof ApiError && err.code === "bad_response",
    );
    assert.deepEqual(await c.getJson("thing", { cache: true }), { v: 1 });
  });

  test("concurrent callers share one request, and each falls back to the stale copy", async (t) => {
    let fail = false;
    const mock = mockFetch(() =>
      fail ? jsonResponse({}, { status: 503 }) : jsonResponse({ v: 1 }),
    );
    installFetch(t, mock);
    const c = client({ cacheTtlMs: 1 });
    await warmThenExpire(c);
    fail = true;
    const scopes = [{ errors: [] as unknown[] }, { errors: [] as unknown[] }];
    const [a, b] = await Promise.all(
      scopes.map((s) => staleScope.run(s, () => c.getJson("thing", { cache: true }))),
    );
    assert.deepEqual([a, b], [{ v: 1 }, { v: 1 }]);
    assert.equal(mock.calls.length, 2); // warm-up + one shared failing request
    // Each caller's own tool call is flagged, not just the first one's.
    assert.deepEqual(
      scopes.map((s) => s.errors.length),
      [1, 1],
    );
  });
});
