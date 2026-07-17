# Security

`steam-games-mcp` is **read-only** and talks to **Steam's own APIs only**.

## What it does and doesn't do

- **Never writes, trades, posts, launches games, or makes purchases.** Every
  tool is annotated `readOnlyHint: true`; there is no code path that sends
  anything to Steam beyond a GET request.
- **Only two hosts, both fixed at startup.** Requests go to the configured
  `STEAM_API_BASE_URL` (default `api.steampowered.com`) or
  `STEAM_STORE_BASE_URL` (default `store.steampowered.com`) — there is no tool
  parameter that lets a caller redirect a request to an arbitrary host.
- **Your key stays yours.** `STEAM_API_KEY` is read once from the environment
  at startup, sent only as a query parameter on requests to the Steam Web API,
  and never written to disk, cached, or included in a tool result. Logging
  redacts it (and any `Bearer`/OAuth-style token) before a line reaches stderr
  or the client (see `src/lib/errors.ts`'s `redact`).
- **No data kept between requests beyond a small TTL cache** (`CACHE_TTL_MS`,
  default 5 minutes) of non-personal store/catalog responses (game details,
  reviews, tag dictionary). Player-specific responses (profile, library,
  achievements, friends) are never cached.
- **Typed, validated inputs.** Every tool's parameters are a Zod schema;
  malformed input is rejected before any request is made.

## Reporting a vulnerability

Open a [GitHub issue](https://github.com/Grinv/steam-games-mcp/issues) or, for
anything sensitive, email the address on the maintainer's GitHub profile
(<https://github.com/Grinv>). Please don't file public issues for
vulnerabilities that could affect other users' Steam accounts before there's a
fix available.

Not affiliated with Valve. "Steam" is a trademark of Valve Corporation.
