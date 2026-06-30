import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";

test("empty strings are treated as unset (so .mcpb blanks don't override defaults)", () => {
  const c = loadConfig({ STEAM_API_KEY: "", STEAM_ID: "", STEAM_COUNTRY: "" });
  assert.equal(c.steamApiKey, undefined);
  assert.equal(c.defaultSteamId, undefined);
  assert.equal(c.country, "US"); // default applies
});

test("unsubstituted .mcpb placeholders are treated as unset", () => {
  // An unfilled optional field arrives as the literal "${user_config.X}".
  const c = loadConfig({
    STEAM_API_KEY: "${user_config.steam_api_key}",
    STEAM_ID: "${user_config.steam_id}",
  });
  // Must NOT be taken as a real key/id (else web.configured → true → 403).
  assert.equal(c.steamApiKey, undefined);
  assert.equal(c.defaultSteamId, undefined);
});

test("real values pass through untouched", () => {
  const c = loadConfig({
    STEAM_API_KEY: "ABCDEF0123",
    STEAM_ID: "76561197960287930",
    STEAM_COUNTRY: "DE",
    STEAM_LANGUAGE: "german",
  });
  assert.equal(c.steamApiKey, "ABCDEF0123");
  assert.equal(c.defaultSteamId, "76561197960287930");
  assert.equal(c.country, "DE");
  assert.equal(c.language, "german");
});
