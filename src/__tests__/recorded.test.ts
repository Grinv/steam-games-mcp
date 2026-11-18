import { test } from "node:test";
import assert from "node:assert/strict";
import { Steam } from "../clients/endpoints.ts";
import { RECORDED } from "./helpers.ts";

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
