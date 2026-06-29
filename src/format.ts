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
    initial: p.initial_formatted ?? null,
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

export function summarizeSearch(r: SearchResponse): Record<string, unknown> {
  return {
    total: r.total ?? r.items?.length ?? 0,
    results: (r.items ?? []).map((i) => ({
      appid: i.id,
      name: i.name,
      type: i.type ?? null,
      metascore: i.metascore || null,
      platforms: platforms(i.platforms),
      store_url: i.id ? `https://store.steampowered.com/app/${i.id}` : null,
    })),
  };
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

// Sort by playtime desc and cap; a big library would otherwise blow the budget.
export function summarizeOwnedGames(r: OwnedGamesResponse, max = 50): Record<string, unknown> {
  const games = (r.response?.games ?? [])
    .slice()
    .sort((a, b) => (b.playtime_forever ?? 0) - (a.playtime_forever ?? 0));
  return {
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
  return {
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
