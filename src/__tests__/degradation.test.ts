import { test } from "node:test";
import assert from "node:assert/strict";
import { RECORDED, jsonResponse, setupServer } from "./helpers.ts";
import { ENV, router } from "./steamFixtures.ts";

// The invariant behind lib/call.ts's optional() and tools/guard.ts's notes,
// checked for every tool against every Steam endpoint it calls — so a new
// tool or a new request is covered without a test of its own. When any one
// request fails transiently — a 503, or a 200 with a body that isn't usable
// JSON — the answer is either a tool error, or a success whose `notes` say
// what's missing. Never a silent success (a gap the model
// can't see), never found:false (a transient failure says nothing about
// whether the thing exists), never an internal error.
//
// Live testing can't make one specific sub-request fail on cue; this is the
// check for that whole class (AGENTS.md: partial-failure resilience).

// Arguments for a tool, from its own inputSchema: every required field, plus
// the appid/steamid most tools key on (both optional on some).
const BY_NAME: Record<string, unknown> = {
  appid: 620,
  appids: [620],
  steamid: "76561197960287930",
  other_steamid: "76561197960287931",
  term: "portal",
  vanity: "gabe",
  name: "portal",
};
function argsFor(schema: {
  properties?: Record<string, { type?: string; enum?: unknown[] }>;
  required?: string[];
}): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (!schema.required?.includes(key) && key !== "appid" && key !== "steamid") continue;
    if (key in BY_NAME) args[key] = BY_NAME[key];
    else if (prop.enum) args[key] = prop.enum[0];
    else if (prop.type === "integer" || prop.type === "number") args[key] = 1;
    else if (prop.type === "array") args[key] = [620];
    else if (prop.type === "boolean") args[key] = false;
    else args[key] = "x";
  }
  return args;
}

// The Steam endpoint a request goes to: "IService/Method", or the store path.
const endpointOf = (url: string) =>
  (/\/(I[A-Za-z]+\/[A-Za-z]+)\/v\d/.exec(url) ?? /\.com\/(api\/[a-z]+|[a-z]+)/.exec(url))?.[1];

const FAULTS: [string, () => Response][] = [
  ["503", () => new Response("{}", { status: 503 })],
  ["200 with an empty body", () => new Response("", { status: 200 })],
];

type Result = {
  isError?: boolean;
  content: { text: string }[];
  structuredContent?: { found?: boolean; notes?: string[] };
};

test("a transient failure of any one Steam request is a tool error or a noted gap, never silent", async (t) => {
  const { client: lister } = await setupServer(t, ENV, router);
  const { tools } = await lister.listTools();
  const silent: string[] = [];
  let checked = 0;
  for (const tool of tools) {
    const args = argsFor(tool.inputSchema as Parameters<typeof argsFor>[0]);
    // Which endpoints this call reaches when everything works (a fresh server
    // each time, so nothing is answered from another call's cache).
    const clean = await setupServer(t, ENV, router);
    const ok = (await clean.client.callTool({ name: tool.name, arguments: args })) as Result;
    assert.equal(ok.isError, undefined, `${tool.name} should succeed against router`);
    const endpoints = new Set(clean.mock.calls.map((c) => endpointOf(c.url)).filter(Boolean));
    assert.ok(endpoints.size > 0, `${tool.name} reached no endpoint`);

    for (const endpoint of endpoints)
      for (const [fault, failure] of FAULTS) {
        const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, (url) =>
          endpointOf(url) === endpoint ? failure() : router(url),
        );
        const res = (await client.callTool({ name: tool.name, arguments: args })) as Result;
        const where = `${tool.name} with ${endpoint} answering ${fault}`;
        checked += 1;
        if (res.isError) {
          assert.doesNotMatch(res.content[0]!.text, /^Internal error/, where);
          continue;
        }
        assert.notEqual(res.structuredContent?.found, false, `${where}: found:false`);
        if (!res.structuredContent?.notes?.length) silent.push(where);
      }
  }
  assert.deepEqual(silent, [], "succeeded without telling the model what's missing");
  assert.ok(checked >= 70, `expected to cover every tool × endpoint × fault, covered ${checked}`);
});

// The class most review rounds found: a field Steam left out, read as a
// verdict ("no such app", "not available", "no price", "doesn't own"). Each
// field of each answer a tool reads is dropped in turn; the answer may stay
// the same, fail as unusable, note the gap or turn that part unknown, but not
// gain a verdict the full answer didn't give. A field whose absence is a
// verdict is one Steam was seen to leave out: the body is then a recording.
type Path = string[];
function fieldPaths(v: unknown, depth = 4, at: Path = []): Path[] {
  if (depth === 0 || typeof v !== "object" || v === null) return [];
  if (Array.isArray(v)) return v.length ? fieldPaths(v[0], depth, [...at, "[]"]) : [];
  return Object.entries(v).flatMap(([k, x]) => [
    [...at, k],
    ...fieldPaths(x, depth - 1, [...at, k]),
  ]);
}
function without(v: unknown, [head, ...rest]: Path): unknown {
  if (typeof v !== "object" || v === null) return v;
  if (Array.isArray(v)) return head === "[]" ? v.map((x) => without(x, rest)) : v;
  const o = { ...(v as Record<string, unknown>) };
  if (rest.length === 0) delete o[head!];
  else if (head! in o) o[head!] = without(o[head!], rest);
  return o;
}
// Every verdict in an answer, by what it is about (an appid or steamid).
function verdicts(r: Result): string[] {
  if (r.isError)
    return /^No matching resource was found/.test(r.content[0]!.text) ? ["not_found"] : [];
  const out: string[] = [];
  const walk = (x: unknown, id: string) => {
    if (Array.isArray(x)) for (const e of x) walk(e, id);
    else if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const here = String(o.appid ?? o.steamid ?? id);
      for (const k of ["found", "available", "priced", "owned"])
        if (o[k] === false) out.push(`${here} ${k}:false`);
      for (const v of Object.values(o)) walk(v, here);
    }
  };
  walk(r.structuredContent, "");
  return out;
}
const SEEN = new Set(
  Object.values(RECORDED)
    .filter((r) => r.status === 200 && r.contentType.includes("json"))
    .map((r) => JSON.stringify(JSON.parse(r.body))),
);

test("a field Steam leaves out never becomes a verdict the full answer didn't give", async (t) => {
  const { client: lister } = await setupServer(t, ENV, router);
  const { tools } = await lister.listTools();
  const found: string[] = [];
  let checked = 0;
  for (const tool of tools) {
    const args = argsFor(tool.inputSchema as Parameters<typeof argsFor>[0]);
    const clean = await setupServer(t, ENV, router);
    const before = new Set(
      verdicts((await clean.client.callTool({ name: tool.name, arguments: args })) as Result),
    );
    const urls = new Map<string, string>(); // endpoint → the first URL it was asked
    for (const c of clean.mock.calls) {
      const e = endpointOf(c.url);
      if (e && !urls.has(e)) urls.set(e, c.url);
    }
    for (const [endpoint, url] of urls) {
      const res = await router(url);
      if (!res.headers.get("content-type")?.includes("json")) continue;
      for (const path of fieldPaths(await res.json())) {
        const handler = async (u: string) => {
          const r = await router(u);
          if (endpointOf(u) !== endpoint) return r;
          const body = without(await r.json(), path);
          return SEEN.has(JSON.stringify(body)) ? null : jsonResponse(body);
        };
        let seen = false;
        const { client } = await setupServer(t, { ...ENV, HTTP_RETRIES: "0" }, async (u) => {
          const r = await handler(u);
          if (r === null) seen = true;
          return r ?? (await router(u));
        });
        const after = verdicts(
          (await client.callTool({ name: tool.name, arguments: args })) as Result,
        );
        checked += 1;
        if (seen) continue;
        for (const v of after)
          if (!before.has(v))
            found.push(`${tool.name}: ${endpoint} without ${path.join(".")} → ${v}`);
      }
    }
  }
  assert.deepEqual(found, [], "an absent field read as a verdict");
  assert.ok(checked >= 100, `expected every tool × endpoint × field, covered ${checked}`);
});
