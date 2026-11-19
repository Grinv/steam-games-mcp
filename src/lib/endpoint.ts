// What we know about one upstream endpoint, declared once — and the one place
// a client turns an upstream failure into a domain answer.
//
// Steam encodes some plain answers as HTTP errors (a private friends list is
// a 401, an appid with no achievement schema a 403) and says some things only
// in a 200's body (an empty tag dictionary). Those are facts about Steam, not
// about any one caller: an Endpoint states them once, the engine (HttpClient:
// retries, cache, stale copies) applies them in one fixed order, and `call`
// hands the client either data or a typed answer — so no client writes a
// `catch` to read Steam, and two callers of an endpoint can't disagree.
//
// Each stated fact carries `probes`: calls against live Steam that show it
// (run by scripts/check-api.ts), so a fact that stops being true is caught,
// not just remembered in a comment. An answer is backed by the situations a
// probe recorded producing its code (recorded.test.ts): a code means what it
// was seen to mean, never more.
import { ApiError } from "./errors.ts";
import type { HttpClient, RequestOptions } from "./http.ts";

export type Query = Record<string, string | number | boolean | undefined>;

/** A live call that shows one stated fact: what it returns, and why. */
export interface Probe {
  query: Query;
  /** "data", one of the endpoint's answers, or a failure code it must fail with. */
  expect: string;
  /** What this shows, for the report. */
  shows: string;
  /** Send a deliberately invalid key, to show how Steam answers one. */
  badKey?: boolean;
  /** Names the situation this probe shows. Its real response is recorded
   *  (`npm run check:api -- --record`) as `<endpoint>/<situation>`, and tests
   *  replay that recording instead of a hand-written guess at what Steam
   *  sends. Required on every probe that isn't a plain success. */
  situation?: string;
}

export interface Endpoint<T, A extends string = never> {
  /** Path under the host; `{name}` is filled from (and removed from) the query. */
  path: string;
  host: "api" | "store";
  /** True when the endpoint works without the key (it is still sent when
   *  configured): its probes run in check:api even with no key. */
  keyless: boolean;
  /** Plain answers Steam sends as HTTP errors: status → answer. Keyed by the
   *  status seen, not its code: bad_request also covers 405 and 422. */
  answers?: Partial<Record<number, A>>;
  /** Throws an ApiError when a 200's body isn't usable data for this query.
   *  Runs before caching and inside the retry, like a failed request. */
  validate?: (body: T, query: Query) => void;
  /** Without a body rule: what an absent field means here, and the evidence
   *  — Steam's own answer for "none", named by the probe situation that
   *  records it (`seen`, backed like an answer: recorded.test.ts), or a
   *  per-row unknown. Only a body rule's schema makes a field required (the
   *  response type is inferred from it); without one every field is optional,
   *  so each endpoint states one or the other (recorded.test.ts): an absence
   *  nobody decided would read as a verdict by default. */
  absent?: { means: string } & ({ seen: string } | { perRow: true });
  probes: readonly Probe[];
}

export function endpoint<T, A extends string = never>(e: Endpoint<T, A>): Endpoint<T, A> {
  return e;
}

/** Data, or — for an endpoint that declares answers — data or an answer. */
export type Answered<T, A extends string> = [A] extends [never]
  ? T
  : { data: T; answer?: undefined } | { answer: A; data?: undefined };

/** Per-call choices, about this use rather than the endpoint. A body rule
 *  isn't one: the cache is keyed by URL, so a rule must hold for every use of
 *  it — it belongs on the Endpoint. */
export interface CallOptions {
  /** Cache the response (see RequestOptions.cache). */
  cache?: boolean;
}

/**
 * Call `ep` through `http` (the client for its host), with `extraQuery`
 * (e.g. the API key) added. An upstream failure the endpoint declares as an
 * answer comes back as `{ answer }`; any other failure, a bug or the call's
 * cancellation propagates as thrown.
 */
export async function call<T, A extends string>(
  http: HttpClient,
  ep: Endpoint<T, A>,
  query: Query,
  opts: CallOptions = {},
  extraQuery: Query = {},
): Promise<Answered<T, A>> {
  const { path, rest } = fillPath(ep.path, query);
  const validate = ep.validate ? (body: unknown) => ep.validate!(body as T, query) : undefined;
  const request: RequestOptions = {
    query: { ...extraQuery, ...rest },
    cache: opts.cache,
    validate,
  };
  if (!ep.answers) return (await http.getJson<T>(path, request)) as Answered<T, A>;
  let data: T;
  try {
    data = await http.getJson<T>(path, request);
  } catch (err) {
    // Only the method's own answer (a JSON body) is one: the same status as a
    // gateway's HTML page — a retired route, a proxy, an edge block — is a
    // failure. Every recorded answer is JSON, every route/key page HTML.
    const answer =
      err instanceof ApiError && err.jsonBody && err.status !== undefined
        ? ep.answers[err.status]
        : undefined;
    if (answer === undefined) throw err;
    return { answer } as Answered<T, A>;
  }
  return { data } as Answered<T, A>;
}

function fillPath(template: string, query: Query): { path: string; rest: Query } {
  const rest = { ...query };
  const path = template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const value = rest[name];
    // Our bug, not a request for Steam to answer: never send ".../undefined".
    if (value === undefined) throw new Error(`no value for path parameter {${name}}`);
    delete rest[name];
    return encodeURIComponent(String(value));
  });
  return { path, rest };
}
