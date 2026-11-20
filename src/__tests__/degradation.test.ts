import { test } from "node:test";
import assert from "node:assert/strict";
import { RECORDED, connectServer, jsonResponse, mockFetch, setupServer } from "./helpers.ts";
import { ENV, router } from "./steamFixtures.ts";
import { Steam } from "../clients/endpoints.ts";

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
// Drops `path` from every element of a list on the way, or (first) only from
// the first one: a partial loss, one row of many, is a case of its own.
function without(v: unknown, [head, ...rest]: Path, first = false): unknown {
  if (typeof v !== "object" || v === null) return v;
  if (Array.isArray(v))
    return head === "[]" ? v.map((x, i) => (first && i > 0 ? x : without(x, rest, first))) : v;
  const o = { ...(v as Record<string, unknown>) };
  if (rest.length === 0) delete o[head!];
  else if (head! in o) o[head!] = without(o[head!], rest, first);
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
// Facts a list states by membership: every entry of every list in the answer
// (a game found, a friend who owns one, a game two players share). One that
// drops out reads as "not there": a verdict too, unless the answer fails or
// notes the gap.
function positives(r: Result): string[] {
  const out: string[] = [];
  const walk = (x: unknown, at: string) => {
    if (Array.isArray(x)) {
      for (const e of x) {
        const o = e as Record<string, unknown> | null;
        const id = o && typeof o === "object" ? (o.appid ?? o.steamid) : undefined;
        if (id !== undefined) out.push(`${at}: ${String(id)}`);
        walk(e, `${at}[${String(id ?? "")}]`);
      }
    } else if (x && typeof x === "object")
      for (const [k, v] of Object.entries(x)) walk(v, at ? `${at}.${k}` : k);
  };
  walk(r.structuredContent, "");
  return out;
}

// A filter keeps only what Steam's answer shows satisfies it, and a field it
// tests that isn't there is Steam's own "none" (a protobuf default: no
// reviews, no purchase option, unsupported, unknown compat), so in a run with
// a filter an entry dropping out is the filter's answer, not a lost fact.
const FILTERS = new Set([
  "tags",
  "exclude_tags",
  "min_review",
  "min_reviews",
  "min_discount",
  "on_sale_only",
  "platform",
  "steam_deck",
  "steam_os",
  "steam_machine",
  "steam_frame",
  "released_after",
  "released_within_days",
]);

// What Steam was recorded sending: a whole body, or a list it left out (its
// "none" there, read as empty), per endpoint.
const recordedBodies = new Map<string, unknown[]>();
for (const [key, r] of Object.entries(RECORDED)) {
  if (r.status !== 200 || !r.contentType.includes("json")) continue;
  const ep = Steam[key.split("/")[0] as keyof typeof Steam];
  const base =
    ep.host === "api" ? "https://api.steampowered.com/" : "https://store.steampowered.com/";
  const e = endpointOf(base + ep.path);
  if (e) recordedBodies.set(e, [...(recordedBodies.get(e) ?? []), JSON.parse(r.body)]);
}
const SEEN = new Set([...recordedBodies.values()].flat().map((b) => JSON.stringify(b)));
const valueAt = (v: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (x, k) =>
      Array.isArray(x)
        ? k === "[]"
          ? x[0]
          : undefined
        : (x as Record<string, unknown> | undefined)?.[k],
    v,
  );
// A list Steam left out in a recorded answer whose object around it had the
// same other fields: that answer's situation, not merely the same endpoint.
const keysOf = (v: unknown, drop?: string) =>
  v && typeof v === "object"
    ? JSON.stringify(
        Object.keys(v)
          .filter((k) => k !== drop)
          .sort(),
      )
    : "";
function leftOutLike(endpoint: string, fixture: unknown, path: Path): boolean {
  if (!Array.isArray(valueAt(fixture, path))) return false;
  const parent = path.slice(0, -1);
  const own = keysOf(valueAt(fixture, parent), path.at(-1));
  return (recordedBodies.get(endpoint) ?? []).some(
    (b) =>
      valueAt(b, parent) !== undefined &&
      valueAt(b, path) === undefined &&
      keysOf(valueAt(b, parent)) === own,
  );
}

// Every optional argument is swept as a run of its own, so a verdict one
// leads to (get_game by name, check_appids' owned) is covered without a list
// to remember: its value is a known name's, else one its schema allows.
const VALUES: Record<string, unknown> = {
  ...BY_NAME,
  check_appids: [620, 400, 999],
  tags: ["Puzzle"], // in the fixture dictionary
  exclude_tags: ["Shooter"],
  country: "US",
};
// get_game takes an appid or a name, not both.
const INSTEAD: Record<string, string[]> = { name: ["appid"] };
type Prop = {
  type?: string;
  enum?: unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
};
function valueFor(key: string, p: Prop): unknown {
  if (key in VALUES) return VALUES[key];
  if (p.enum) return p.enum[0];
  if (p.format === "date") return "2025-01-06";
  if (p.type === "boolean") return true;
  if (p.type === "integer" || p.type === "number")
    return p.minimum !== undefined && p.maximum !== undefined
      ? Math.round((p.minimum + p.maximum) / 2)
      : (p.minimum ?? 0) + 1;
  return "x";
}
function runsFor(schema: { properties?: Record<string, Prop>; required?: string[] }) {
  const base = argsFor(schema);
  const variants = Object.entries(schema.properties ?? {})
    .filter(([key]) => !(key in base))
    .map(([key, p]) => {
      const args: Record<string, unknown> = { ...base, [key]: valueFor(key, p) };
      for (const other of INSTEAD[key] ?? []) delete args[other];
      return args;
    });
  return [base, ...variants];
}

test("a field Steam leaves out never becomes a verdict the full answer didn't give", async (t) => {
  const { client: lister } = await setupServer(t, ENV, router);
  const { tools } = await lister.listTools();
  const realFetch = globalThis.fetch;
  t.after(() => void (globalThis.fetch = realFetch));
  const found: string[] = [];
  let checked = 0;
  const runs = tools.flatMap((tool) =>
    runsFor(tool.inputSchema as Parameters<typeof runsFor>[0]).map((args) => ({ tool, args })),
  );
  // One fetch, swapped per run (see below), and each server closed after its call.
  async function ask(name: string, args: Record<string, unknown>, env: NodeJS.ProcessEnv) {
    const { client, close } = await connectServer(env);
    return (await client.callTool({ name, arguments: args }).finally(close)) as Result;
  }
  for (const { tool, args } of runs) {
    const clean = mockFetch(router);
    globalThis.fetch = clean.fn;
    const full = await ask(tool.name, args, ENV);
    // A run that fails before any field is dropped would check nothing.
    assert.notEqual(
      full.isError,
      true,
      `${tool.name} ${JSON.stringify(args)}: ${full.content[0]?.text}`,
    );
    const before = new Set(verdicts(full));
    const held = positives(full);
    const urls = new Map<string, string>(); // endpoint → the first URL it was asked
    for (const c of clean.calls) {
      const e = endpointOf(c.url);
      if (e && !urls.has(e)) urls.set(e, c.url);
    }
    assert.ok(urls.size > 0, `${tool.name} ${JSON.stringify(args)} reached no endpoint`);
    for (const [endpoint, url] of urls) {
      const res = await router(url);
      if (!res.headers.get("content-type")?.includes("json")) continue;
      const fixture: unknown = await res.json();
      const cases = fieldPaths(fixture).flatMap((path) => [
        { path, first: false },
        ...(path.includes("[]") ? [{ path, first: true }] : []),
      ]);
      for (const { path, first } of cases) {
        if (!first && leftOutLike(endpoint, fixture, path)) continue;
        let seen = false;
        // Swapped directly: node:test's mock keeps every call it sees (each
        // Response included), which over thousands of runs costs gigabytes.
        globalThis.fetch = mockFetch(async (u) => {
          const r = await router(u);
          if (endpointOf(u) !== endpoint) return r;
          const body = without(await r.json(), path, first);
          if (SEEN.has(JSON.stringify(body))) seen = true;
          return jsonResponse(body);
        }).fn;
        const answer = await ask(tool.name, args, { ...ENV, HTTP_RETRIES: "0" });
        const after = verdicts(answer);
        const kept = new Set(positives(answer));
        const sc = answer.structuredContent as { notes?: string[]; note?: string } | undefined;
        const explained = answer.isError || (sc?.notes?.length ?? 0) > 0 || Boolean(sc?.note);
        const filtered = Object.keys(args).some((k) => FILTERS.has(k));
        const lost =
          explained || filtered ? [] : held.filter((p) => !kept.has(p)).map((p) => `lost: ${p}`);
        checked += 1;
        if (seen) continue;
        const what = `${path.join(".")}${first ? " (first row only)" : ""}`;
        for (const v of [...after.filter((v) => !before.has(v)), ...lost])
          found.push(`${tool.name} ${JSON.stringify(args)}: ${endpoint} without ${what} → ${v}`);
      }
    }
  }
  assert.deepEqual(found, [], "an absent field read as a verdict");
  assert.ok(checked >= 100, `expected every tool × endpoint × field, covered ${checked}`);
});
