// What we know about one upstream endpoint, declared once — and the one place
// a client turns an upstream failure into a domain answer.
//
// Steam encodes some plain answers as HTTP errors (a private friends list is
// a 401, an appid with no achievement schema a 403), says some things only in
// a 200's body (an empty tag dictionary), and answers some codes ambiguously
// (that 403 is also its edge under load). Those are facts about Steam, not
// about any one caller: an Endpoint states them once, the engine (HttpClient:
// retries, cache, stale copies) applies them in one fixed order, and `call`
// hands the client either data or a typed answer — so no client writes a
// `catch` to read Steam, and two callers of an endpoint can't disagree.
//
// Each stated fact carries `probes`: calls against live Steam that show it
// (run by scripts/check-api.ts), so a fact that stops being true is caught,
// not just remembered in a comment.
import { ApiError, type ApiErrorCode } from "./errors.ts";
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
}

export interface Endpoint<T, A extends string = never> {
  /** Path under the host; `{name}` is filled from (and removed from) the query. */
  path: string;
  host: "api" | "store";
  /** True when the endpoint works without the key: a 401/403 there is never
   *  the key's fault (the key is still sent when configured). */
  keyless: boolean;
  /** Plain answers Steam sends as HTTP errors: code → answer. */
  answers?: Partial<Record<ApiErrorCode, A>>;
  /** Codes that are also a passing failure here: a cached copy wins over
   *  them; with none cached, they read as their answer. */
  ambiguous?: readonly ApiErrorCode[];
  /** Throws an ApiError when a 200's body isn't usable data for this query.
   *  Runs before caching and inside the retry, like a failed request. */
  validate?: (body: T, query: Query) => void;
  probes: readonly Probe[];
}

export function endpoint<T, A extends string = never>(e: Endpoint<T, A>): Endpoint<T, A> {
  return e;
}

/** Data, or — for an endpoint that declares answers — data or an answer. */
export type Answered<T, A extends string> = [A] extends [never]
  ? T
  : { data: T; answer?: undefined } | { answer: A; data?: undefined };

/** Per-call choices, about this use rather than the endpoint. */
export interface CallOptions {
  /** Cache the response (see RequestOptions.cache). */
  cache?: boolean;
  /** A body check specific to this use, after the endpoint's own. */
  validate?: (body: unknown) => void;
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
  const validate =
    ep.validate || opts.validate
      ? (body: unknown) => {
          ep.validate?.(body as T, query);
          opts.validate?.(body);
        }
      : undefined;
  const request: RequestOptions = {
    query: { ...extraQuery, ...rest },
    cache: opts.cache,
    staleOn: ep.ambiguous,
    validate,
    ...(ep.keyless ? { hasCredentials: false } : {}),
  };
  if (!ep.answers) return (await http.getJson<T>(path, request)) as Answered<T, A>;
  let data: T;
  try {
    data = await http.getJson<T>(path, request);
  } catch (err) {
    const answer = err instanceof ApiError ? ep.answers[err.code] : undefined;
    if (answer === undefined) throw err;
    return { answer } as Answered<T, A>;
  }
  return { data } as Answered<T, A>;
}

function fillPath(template: string, query: Query): { path: string; rest: Query } {
  const rest = { ...query };
  const path = template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const value = rest[name];
    delete rest[name];
    return encodeURIComponent(String(value));
  });
  return { path, rest };
}
