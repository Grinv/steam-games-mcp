import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";

describe("loadConfig", () => {
  test("empty strings are treated as unset (so .mcpb blanks don't override defaults)", () => {
    const c = loadConfig({ STEAM_API_KEY: "", STEAM_ID: "", STEAM_COUNTRY: "" });
    assert.equal(c.steamApiKey, undefined);
    assert.equal(c.defaultSteamId, undefined);
    assert.equal(c.country, "US"); // default applies
  });

  test("a whitespace-only value is treated as unset too, not as a real key", () => {
    // Regression-shaped edge case: only "" and the ${...} placeholder were
    // being stripped — a lone space would otherwise pass min(1) and be sent
    // to Steam as if it were a real key.
    const c = loadConfig({ STEAM_API_KEY: " ", STEAM_ID: "\t" });
    assert.equal(c.steamApiKey, undefined);
    assert.equal(c.defaultSteamId, undefined);
  });

  test("surrounding quotes are stripped, not sent to Steam as part of the value", () => {
    // Shell-style quoting inside a JSON config ("STEAM_API_KEY":
    // "'${STEAM_API_KEY}'") or a pasted `export` line leaves the quotes in the
    // value; Steam then answers 401/403 for a key wrapped in them.
    const c = loadConfig({
      STEAM_API_KEY: "'abc123'",
      STEAM_ID: '"76561197960287930"',
      STEAM_COUNTRY: "'ID'",
    });
    assert.equal(c.steamApiKey, "abc123");
    assert.equal(c.defaultSteamId, "76561197960287930");
    assert.equal(c.country, "ID");
  });

  test("a QUOTED unsubstituted placeholder is unset too, not a real key", () => {
    // The quotes are what hid it from the placeholder check before, making
    // web.configured true and sending "${...}" to Steam.
    const c = loadConfig({ STEAM_API_KEY: "'${STEAM_API_KEY}'" });
    assert.equal(c.steamApiKey, undefined);
  });

  test("quotes inside a value are left alone", () => {
    // Only one matching, surrounding pair is stripped — an apostrophe in the
    // middle of a value is content, not quoting.
    const c = loadConfig({ STEAM_ID: "o'brien", STEAM_API_KEY: "'ab'cd'" });
    assert.equal(c.defaultSteamId, "o'brien");
    assert.equal(c.steamApiKey, "ab'cd");
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

  test("surrounding whitespace on a real value is trimmed, not carried through", () => {
    // Regression: resolve_vanity_url is an exact-match lookup, so a padded
    // STEAM_ID would silently resolve to "not found" instead of the real
    // profile — trim it the same way an accidentally-padded value should
    // never survive into a value Steam compares byte-for-byte.
    const c = loadConfig({
      STEAM_ID: " 76561197960287930 ",
      STEAM_API_KEY: " ABCDEF0123 ",
      STEAM_COUNTRY: " DE ",
      STEAM_LANGUAGE: " german ",
    });
    assert.equal(c.defaultSteamId, "76561197960287930");
    assert.equal(c.steamApiKey, "ABCDEF0123");
    assert.equal(c.country, "DE");
    assert.equal(c.language, "german");
  });

  test("invalid numeric/enum env values fail clearly instead of silently coercing", () => {
    // loadConfig runs the env through a zod schema with no try/catch — an
    // invalid override should throw, not silently fall back to a default.
    assert.throws(() => loadConfig({ LOG_LEVEL: "verbose" }));
    assert.throws(() => loadConfig({ HTTP_TIMEOUT_MS: "0" })); // .positive()
    assert.throws(() => loadConfig({ HTTP_RETRIES: "-1" })); // .nonnegative()
  });
});
