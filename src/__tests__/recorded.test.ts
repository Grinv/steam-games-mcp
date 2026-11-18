import { test } from "node:test";
import assert from "node:assert/strict";
import { Steam, classifySteamApiError } from "../clients/endpoints.ts";
import { ApiError } from "../lib/errors.ts";
import { call, type Endpoint } from "../lib/endpoint.ts";
import { HttpClient } from "../lib/http.ts";
import { RECORDED, installFetch, mockFetch, recorded, silentLogger } from "./helpers.ts";

// The recordings and the probes are one body of evidence: every situation a
// probe names has its real response recorded, and nothing is recorded that
// no probe shows (a recording can't outlive the fact it stood for).
const situations = Object.entries(Steam).flatMap(([name, ep]) =>
  ep.probes.map((p) => ({ name, probe: p })),
);

test("every probe that isn't a plain success names its situation", () => {
  const unnamed = situations
    .filter(({ probe }) => probe.expect !== "data" && !probe.situation)
    .map(({ name, probe }) => `${name}: ${probe.shows}`);
  assert.deepEqual(unnamed, []);
});

test("every named situation is recorded, and every recording is a named situation", () => {
  const named = situations
    .filter(({ probe }) => probe.situation)
    .map(({ name, probe }) => `${name}/${probe.situation}`)
    .sort();
  assert.deepEqual(Object.keys(RECORDED).sort(), named);
});

// What a probe expects, from the same pipeline check:api runs live, here fed
// the recorded response instead of Steam: status and body, read as the
// server reads them.
async function replay(ep: Endpoint<unknown, string>, situation: string) {
  const client = new HttpClient({
    baseUrl: "https://steam.test",
    logger: silentLogger(),
    retries: 0,
    classify: classifySteamApiError,
  });
  const probe = ep.probes.find((p) => p.situation === situation)!;
  try {
    const res = await call(client, ep, probe.query);
    return (res as { answer?: string }).answer ?? "data";
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return err.code;
  }
}

test("every recorded situation, replayed, is what its probe expects", async (t) => {
  let current = "";
  installFetch(
    t,
    mockFetch(() => recorded(current)),
  );
  const wrong: string[] = [];
  for (const { name, probe } of situations) {
    if (!probe.situation) continue;
    current = `${name}/${probe.situation}`;
    const ep = Steam[name as keyof typeof Steam] as unknown as Endpoint<unknown, string>;
    const got = await replay(ep, probe.situation);
    if (got !== probe.expect) wrong.push(`${current}: ${got}, not ${probe.expect}`);
  }
  assert.deepEqual(wrong, []);
});

test("every answer an endpoint declares is backed by a recorded situation with that status", () => {
  // A code means what it was seen to mean: an answer with no recorded
  // situation producing it (replayed above) is a belief about Steam.
  const unbacked: string[] = [];
  for (const [name, ep] of Object.entries(Steam)) {
    for (const [status, answer] of Object.entries(ep.answers ?? {})) {
      const backed = ep.probes.some((p) => {
        const r = p.situation && RECORDED[`${name}/${p.situation}`];
        return r && p.expect === answer && r.status === Number(status);
      });
      if (!backed) unbacked.push(`${name}: ${status} → ${answer}`);
    }
  }
  assert.deepEqual(unbacked, []);
});
