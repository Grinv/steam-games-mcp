// Tests for the guided MCP prompts (tools/prompts.ts) — each is a message
// template, so these check registration + that args are woven into the text.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { connectServer } from "./helpers.js";
import { ENV } from "./steamFixtures.js";

describe("prompts", () => {
  test("all three prompts are listed", async (t) => {
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    assert.deepEqual(names, ["deals_digest", "is_it_worth_buying", "what_should_i_play"]);
  });

  test("what_should_i_play weaves optional args into the message", async (t) => {
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.getPrompt({
      name: "what_should_i_play",
      arguments: { budget: "$20", tags: "Roguelike, Deckbuilding" },
    });
    const text = (res.messages[0]!.content as { text: string }).text;
    assert.match(text, /Roguelike, Deckbuilding/);
    assert.match(text, /\$20/);
    assert.match(text, /discover_games/);
  });

  test("what_should_i_play defers to get_recommended_games when no tags are given", async (t) => {
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.getPrompt({
      name: "what_should_i_play",
      arguments: { steamid: "76561197960287930" },
    });
    const text = (res.messages[0]!.content as { text: string }).text;
    assert.match(text, /get_recommended_games/);
    assert.match(text, /76561197960287930/);
    assert.doesNotMatch(text, /discover_games/);
  });

  test("is_it_worth_buying weaves the game name into the message", async (t) => {
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.getPrompt({
      name: "is_it_worth_buying",
      arguments: { game: "Hollow Knight" },
    });
    const text = (res.messages[0]!.content as { text: string }).text;
    assert.match(text, /Hollow Knight/);
    assert.match(text, /get_review_histogram/);
  });

  test("is_it_worth_buying asks for the game instead of failing when it's omitted", async (t) => {
    // game is optional at the schema level (not every MCP client elicits a
    // missing required prompt argument — e.g. Claude Code just fails the
    // call), so an omitted game must degrade to asking, not erroring.
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.getPrompt({ name: "is_it_worth_buying", arguments: {} });
    const text = (res.messages[0]!.content as { text: string }).text;
    assert.match(text, /which game/i);
    assert.doesNotMatch(text, /get_game_reviews/);
  });

  test("deals_digest defaults min_discount/min_review when omitted", async (t) => {
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.getPrompt({ name: "deals_digest", arguments: {} });
    const text = (res.messages[0]!.content as { text: string }).text;
    assert.match(text, /min_discount: 50/);
    assert.match(text, /min_review: 80/);
  });
});
