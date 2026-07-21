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

  test("invalid numeric/enum env values fail clearly instead of silently coercing", () => {
    // loadConfig runs the env through a zod schema with no try/catch — an
    // invalid override should throw, not silently fall back to a default.
    assert.throws(() => loadConfig({ LOG_LEVEL: "verbose" }));
    assert.throws(() => loadConfig({ HTTP_TIMEOUT_MS: "0" })); // .positive()
    assert.throws(() => loadConfig({ HTTP_RETRIES: "-1" })); // .nonnegative()
  });
});
