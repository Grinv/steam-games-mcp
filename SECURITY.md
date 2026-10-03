# Security

`steam-games-mcp` is **read-only** and talks to **Steam's own APIs only**.

## What it does and doesn't do

- **Never writes, trades, posts, launches games, or makes purchases.** Every
  tool is annotated `readOnlyHint: true`; there is no code path that sends
  anything to Steam beyond a GET request.
- **Three Valve hosts, all fixed at startup.** Requests go to the configured
  `STEAM_API_BASE_URL` (default `api.steampowered.com`) or
  `STEAM_STORE_BASE_URL` (default `store.steampowered.com`), plus
  `steamcommunity.com` (not configurable) for one thing only: resolving a
  vanity-name `STEAM_ID` from the server config to a SteamID64 without a key.
  That request carries the vanity name and nothing else — never the API key.
  There is no tool parameter that lets a caller redirect a request to an
  arbitrary host.
- **Your key stays yours.** `STEAM_API_KEY` is read once from the environment
  at startup, sent only as a query parameter on requests to the Steam Web API,
  and never written to disk, cached, or included in a tool result. Logging
  redacts it (and any `Bearer`/OAuth-style token) before a line reaches stderr
  or the client (see `src/lib/errors.ts`'s `redact`).
- **No data is kept between requests beyond a small TTL cache** (`CACHE_TTL_MS`,
  default 5 minutes) of non-personal store/catalog responses (game details,
  review histogram, tag dictionary, the featured/specials payload, the
  top-sellers / most-played / live-players charts, `get_game`'s price
  correction, global achievement percentages and a game's achievement
  schema). Player-specific responses (profile, library,
  achievements, friends) are never cached, with two exceptions:
  `get_player_summary`'s numeric Steam level is cached for up to
  `CACHE_TTL_MS` keyed by SteamID, since it's non-sensitive and rarely
  changes; and a vanity-name `STEAM_ID` from the server config, once resolved,
  is remembered as its SteamID64 for the life of the process (it's the
  operator's own configured default, and resolving it again on every call
  would only add requests).
- **Typed, validated inputs.** Every tool's parameters are a Zod schema;
  malformed input is rejected before any request is made.

## Reporting a vulnerability

Open a [GitHub issue](https://github.com/Grinv/steam-games-mcp/issues) or, for
anything sensitive, email the address on the maintainer's GitHub profile
(<https://github.com/Grinv>). Please don't file public issues for
vulnerabilities that could affect other users' Steam accounts before there's a
fix available.

Not affiliated with Valve. "Steam" is a trademark of Valve Corporation.
