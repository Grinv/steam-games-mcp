# Architecture notes

Background and rationale behind the hybrid Storefront + Web API design. Read
this when touching `clients/`, `format/`, or deciding whether a new upstream
deserves its own client.

## Why two clients in one server

The storefront gives credential-free game data to everyone; the Web API adds
personal/player data when a key is set. A player tool short-circuits with a
clear "set STEAM_API_KEY" message when the key is missing (the target profile
must also be public). Keeping both in one server lets, e.g., a library lookup
and store details compose without the agent threading ids between servers.

## Keyless caveat

Valve states _all_ Web API use requires a key
(https://steamcommunity.com/dev), but several endpoints answer without one and
we rely on that: `GetNewsForApp`, `GetGlobalAchievementPercentagesForApp`,
`GetNumberOfCurrentPlayers`, `IWishlistService/GetWishlist`,
`IStoreService/GetGamesFollowed`(+`Count`), the store-browse services
(`IStoreBrowseService/GetItems`, `IStoreQueryService/Query`), tag-name
resolution (`IStoreService/GetTagList`), and the enriched wishlist
(`IWishlistService/GetWishlistSortedFiltered`). These tools are exposed
without the key gate; the key is still sent when present.

## No SteamDB, no third-party deal service

Catalog-wide discovery (`discover_games` via `IStoreQueryService/Query` —
deals, recency, compat, tags, native platform) and batch store cards
(`get_items` via `IStoreBrowseService/GetItems`; tag names via
`IStoreService/GetTagList`, enriched wishlist via
`IWishlistService/GetWishlistSortedFiltered`) come from Steam's own keyless
store APIs — verified live. SteamDB has no public API and forbids scraping
(don't). **Price history is intentionally not offered**: Steam exposes no
price-history API (confirmed against the full method list), and the only
sources for it (SteamDB / IsThereAnyDeal) were deliberately dropped to keep
the server Steam-only and dependency-free.

## API references

- Steam Web API: https://developer.valvesoftware.com/wiki/Steam_Web_API (official wiki);
  the machine-readable method list is `ISteamWebAPIUtil/GetSupportedAPIList` (keyless
  = the methods usable without a key).
- Store services (`IStoreBrowseService/GetItems`, `IStoreQueryService/Query`,
  `IStoreService/GetTagList`, `IWishlistService/GetWishlistSortedFiltered`) and the
  Storefront API (`store.steampowered.com/api/*`) are **unofficial/undocumented** —
  community reference at https://github.com/Revadike/InternalSteamWebAPI/wiki. All
  field shapes were verified against the live endpoints; `check:api` re-verifies on release.

## Reuse / shared architecture

Generated from the **`mcp-server-template`** repository: a generic carcass
(`src/lib/` + build tooling, tests infra, CI) plus a thin domain layer
(`config.ts`, `format/`, `clients/`, domain `tools/`, `check-api.mjs`). When
fixing carcass bugs, consider whether the fix belongs upstream in the template.
