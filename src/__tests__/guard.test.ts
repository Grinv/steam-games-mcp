import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../lib/errors.js";
import { guard } from "../tools/guard.js";

test("guard converts an ApiError into its mapped, actionable message", async () => {
  const r = await guard(() => {
    throw new ApiError({ code: "not_found", message: "detail" });
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /no matching resource/i);
});

test("guard converts a plain Error into an 'Unexpected error: <message>' result", async () => {
  const r = await guard(() => {
    throw new Error("boom");
  });
  assert.equal(r.isError, true);
  assert.equal(r.content[0]!.text, "Unexpected error: boom");
});

test("guard converts a thrown non-Error value (string/object) without crashing", async () => {
  const fromString = await guard(() => {
    throw "just a string";
  });
  assert.equal(fromString.isError, true);
  assert.equal(fromString.content[0]!.text, "Unexpected error: just a string");

  const fromObject = await guard(() => {
    throw { code: 1 };
  });
  assert.equal(fromObject.isError, true);
  assert.match(fromObject.content[0]!.text, /Unexpected error:/);
});
