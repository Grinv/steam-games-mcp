import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HttpClient } from "../lib/http.ts";
import { CallCancelled, callScope, type CallState } from "../lib/call.ts";
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

for (const [label, body] of [
  ["an empty body", ""],
  ["a JSON null", "null"],
  ["a JSON number", "42"],
] as const) {
  test(`a 200 with ${label} is a retryable bad_response, never data`, async (t) => {
    installFetch(
      t,
      mockFetch(() => new Response(body, { status: 200 })),
    );
    for (const cache of [false, true]) {
      await assert.rejects(
        () => client({ cacheTtlMs: 60_000 }).getJson("thing", { cache }),
        (err: unknown) => err instanceof ApiError && err.code === "bad_response" && err.retryable,
      );
    }
  });
}

test("an unusable body that may be a hiccup is retried like a 5xx; a definitive one isn't", async (t) => {
  let calls = 0;
  installFetch(
    t,
    mockFetch(() => {
      calls += 1;
      return calls === 1 ? new Response("<html>garbled", { status: 200 }) : jsonResponse({ v: 1 });
    }),
  );
  for (const cache of [false, true]) {
    calls = 0;
    const v = await client({ retries: 1, cacheTtlMs: 60_000 }).getJson("thing", { cache });
    assert.deepEqual(v, { v: 1 });
    assert.equal(calls, 2, `cache=${cache}: retried once`);
  }
  // A validate rejection that isn't retryable (e.g. an unrecognized language)
  // is the answer: one request, no retry.
  calls = 1; // every call from here answers { v: 1 }
  const before = calls;
  await assert.rejects(() =>
    client({ retries: 2 }).getJson("thing", {
      validate: () => {
        throw new ApiError({ code: "bad_request", message: "no" });
      },
    }),
  );
  assert.equal(calls - before, 1);
});

test("a bug inside validate propagates as itself: not a network failure, not retried, no stale copy", async (t) => {
  const mock = mockFetch(() => jsonResponse({ v: 1 }));
  installFetch(t, mock);
  const c = client({ retries: 2, cacheTtlMs: 1 });
  await c.getJson("thing", { cache: true }); // a good copy to fall back on
  await new Promise((r) => setTimeout(r, 5));
  const buggy = () => {
    throw new TypeError("summarizer bug");
  };
  for (const cache of [false, true]) {
    const before = mock.calls.length;
    await assert.rejects(
      () => c.getJson("thing", { cache, validate: buggy }),
      (err: unknown) => err instanceof TypeError,
    );
    assert.equal(mock.calls.length - before, 1, `cache=${cache}: no retry`);
  }
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
    const scope: CallState = { degraded: [], stale: [] };
    const v = await callScope.run(scope, () => c.getJson("thing", { cache: true }));
    assert.deepEqual(v, { v: 1 });
    // One request, not three: with a stale copy to fall back on, retrying
    // would only have delayed the same answer.
    assert.equal(mock.calls.length, 2);
    assert.equal(scope.stale.length, 1);
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

  test("a body the call's validate rejects is never cached over a good one", async (t) => {
    let empty = false;
    installFetch(
      t,
      mockFetch(() => jsonResponse(empty ? { tags: [] } : { tags: ["a"] })),
    );
    const c = client({ cacheTtlMs: 1 });
    const validate = (body: unknown) => {
      if ((body as { tags: string[] }).tags.length === 0)
        throw new ApiError({ code: "bad_request", message: "empty" });
    };
    await c.getJson("thing", { cache: true, validate });
    await new Promise((r) => setTimeout(r, 5));
    empty = true;
    // Not in staleOn: the rejection propagates…
    await assert.rejects(
      () => c.getJson("thing", { cache: true, validate }),
      (err: unknown) => err instanceof ApiError && err.code === "bad_request",
    );
    // …and the good body is still what's cached.
    assert.deepEqual(
      await c.getJson("thing", { cache: true, validate, staleOn: ["bad_request"] }),
      {
        tags: ["a"],
      },
    );
  });

  test("the client's classify runs before the cache decides on a stale copy", async (t) => {
    let fail = false;
    installFetch(
      t,
      mockFetch(() => (fail ? jsonResponse({}, { status: 403 }) : jsonResponse({ v: 1 }))),
    );
    const c = new HttpClient({
      baseUrl: "https://example.test/api",
      logger: silentLogger(),
      cacheTtlMs: 1,
      classify: (err) =>
        err.code === "forbidden"
          ? new ApiError({ code: "invalid_key", message: err.message })
          : err,
    });
    await c.getJson("thing", { cache: true });
    await new Promise((r) => setTimeout(r, 5));
    fail = true;
    // forbidden is declared ambiguous, but what Steam said was invalid_key.
    await assert.rejects(
      () => c.getJson("thing", { cache: true, staleOn: ["forbidden"] }),
      (err: unknown) => err instanceof ApiError && err.code === "invalid_key",
    );
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
    const scopes: CallState[] = [
      { degraded: [], stale: [] },
      { degraded: [], stale: [] },
    ];
    const [a, b] = await Promise.all(
      scopes.map((s) => callScope.run(s, () => c.getJson("thing", { cache: true }))),
    );
    assert.deepEqual([a, b], [{ v: 1 }, { v: 1 }]);
    assert.equal(mock.calls.length, 2); // warm-up + one shared failing request
    // Each caller's own tool call is flagged, not just the first one's.
    assert.deepEqual(
      scopes.map((s) => s.stale.length),
      [1, 1],
    );
  });
});

describe("cancellation (the call's signal, via callScope)", () => {
  // A fetch that never answers on its own, only fails when its signal aborts.
  function hangingFetch() {
    const seen = { aborted: false, calls: 0 };
    const mock = mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          seen.calls += 1;
          init?.signal?.addEventListener("abort", () => {
            seen.aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    return { mock, seen };
  }
  const inCall = <T>(signal: AbortSignal, fn: () => Promise<T>) =>
    callScope.run({ signal, degraded: [], stale: [] }, fn);

  test("aborts the fetch itself and fails as cancelled, not a timeout or network error", async (t) => {
    const { mock, seen } = hangingFetch();
    installFetch(t, mock);
    const ac = new AbortController();
    const pending = inCall(ac.signal, () => client({ timeoutMs: 10_000 }).getJson("thing"));
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(pending, (err: unknown) => err instanceof CallCancelled);
    assert.equal(seen.aborted, true);
    assert.equal(seen.calls, 1); // never retried
  });

  test("stops waiting out a retry backoff", async (t) => {
    const mock = mockFetch(() => jsonResponse({}, { status: 503 }));
    installFetch(t, mock);
    const ac = new AbortController();
    const start = performance.now();
    const pending = inCall(ac.signal, () => client({ retries: 2 }).getJson("thing"));
    setTimeout(() => ac.abort(), 20); // during the first ~500 ms backoff
    await assert.rejects(pending, (err: unknown) => err instanceof CallCancelled);
    assert.ok(performance.now() - start < 300, "returned as soon as the call was cancelled");
    assert.equal(mock.calls.length, 1);
  });

  test("an already-cancelled call never starts a cached request", async (t) => {
    const mock = mockFetch(() => jsonResponse({}, { status: 503 }));
    installFetch(t, mock);
    const ac = new AbortController();
    ac.abort();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    t.after(() => process.off("unhandledRejection", onUnhandled));
    await assert.rejects(
      inCall(ac.signal, () => client({ cacheTtlMs: 60_000 }).getJson("thing", { cache: true })),
      (err: unknown) => err instanceof CallCancelled,
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(unhandled, []);
  });

  test("a cancelled caller of a shared cached request only stops waiting; the others get it", async (t) => {
    let answer!: (r: Response) => void;
    const mock = mockFetch(() => new Promise<Response>((resolve) => (answer = resolve)));
    installFetch(t, mock);
    const c = client({ cacheTtlMs: 60_000 });
    const ac = new AbortController();
    const cancelledCall = inCall(ac.signal, () => c.getJson("thing", { cache: true }));
    const otherCall = inCall(new AbortController().signal, () =>
      c.getJson("thing", { cache: true }),
    );
    ac.abort();
    await assert.rejects(cancelledCall, (err: unknown) => err instanceof CallCancelled);
    answer(jsonResponse({ v: 1 }));
    assert.deepEqual(await otherCall, { v: 1 });
    assert.deepEqual(await c.getJson("thing", { cache: true }), { v: 1 }); // and it was cached
    assert.equal(mock.calls.length, 1);
  });
});
