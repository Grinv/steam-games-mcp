// Trims verbose Steam payloads down to the fields an agent needs, keeping tool
// responses token-efficient. Clients fetch + cache; all raw→agent-facing shaping
// lives here. Two upstreams: the Storefront API (store data) and the official
// Web API (player data).

function names(list: { description?: string; name?: string }[] | undefined): string[] {
  return (list ?? []).map((x) => x.description ?? x.name).filter((n): n is string => Boolean(n));
}

// Steam stores playtime in minutes; expose hours (1dp) which agents reason about.
function hours(minutes: number | undefined): number | null {
  return typeof minutes === "number" ? Math.round((minutes / 60) * 10) / 10 : null;
}

// Strip HTML tags from store descriptions / requirements blobs.
function stripHtml(s: string | undefined): string | null {
  if (!s) return null;
  return (
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

// ---- Storefront: appdetails -------------------------------------------------

interface PriceOverview {
  currency?: string;
  initial?: number;
  final?: number;
  discount_percent?: number;
  initial_formatted?: string;
  final_formatted?: string;
}
export interface StoreApp {
  type?: string;
  name?: string;
  steam_appid?: number;
  is_free?: boolean;
  short_description?: string;
  detailed_description?: string;
  about_the_game?: string;
  supported_languages?: string;
  header_image?: string;
  website?: string | null;
  developers?: string[];
  publishers?: string[];
  price_overview?: PriceOverview;
  platforms?: { windows?: boolean; mac?: boolean; linux?: boolean };
  metacritic?: { score?: number; url?: string };
  categories?: { id?: number; description?: string }[];
  genres?: { id?: string; description?: string }[];
  release_date?: { coming_soon?: boolean; date?: string };
  recommendations?: { total?: number };
  pc_requirements?: { minimum?: string; recommended?: string } | [];
  required_age?: number | string;
  dlc?: number[];
  achievements?: { total?: number; highlighted?: { name?: string; path?: string }[] };
  controller_support?: string;
  content_descriptors?: { ids?: number[]; notes?: string | null };
  fullgame?: { appid?: string; name?: string };
  demos?: { appid?: number; description?: string }[];
  drm_notice?: string;
  ext_user_account_notice?: string;
}

function price(
  p: PriceOverview | undefined,
  isFree: boolean | undefined,
): Record<string, unknown> | null {
  if (isFree) return { is_free: true };
  if (!p) return null;
  return {
    is_free: false,
    currency: p.currency ?? null,
    final: p.final_formatted ?? null,
    // Steam leaves initial_formatted empty when there's no discount.
    initial: p.initial_formatted || p.final_formatted || null,
    discount_percent: p.discount_percent ?? 0,
  };
}

function platforms(p: StoreApp["platforms"]): string[] {
  if (!p) return [];
  return Object.entries(p)
    .filter(([, on]) => on)
    .map(([os]) => os);
}

export function detailApp(a: StoreApp): Record<string, unknown> {
  const reqs = Array.isArray(a.pc_requirements) ? undefined : a.pc_requirements;
  return {
    appid: a.steam_appid,
    name: a.name,
    type: a.type ?? null,
    short_description: a.short_description || null,
    is_free: a.is_free ?? false,
    price: price(a.price_overview, a.is_free),
    release_date: a.release_date?.date || null,
    coming_soon: a.release_date?.coming_soon ?? false,
    developers: a.developers ?? [],
    publishers: a.publishers ?? [],
    genres: names(a.genres),
    categories: names(a.categories),
    platforms: platforms(a.platforms),
    metacritic: a.metacritic?.score ?? null,
    metacritic_url: a.metacritic?.url ?? null,
    recommendations: a.recommendations?.total ?? null,
    required_age: a.required_age ?? null,
    controller_support: a.controller_support ?? null,
    achievements_total: a.achievements?.total ?? null,
    // A keyless sample of named achievements; use get_game_achievements for all.
    achievements_highlighted: (a.achievements?.highlighted ?? [])
      .map((h) => h.name)
      .filter((n): n is string => Boolean(n)),
    supported_languages: stripHtml(a.supported_languages),
    dlc: a.dlc ?? [],
    demos: (a.demos ?? []).map((d) => d.appid).filter(Boolean),
    // Content descriptor ids flag mature themes (violence/nudity/etc.); notes
    // is Valve's free-text. Empty ids → no mature descriptors.
    content_descriptors: {
      ids: a.content_descriptors?.ids ?? [],
      notes: a.content_descriptors?.notes ?? null,
    },
    // Present only for DLC: the base game it belongs to.
    base_game: a.fullgame?.appid
      ? { appid: Number(a.fullgame.appid), name: a.fullgame.name ?? null }
      : null,
    drm_notice: a.drm_notice || null,
    account_notice: a.ext_user_account_notice || null,
    pc_requirements_min: stripHtml(reqs?.minimum),
    website: a.website || null,
    header_image: a.header_image || null,
    store_url: a.steam_appid ? `https://store.steampowered.com/app/${a.steam_appid}` : null,
  };
}

// ---- Storefront: storesearch ------------------------------------------------

interface SearchItem {
  type?: string;
  name?: string;
  id?: number;
  price?: { currency?: string; initial?: number; final?: number };
  tiny_image?: string;
  metascore?: string;
  platforms?: { windows?: boolean; mac?: boolean; linux?: boolean };
}
export interface SearchResponse {
  total?: number;
  items?: SearchItem[];
}

// storesearch prices are raw cents (initial/final); derive a discount + labels.
function searchPrice(p: SearchItem["price"]): Record<string, unknown> | null {
  if (!p || typeof p.final !== "number") return null;
  const discount =
    p.initial && p.final && p.initial > p.final ? Math.round((1 - p.final / p.initial) * 100) : 0;
  return {
    currency: p.currency ?? null,
    final: money(p.final, p.currency),
    initial: money(p.initial, p.currency),
    discount_percent: discount,
  };
}

export function summarizeSearch(r: SearchResponse): Record<string, unknown> {
  return {
    total: r.total ?? r.items?.length ?? 0,
    results: (r.items ?? []).map((i) => ({
      appid: i.id,
      name: i.name,
      type: i.type ?? null,
      price: searchPrice(i.price),
      metascore: i.metascore || null,
      platforms: platforms(i.platforms),
      store_url: i.id ? `https://store.steampowered.com/app/${i.id}` : null,
    })),
  };
}

// ---- Storefront: batch prices (appdetails?filters=price_overview) -----------

// appdetails keyed by appid; with the price_overview filter, `data` is either
// { price_overview } or an empty array (free / no price).
export type PriceDetailsResponse = Record<
  string,
  { success?: boolean; data?: { price_overview?: PriceOverview } | [] }
>;

// Shape a merged batch response into one row per requested appid, preserving
// order. Missing/free entries come back with is_free:true and no numbers.
export function summarizePrices(
  merged: PriceDetailsResponse,
  appids: number[],
): Record<string, unknown> {
  const prices = appids.map((id) => {
    const entry = merged[String(id)];
    const data = entry?.data;
    const po = data && !Array.isArray(data) ? data.price_overview : undefined;
    if (!entry?.success) return { appid: id, available: false };
    if (!po) return { appid: id, available: true, is_free: true };
    return {
      appid: id,
      available: true,
      is_free: false,
      currency: po.currency ?? null,
      final: po.final_formatted ?? null,
      initial: po.initial_formatted || po.final_formatted || null,
      discount_percent: po.discount_percent ?? 0,
    };
  });
  return { count: prices.length, prices };
}

// ---- Storefront: appreviews -------------------------------------------------

export interface ReviewsResponse {
  success?: number;
  query_summary?: {
    num_reviews?: number;
    review_score?: number;
    review_score_desc?: string;
    total_positive?: number;
    total_negative?: number;
    total_reviews?: number;
  };
  reviews?: {
    review?: string;
    voted_up?: boolean;
    votes_up?: number;
    timestamp_created?: number;
    author?: { playtime_forever?: number };
  }[];
}

export function summarizeReviews(r: ReviewsResponse, max = 5): Record<string, unknown> {
  const q = r.query_summary ?? {};
  return {
    summary: q.review_score_desc ?? null,
    total_reviews: q.total_reviews ?? null,
    total_positive: q.total_positive ?? null,
    total_negative: q.total_negative ?? null,
    positive_pct:
      q.total_reviews && q.total_positive
        ? Math.round((q.total_positive / q.total_reviews) * 100)
        : null,
    reviews: (r.reviews ?? []).slice(0, max).map((x) => ({
      voted_up: x.voted_up ?? null,
      votes_up: x.votes_up ?? 0,
      author_playtime_hours: hours(x.author?.playtime_forever),
      text: x.review ? (x.review.length > 600 ? x.review.slice(0, 600) + "…" : x.review) : null,
    })),
  };
}

// ---- Storefront: featuredcategories -----------------------------------------

interface FeaturedItem {
  id?: number;
  name?: string;
  discounted?: boolean;
  discount_percent?: number;
  original_price?: number;
  final_price?: number;
  currency?: string;
}
export interface FeaturedResponse {
  specials?: { items?: FeaturedItem[] };
  top_sellers?: { items?: FeaturedItem[] };
  new_releases?: { items?: FeaturedItem[] };
  coming_soon?: { items?: FeaturedItem[] };
}

function money(cents: number | undefined, currency: string | undefined): string | null {
  if (typeof cents !== "number") return null;
  const v = (cents / 100).toFixed(2);
  return currency ? `${v} ${currency}` : v;
}

function featuredItems(items: FeaturedItem[] | undefined): Record<string, unknown>[] {
  return (items ?? []).map((i) => ({
    appid: i.id,
    name: i.name,
    discounted: i.discounted ?? false,
    discount_percent: i.discount_percent ?? 0,
    original_price: money(i.original_price, i.currency),
    final_price: money(i.final_price, i.currency),
    store_url: i.id ? `https://store.steampowered.com/app/${i.id}` : null,
  }));
}

export function summarizeFeatured(r: FeaturedResponse): Record<string, unknown> {
  return {
    specials: featuredItems(r.specials?.items),
    top_sellers: featuredItems(r.top_sellers?.items),
    new_releases: featuredItems(r.new_releases?.items),
    coming_soon: featuredItems(r.coming_soon?.items),
  };
}

export function summarizeSpecials(r: FeaturedResponse): Record<string, unknown> {
  return { specials: featuredItems(r.specials?.items) };
}

// ---- Web API: player summary ------------------------------------------------

interface PlayerSummary {
  steamid?: string;
  personaname?: string;
  profileurl?: string;
  avatarfull?: string;
  personastate?: number;
  realname?: string;
  loccountrycode?: string;
  timecreated?: number;
  communityvisibilitystate?: number;
  gameextrainfo?: string;
  gameid?: string;
}
export interface PlayerSummariesResponse {
  response?: { players?: PlayerSummary[] };
}

const PERSONA_STATES = [
  "offline",
  "online",
  "busy",
  "away",
  "snooze",
  "looking to trade",
  "looking to play",
];

export function summarizePlayer(r: PlayerSummariesResponse): Record<string, unknown> {
  const p = r.response?.players?.[0];
  if (!p) return { found: false };
  return {
    found: true,
    steamid: p.steamid,
    name: p.personaname ?? null,
    real_name: p.realname || null,
    state: PERSONA_STATES[p.personastate ?? 0] ?? "offline",
    visibility: p.communityvisibilitystate === 3 ? "public" : "private",
    country: p.loccountrycode || null,
    created: p.timecreated ? new Date(p.timecreated * 1000).toISOString().slice(0, 10) : null,
    in_game: p.gameextrainfo || null,
    profile_url: p.profileurl ?? null,
    avatar: p.avatarfull ?? null,
  };
}

// ---- Web API: owned / recently played ---------------------------------------

interface OwnedGame {
  appid?: number;
  name?: string;
  playtime_forever?: number;
  playtime_2weeks?: number;
  img_icon_url?: string;
}
export interface OwnedGamesResponse {
  response?: { game_count?: number; games?: OwnedGame[] };
}

// Steam returns an empty `response: {}` (no game_count) when the profile or its
// game-details are private — distinct from a public account with 0 games.
const PRIVATE_REASON =
  "Profile or game-details are private. Ask the owner to set Steam → Privacy → " +
  "Game details = Public, or this data can't be read.";

function isPrivate(r: OwnedGamesResponse): boolean {
  return r.response?.game_count === undefined && r.response?.games === undefined;
}

// Sort by playtime desc and cap; a big library would otherwise blow the budget.
export function summarizeOwnedGames(r: OwnedGamesResponse, max = 50): Record<string, unknown> {
  if (isPrivate(r)) return { found: false, reason: PRIVATE_REASON, game_count: null, games: [] };
  const games = (r.response?.games ?? [])
    .slice()
    .sort((a, b) => (b.playtime_forever ?? 0) - (a.playtime_forever ?? 0));
  return {
    found: true,
    game_count: r.response?.game_count ?? games.length,
    returned: Math.min(games.length, max),
    games: games.slice(0, max).map((g) => ({
      appid: g.appid,
      name: g.name ?? null,
      playtime_hours: hours(g.playtime_forever),
      playtime_2weeks_hours: hours(g.playtime_2weeks),
    })),
  };
}

export function summarizeRecentlyPlayed(r: OwnedGamesResponse): Record<string, unknown> {
  if (isPrivate(r)) return { found: false, reason: PRIVATE_REASON, total: 0, games: [] };
  return {
    found: true,
    total: r.response?.game_count ?? r.response?.games?.length ?? 0,
    games: (r.response?.games ?? []).map((g) => ({
      appid: g.appid,
      name: g.name ?? null,
      playtime_2weeks_hours: hours(g.playtime_2weeks),
      playtime_hours: hours(g.playtime_forever),
    })),
  };
}

// ---- Web API: player achievements -------------------------------------------

export interface PlayerAchievementsResponse {
  playerstats?: {
    success?: boolean;
    error?: string;
    gameName?: string;
    achievements?: { apiname?: string; name?: string; achieved?: number; unlocktime?: number }[];
  };
}

export function summarizePlayerAchievements(
  r: PlayerAchievementsResponse,
): Record<string, unknown> {
  const ps = r.playerstats;
  if (!ps?.success) return { found: false, reason: ps?.error ?? "No achievement stats" };
  const all = ps.achievements ?? [];
  const unlocked = all.filter((a) => a.achieved === 1);
  return {
    found: true,
    game: ps.gameName ?? null,
    total: all.length,
    unlocked: unlocked.length,
    completion_pct: all.length ? Math.round((unlocked.length / all.length) * 100) : null,
    achievements: all.map((a) => ({
      name: a.name || a.apiname,
      achieved: a.achieved === 1,
      unlocked_at:
        a.achieved === 1 && a.unlocktime
          ? new Date(a.unlocktime * 1000).toISOString().slice(0, 10)
          : null,
    })),
  };
}

// ---- Web API: global achievement percentages --------------------------------

export interface GlobalAchievementsResponse {
  achievementpercentages?: { achievements?: { name?: string; percent?: number | string }[] };
}

export function summarizeGlobalAchievements(
  r: GlobalAchievementsResponse,
): Record<string, unknown> {
  const a = r.achievementpercentages?.achievements ?? [];
  return {
    count: a.length,
    achievements: a.map((x) => ({
      name: x.name,
      percent: typeof x.percent === "string" ? Number(x.percent) : (x.percent ?? null),
    })),
  };
}

// ---- Web API: full achievement schema (key) + global rarity merge -----------

export interface GameSchemaResponse {
  game?: {
    gameName?: string;
    availableGameStats?: {
      achievements?: {
        name?: string; // internal apiname
        displayName?: string;
        description?: string;
        hidden?: number;
        icon?: string;
      }[];
    };
  };
}

// Merge the full schema (names/descriptions/hidden) with global unlock % (keyed
// by the internal apiname), so each achievement carries how rare it is.
export function summarizeGameSchema(
  schema: GameSchemaResponse,
  global: GlobalAchievementsResponse,
): Record<string, unknown> {
  const pct = new Map<string, number>();
  for (const x of global.achievementpercentages?.achievements ?? []) {
    if (x.name != null) {
      pct.set(x.name, typeof x.percent === "string" ? Number(x.percent) : (x.percent ?? 0));
    }
  }
  const list = schema.game?.availableGameStats?.achievements ?? [];
  return {
    game: schema.game?.gameName ?? null,
    total: list.length,
    achievements: list.map((a) => {
      const p = a.name != null ? pct.get(a.name) : undefined;
      return {
        api_name: a.name,
        name: a.displayName || a.name || null,
        description: a.description || null,
        hidden: a.hidden === 1,
        global_unlock_pct: typeof p === "number" ? Math.round(p * 10) / 10 : null,
      };
    }),
  };
}

// ---- Web API: news ----------------------------------------------------------

export interface NewsResponse {
  appnews?: {
    newsitems?: {
      gid?: string;
      title?: string;
      url?: string;
      author?: string;
      contents?: string;
      feedlabel?: string;
      date?: number;
    }[];
  };
}

export function summarizeNews(r: NewsResponse): Record<string, unknown> {
  return {
    items: (r.appnews?.newsitems ?? []).map((n) => ({
      title: n.title ?? null,
      date: n.date ? new Date(n.date * 1000).toISOString().slice(0, 10) : null,
      author: n.author || null,
      feed: n.feedlabel || null,
      excerpt: stripHtml(n.contents),
      url: n.url ?? null,
    })),
  };
}

// ---- Web API: resolve vanity url --------------------------------------------

export interface VanityResponse {
  response?: { success?: number; steamid?: string; message?: string };
}

export function summarizeVanity(r: VanityResponse): Record<string, unknown> {
  const v = r.response;
  if (v?.success === 1 && v.steamid) return { found: true, steamid: v.steamid };
  return { found: false, reason: v?.message ?? "No match for that vanity name" };
}

// ---- Web API: current players (keyless) -------------------------------------

export interface CurrentPlayersResponse {
  response?: { player_count?: number; result?: number };
}

export function summarizeCurrentPlayers(
  r: CurrentPlayersResponse,
  appid: number,
): Record<string, unknown> {
  return { appid, player_count: r.response?.player_count ?? null };
}

// ---- Web API: wishlist (keyless; needs a public wishlist) -------------------

export interface WishlistResponse {
  response?: { items?: { appid?: number; priority?: number; date_added?: number }[] };
}

function isoDay(ts: number | undefined): string | null {
  return ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null;
}

// A wishlist can hold tens of thousands of items; sort by priority (1 = top of
// the list) and cap. Names aren't included — use get_game per appid for details.
export function summarizeWishlist(r: WishlistResponse, max = 100): Record<string, unknown> {
  const items = r.response?.items ?? [];
  if (items.length === 0) {
    return {
      found: false,
      reason: "Empty wishlist, or the profile/wishlist is private.",
      total: 0,
      items: [],
    };
  }
  const sorted = items.slice().sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9));
  return {
    found: true,
    total: items.length,
    returned: Math.min(items.length, max),
    items: sorted.slice(0, max).map((i) => ({
      appid: i.appid,
      priority: i.priority ?? null,
      added: isoDay(i.date_added),
    })),
  };
}

// ---- Storefront: review histogram -------------------------------------------

interface Rollup {
  date?: number;
  recommendations_up?: number;
  recommendations_down?: number;
}
export interface ReviewHistogramResponse {
  success?: number;
  results?: { rollup_type?: string; rollups?: Rollup[]; recent?: Rollup[] };
}

function rollup(x: Rollup): Record<string, unknown> {
  const up = x.recommendations_up ?? 0;
  const down = x.recommendations_down ?? 0;
  const total = up + down;
  return {
    date: isoDay(x.date),
    up,
    down,
    positive_pct: total ? Math.round((up / total) * 100) : null,
  };
}

// `rollups` is the long-term trend (monthly here); `recent` is per-day for the
// last ~30 days. Cap both so the response stays bounded.
export function summarizeReviewHistogram(r: ReviewHistogramResponse): Record<string, unknown> {
  const res = r.results ?? {};
  return {
    rollup_type: res.rollup_type ?? null,
    history: (res.rollups ?? []).slice(-24).map(rollup),
    recent: (res.recent ?? []).slice(-30).map(rollup),
  };
}

// ---- IsThereAnyDeal (deals + price history; needs an ITAD key) --------------

export interface ItadLookupResponse {
  found?: boolean;
  game?: { id?: string; slug?: string; title?: string };
}

interface ItadPrice {
  amount?: number;
  currency?: string;
}
interface ItadDeal {
  shop?: { id?: number; name?: string };
  price?: ItadPrice;
  regular?: ItadPrice;
  cut?: number;
  storeLow?: ItadPrice | null;
  historyLow?: ItadPrice | null;
  url?: string;
  expiry?: string | null;
}
interface ItadDealItem {
  id?: string;
  slug?: string;
  title?: string;
  deal?: ItadDeal;
}
export interface ItadDealsResponse {
  nextOffset?: number;
  hasMore?: boolean;
  list?: ItadDealItem[];
}

function itadMoney(p: ItadPrice | undefined): string | null {
  if (!p || typeof p.amount !== "number") return null;
  return p.currency ? `${p.amount.toFixed(2)} ${p.currency}` : p.amount.toFixed(2);
}

export function summarizeDeals(r: ItadDealsResponse): Record<string, unknown> {
  const list = r.list ?? [];
  return {
    count: list.length,
    has_more: r.hasMore ?? false,
    next_offset: r.nextOffset ?? null,
    deals: list.map((it) => {
      const d = it.deal;
      // historyLow = all-time low across ITAD's history; flag when this deal
      // matches it (i.e. a historic best price right now).
      const histLow = itadMoney(d?.historyLow ?? undefined);
      const atLow =
        typeof d?.price?.amount === "number" &&
        typeof d?.historyLow?.amount === "number" &&
        d.price.amount <= d.historyLow.amount;
      return {
        title: it.title ?? null,
        itad_id: it.id ?? null,
        cut: d?.cut ?? 0,
        price: itadMoney(d?.price),
        regular: itadMoney(d?.regular),
        historic_low: histLow,
        is_historic_low: atLow,
        shop: d?.shop?.name ?? null,
        url: d?.url ?? null,
        expiry: d?.expiry ?? null,
      };
    }),
  };
}

// ---- IsThereAnyDeal: batch current prices for a list of Steam appids ---------

export type ItadBulkLookup = Record<string, string | null>;
interface ItadPricesEntry {
  id?: string;
  deals?: ItadDeal[];
}
export type ItadPricesResponse = ItadPricesEntry[];

// One row per requested appid. `lookup` maps "app/<appid>" → ITAD id; `prices`
// is the batch games/prices result (only games with a current deal appear, so a
// missing entry means not on sale). Steam-scoped, so deals[0] is the Steam deal.
export function summarizeCurrentPrices(
  appids: number[],
  lookup: ItadBulkLookup,
  prices: ItadPricesResponse,
): Record<string, unknown> {
  const byId = new Map<string, ItadPricesEntry>();
  for (const e of prices) if (e.id) byId.set(e.id, e);
  return {
    count: appids.length,
    prices: appids.map((appid) => {
      const id = lookup[`app/${appid}`];
      if (!id) return { appid, available: false };
      const deal = byId.get(id)?.deals?.[0];
      if (!deal) return { appid, available: true, on_sale: false };
      const atLow =
        typeof deal.price?.amount === "number" &&
        typeof deal.historyLow?.amount === "number" &&
        deal.price.amount <= deal.historyLow.amount;
      return {
        appid,
        available: true,
        on_sale: (deal.cut ?? 0) > 0,
        cut: deal.cut ?? 0,
        price: itadMoney(deal.price),
        regular: itadMoney(deal.regular),
        historic_low: itadMoney(deal.historyLow ?? undefined),
        is_historic_low: atLow,
      };
    }),
  };
}

interface ItadHistoryEntry {
  timestamp?: string;
  shop?: { id?: number; name?: string };
  deal?: { price?: ItadPrice; regular?: ItadPrice; cut?: number };
}
// games/history/v2 returns a flat array of price-change entries.
export type ItadHistoryResponse = ItadHistoryEntry[];

export function summarizePriceHistory(
  r: ItadHistoryResponse,
  title: string | null,
): Record<string, unknown> {
  const entries = r ?? [];
  const point = (e: ItadHistoryEntry): Record<string, unknown> => ({
    date: e.timestamp ? e.timestamp.slice(0, 10) : null,
    cut: e.deal?.cut ?? 0,
    price: itadMoney(e.deal?.price),
    shop: e.shop?.name ?? null,
  });
  // Track the all-time-low seen in this window in a single pass.
  let lowAmount = Infinity;
  let lowEntry: ItadHistoryEntry | null = null;
  for (const e of entries) {
    const amt = e.deal?.price?.amount;
    if (typeof amt === "number" && amt < lowAmount) {
      lowAmount = amt;
      lowEntry = e;
    }
  }
  return {
    title,
    count: entries.length,
    lowest: lowEntry ? point(lowEntry) : null,
    points: entries.map(point),
  };
}

// ---- IsThereAnyDeal: game info (appid + reviews + players, needs key) --------

interface ItadReview {
  score?: number | null;
  source?: string;
  count?: number;
}
export interface ItadGameInfoResponse {
  id?: string;
  slug?: string;
  title?: string;
  type?: string;
  mature?: boolean;
  appid?: number | null;
  earlyAccess?: boolean;
  achievements?: number | boolean;
  releaseDate?: string | null;
  tags?: string[];
  developers?: { id?: number; name?: string }[];
  publishers?: { id?: number; name?: string }[];
  reviews?: ItadReview[];
  players?: { recent?: number; day?: number; week?: number; peak?: number };
  stats?: { rank?: number; waitlisted?: number; collected?: number };
}

// One ITAD call that bundles the Steam appid, review score (so deals can be
// rating-filtered without a separate Steam call), current players, tags, etc.
export function summarizeGameInfo(r: ItadGameInfoResponse): Record<string, unknown> {
  const reviews = r.reviews ?? [];
  const steam = reviews.find((x) => x.source === "Steam");
  return {
    itad_id: r.id ?? null,
    appid: r.appid ?? null,
    title: r.title ?? null,
    type: r.type ?? null,
    early_access: r.earlyAccess ?? false,
    release_date: r.releaseDate ?? null,
    steam_review:
      steam && typeof steam.score === "number"
        ? { score: steam.score, count: steam.count ?? null }
        : null,
    reviews: reviews
      .filter((x) => typeof x.score === "number")
      .map((x) => ({ source: x.source, score: x.score, count: x.count ?? null })),
    players: r.players ? { recent: r.players.recent ?? null, peak: r.players.peak ?? null } : null,
    tags: (r.tags ?? []).slice(0, 15),
    developers: (r.developers ?? []).map((d) => d.name).filter(Boolean),
    publishers: (r.publishers ?? []).map((p) => p.name).filter(Boolean),
    rank: r.stats?.rank ?? null,
  };
}
