# Architecture notes

Background and rationale behind the hybrid Storefront + Web API design. Read
this when touching `clients/`, `format/`, or deciding whether a new upstream
deserves its own client.

## Why two clients in one server

The storefront gives credential-free game data to everyone; the Web API adds
personal/player data when a key is set. A player tool short-circuits with a
clear "set STEAM_API_KEY" message when the key is missing; the ones that read
profile-owned data add that the target profile must be public too, while
profile/ban lookups, vanity resolution and the game-achievement schema do not
(see `PUBLIC_PROFILE_NOTE` in tools/webShared.ts). Keeping both in one server lets, e.g., a library lookup
and store details compose without the agent threading ids between servers.

## Keyless caveat

Valve states _all_ Web API use requires a key
(https://steamcommunity.com/dev), but several endpoints answer without one and
we rely on that: `GetNewsForApp`, `GetGlobalAchievementPercentagesForApp`,
`GetNumberOfCurrentPlayers`, `IWishlistService/GetWishlist`,
`IStoreService/GetGamesFollowed`(+`Count`), the charts services
(`IStoreTopSellersService/GetWeeklyTopSellers`, `ISteamChartsService/GetMostPlayedGames`,
`GetMostPlayedSteamDeckGames` and `GetGamesByConcurrentPlayers`), the store-browse services
(`IStoreBrowseService/GetItems`, `IStoreQueryService/Query` and `SearchSuggestions`), tag-name
resolution (`IStoreService/GetTagList`), and the enriched wishlist
(`IWishlistService/GetWishlistSortedFiltered`). These tools are exposed
without the key gate; the key is still sent when present.

A vanity `STEAM_ID` would otherwise undo that for `get_wishlist` and
`get_followed_games`, since `ISteamUser/ResolveVanityURL` does need a key: they
work keyless for a numeric SteamID64, then fail on resolving the name. So
`requireSteamId` falls back to `steamcommunity.com/id/<vanity>/?xml=1`, whose
`<steamID64>` element needs no key — also used as a backstop when a keyed
attempt fails, so a mistyped key can't take the keyless tools down with it. That
community page is the only non-API host this server talks to, and only for this.

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

## Where prices come from

Not from the Storefront API, even in the Storefront-backed tools. Both
`appdetails`' `price_overview` and `storesearch`' `price` (which `search_games`
no longer reads — it uses `IStoreQueryService/SearchSuggestions`, whose store
items carry purchase options directly) are filled from the
**first sub of an app's default package group** rather than from its base game,
so an app whose first sub is an upgrade SKU is reported at the upgrade's price
with `discount_percent: 0`. Verified live on appid 3717330 (Yakuza Kiwami,
`cc=ID`): Rp 20 000 for package 1466003, the upgrade for owners of the Legacy
version, where the store page, Steam's own search page and
`IStoreBrowseService/GetItems` all say Rp 200 000 → Rp 120 000 (−40%). It isn't
"the cheapest sub" either — appid 3937550 has a cheaper Deluxe Upgrade sub yet
reports its base package, which happens to sit first there — and nothing in the
payload distinguishes the two: both subs carry `percent_savings: 0` and the real
discount survives only as HTML inside `option_text`.

So `StorefrontClient` takes a `PurchasePriceSource` (satisfied by
`StoreServiceClient`) and overlays `best_purchase_option`'s amounts onto the
prices it reports. This is the one place the two clients are wired together, and
it's why `server.ts` builds the Web API client first. The `currency` code still
comes from the Storefront row, since GetItems returns none.

`best_purchase_option` is **not** a drop-in authority, though: Valve's "best" is
whatever it considers the best value, routinely a bundle containing this app
_and another game_. Measured over Steam's top 500 US sellers, 421 of which are
priced: 5 report a bundle price (appid 2186680, Warhammer 40,000: Rogue Trader,
is $49.99 as package 782856 but $48.36 as bundle 67187 "The Darkest Grimdark
Bundle"), against 2 where the Storefront price is the wrong one. Trusting it
blindly would therefore trade a rare wrong answer for a commoner one, so the
overlay applies only when the option names a `packageid` and GetItems doesn't
call the app free — see `isOwnPackage()` and `summarizePurchasePrices()`. Over
that same sample the rule changes 2 prices out of 415 overlaid: appid 518790
(theHunter: Call of the Wild) stops reading as **Free** when it costs $19.99,
and appid 1675200 (Steam Deck) reports the 512 GB OLED model instead of the
cheapest listed SKU — for hardware and multi-edition apps neither source names
"the" price, and this at least agrees with what `get_items` reports.

That first case is why an override also outranks `appdetails`' `is_free` flag,
which the trap corrupts too: theHunter's default group opens with a free upgrade
for Classic owners, so appdetails reports the whole app as free. GetItems' own
`is_free` is the trustworthy one — a genuinely free app either exposes no
purchase option (Dota 2) or prices it at $0.00 and flags itself free (appid
2019300, Dokimon Quest) — so skipping those keeps "an override exists" meaning
"GetItems prices this as a paid package of its own".

The overlay is best-effort throughout: a failed or malformed lookup leaves the
Storefront number in place rather than failing the tool, and a row Steam prices
at nothing (free, unreleased, not sold in that country) is left alone instead of
being given a package price the store isn't offering.

A game's price is what the game costs on its own, so the same rule applies to
the card tools (`get_items`, `discover_games`, the detailed wishlist,
recommendations), which read the service directly. Every card request therefore
asks for `include_all_purchase_options` and `ownPurchaseOption()` prefers the
app's own package over whatever Steam called best. Asked up front rather than
fetched in a follow-up for the ~~1% of apps that need it, because measured
interleaved, the follow-up round-trip costs about what the bigger payload does
(~~+40 ms on a 50-app batch, inside run-to-run noise; ~+300 ms on a 200-entry
catalog page) — so the cheaper design is the one without a second request to
fail. An app with no own package keeps the bundle price: a null price there would
read as "not sold in this country".

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
