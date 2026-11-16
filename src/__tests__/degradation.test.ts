import { test } from "node:test";
import assert from "node:assert/strict";
import { setupServer } from "./helpers.ts";
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
