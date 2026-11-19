# Tool errors

A failed tool call follows the MCP spec: an `isError: true` result whose text
content explains the failure to the model, so it can correct itself. The same
failure is also attached for the client application as an
[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details object in
the result's `_meta["io.github.Grinv/problem"]` — never in `structuredContent`,
which MCP reserves for data matching the tool's `outputSchema`. The shape is
shared with the sibling servers (tmdb-mcp).

```json
{
  "type": "https://github.com/Grinv/steam-games-mcp/blob/main/docs/errors.md#not_found",
  "title": "No matching resource was found",
  "detail": "No matching resource was found. No Steam app with id 99999999 in region US — either the appid doesn't exist or was removed from the store, or it isn't available in that country (try another `country`).",
  "retryable": false
}
```

- `type` — stable URI of the problem type: one of the sections below.
- `title` — fixed summary of the type.
- `detail` — this occurrence, as the model reads it (the result's text).
- `retryable` — whether trying the same call again can help.
- `upstream_status` — Steam's HTTP status, when there was one. RFC 9457's own
  `status` member (the status of _this_ HTTP response) is not used: MCP results
  have none.

The text never includes Steam's raw response body (it's an HTML page) or an
error's internal message; those go to the server log on stderr.

## Partial answers: `notes`

A successful result may still be missing a part Steam failed to provide (a
price check, achievement rarity, a Steam level, player names, game tags, one
chunk of a batch), or include an older cached copy of something Steam failed
to answer just now. Such a result carries `notes` in its structured content —
one sentence per gap, saying what and why — because that is the part of a
result the model reads. A missing part is then null or empty because it is
unknown, not because Steam has none. A result with a cached copy also carries
`_meta["io.github.Grinv/stale"]: true` for the client application.

## invalid_key

Steam rejected the configured `STEAM_API_KEY` (its page asking to verify the
`key=` parameter, sent as a 403, or a 401 on `GetOwnedGames`): the key is mistyped or revoked. Retrying won't help;
fix the key. Keyless tools are unaffected — Steam ignores a bad key there.

## unauthorized

Steam rejected the request (HTTP 401) for a reason other than a bad key (that's
`invalid_key`, whatever status Steam sends it with). A private friends list is
not this error: it's answered with `found: false`.

## forbidden

Steam denied access (HTTP 403) for a reason other than a bad key (that's
`invalid_key`): e.g. an upstream security block (a search term that resembles an
injection attempt). A private profile is not this error: player tools answer
it with `found: false`.

## not_found

No such app, profile or vanity name. `detail` names what was looked up; for
an appid in a given `country`, it may also just not be sold there.

## rate_limited

Steam is throttling requests (HTTP 429, or the 420 its store answers under
load). Retry in a few seconds.

## server_error

Steam failed (HTTP 5xx). Retry later.

## network

Steam could not be reached. Check connectivity.

## timeout

Steam did not answer within `HTTP_TIMEOUT_MS` (headers and body).

## cancelled

The client cancelled the call (MCP `notifications/cancelled`). The server
stops its outstanding Steam requests for it; a request another call is also
waiting for finishes for that call (and the cache) instead.

## bad_request

The request can't be served as given: Steam rejected it (HTTP 400/405/422),
or something it needs is missing (e.g. no `steamid` and no `STEAM_ID` default).
`detail` says what to change when that is known (a bare Steam 400 carries
none). An input Steam would misread (a SteamID64 that
names no account, a language that isn't one of Steam's names) is refused
before any call, with a validation message instead.

## bad_response

Steam answered with a success status but a body that can't be used: invalid
JSON, an empty or non-object body, or one the endpoint's own check rejects (e.g.
`get_game`'s appdetails answer without an entry for its appid, an empty tag
dictionary; in a `get_prices` batch such an entry is that row's
`available: null`, noted). Usually transient.

## unknown

Any other upstream status.

## internal

A bug in steam-games-mcp. The full error (stack and cause chain) is in the
server log on stderr; please report it.

It is a tool result with `isError`, not a JSON-RPC error. The spec lists
"server errors" among protocol errors, but also says errors that originate
from the tool SHOULD be reported inside the result so the model sees the call
failed; a bug while running a tool is the latter. The reference TypeScript SDK
resolves it the same way: a tool handler produces only tool errors (every
exception becomes `isError`).

## not_configured

The tool needs `STEAM_API_KEY`; `detail` says where to get a free key.
