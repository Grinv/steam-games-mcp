// Guided MCP prompts for common Steam questions. Each prompt is a message
// template that tells the calling agent which already-registered tools to call,
// in what order, and how to present the result — no new client/format code, all
// orchestration lives in the prompt text.
import { z } from "zod";
import { completable, type McpServer } from "@modelcontextprotocol/server";
import type { StorefrontClient } from "../clients/storefront.js";

// How many title matches to offer as completions — a client's prompt-argument
// UI shows these live as the user types; keep it short and fast.
const COMPLETION_LIMIT = 8;

function promptResult(description: string, text: string) {
  return {
    description,
    messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
  };
}

export function registerPrompts(server: McpServer, store: StorefrontClient): void {
  server.registerPrompt(
    "what_should_i_play",
    {
      title: "What should I play next?",
      description:
        "Recommend games from the Steam catalog based on a player's library and taste, excluding what they already own.",
      argsSchema: z.object({
        steamid: z
          .string()
          .describe(
            "SteamID64 whose library to base taste on. Omit to use the configured STEAM_ID.",
          )
          .optional(),
        budget: z
          .string()
          .describe("Max price, e.g. '$20' or 'free'. Omit for no limit.")
          .optional(),
        tags: z
          .string()
          .describe(
            "Comma-separated tags to steer toward, e.g. 'Roguelike, Deckbuilding'. Omit to infer from the library.",
          )
          .optional(),
      }),
    },
    ({ steamid, budget, tags }) =>
      promptResult(
        "Recommend games based on library/taste",
        "Recommend what I should play next.\n\n" +
          (tags
            ? `1. Call discover_games with tags: ${tags} and a good review score (min_review 80+). ` +
              `discover_games has no price filter${budget ? `, so drop any result priced above ${budget} yourself from the results` : ""}.\n` +
              "2. Call get_owned_games and drop any result I already own.\n"
            : `1. Call get_recommended_games${steamid ? ` for steamid ${steamid}` : ""}${budget ? ` and drop any result priced above ${budget}` : ""} — it infers taste from my library's playtime-weighted tags and already excludes what I own.\n`) +
          "Present 3-5 picks, each with price, review %, and a one-line reason it matches my taste.",
      ),
  );

  server.registerPrompt(
    "is_it_worth_buying",
    {
      title: "Is this game worth buying?",
      description:
        "Gather price, reviews (lifetime + recent trend) and Steam Deck compatibility for a buying verdict. game is optional — if omitted, asks which game instead of failing.",
      argsSchema: z.object({
        // Optional rather than required: not every MCP client elicits a
        // missing required prompt argument from the user (e.g. Claude Code
        // doesn't — it just fails the call), so a missing game is instead
        // handled in the prompt text below, universally across clients.
        game: completable(
          z
            .string()
            .describe(
              "Game title or Steam appid. Start typing for live title suggestions. Omit to be asked which game you mean.",
            ),
          async (value) => {
            // Best-effort: a completion list is a nice-to-have, so a transient
            // upstream failure degrades to no suggestions instead of an error
            // surfacing in the client's live-typing UI.
            try {
              const r = await store.searchGames(value);
              const results = r.results as { name?: string }[] | undefined;
              return (results ?? [])
                .map((g) => g.name)
                .filter((n): n is string => Boolean(n))
                .slice(0, COMPLETION_LIMIT);
            } catch {
              return [];
            }
          },
        ).optional(),
      }),
    },
    ({ game }) =>
      promptResult(
        "Buying verdict for a game",
        game
          ? `Should I buy "${game}"?\n\n` +
              `1. Call get_game with name "${game}" (or its appid, if that's what was given) for price, discount and platforms.\n` +
              "2. Call get_game_reviews for the overall verdict and a few recent reviews.\n" +
              "3. Call get_review_histogram to see whether reception is improving or declining recently.\n" +
              "4. Call get_items for its appid to check Steam Deck/SteamOS/Machine/Frame compatibility and popular tags.\n" +
              "5. Summarize: price/discount, lifetime review % + recent trend, Deck compatibility, and a clear " +
              "buy-now / wait-for-a-deal / skip verdict with your reasoning."
          : "Ask me which game I'm considering before doing anything else — I didn't say which one.",
      ),
  );

  server.registerPrompt(
    "deals_digest",
    {
      title: "Today's deals digest",
      description: "A curated list of well-reviewed discounted games from Steam's catalog.",
      argsSchema: z.object({
        min_discount: z.string().describe("Minimum discount %, e.g. '50'. Default 50.").optional(),
        min_review: z
          .string()
          .describe("Minimum positive-review %, e.g. '85'. Default 80.")
          .optional(),
        tags: z
          .string()
          .describe("Comma-separated tags to filter by, e.g. 'Roguelike'. Omit for any genre.")
          .optional(),
      }),
    },
    ({ min_discount, min_review, tags }) =>
      promptResult(
        "Curated deals digest",
        "Give me today's best Steam deals.\n\n" +
          `Call discover_games with min_discount: ${min_discount ?? "50"}, min_review: ${min_review ?? "80"}` +
          `${tags ? `, tags: ${tags}` : ""}. Present the top results as a short digest: name, discount %, ` +
          "final price, review %, and a clickable store_url — sorted by the best combination of discount and reviews.",
      ),
  );
}
