# MusicButler

Single-process Discord music bot for YouTube and YouTube Music playback.
Node.js + discord.js + @discordjs/voice + youtubei.js. One Docker image,
one Discord gateway session, no internal service split.

## Architecture

- **One process, one Discord.js client.** Slash command handling and voice
  playback live in the same event loop. `@discordjs/voice` needs
  `guild.voiceAdapterCreator` from this client's own gateway connection —
  that's the reason it has to stay single-process (short of proxying raw
  audio over the network, which this doesn't do).
- **Voice encryption** via `libsodium-wrappers` (pure JS, no native build
  step) — chosen so the image builds identically on Docker Desktop/WSL2 and
  on a plain Debian host.
- **Extraction** via `youtubei.js` (Innertube client) for both YouTube and
  YouTube Music. Audio-only webm/opus is piped straight through
  `prism-media`'s `WebmDemuxer` into `@discordjs/voice` as
  `StreamType.Opus` — no ffmpeg subprocess.
- **PO tokens** via a bundled `bgutil-pot` (Rust) sidecar, launched by
  `start.sh` before the Node app and health-checked over HTTP.

```
src/
  index.js            entry point: client, command registration, dispatch
  lib/
    cookies.js         cookie header / Netscape cookies.txt parsing
    potProvider.js      HTTP client for the bgutil-pot sidecar
    innertube.js         session + po_token lifecycle
    extract.js            URL parsing / search -> video ID resolution
    player.js               per-guild voice connection + playback
    queueManager.js           per-guild queue state
    commandDefs.js              slash command definitions
  commands/               one file per command
```

## Environment variables

| Variable | Required | Default | Unit | Function |
|---|:---:|---|---|---|
| `DISCORD_TOKEN` | yes | — | string (token) | Gateway auth token passed to `client.login()`. Checked at boot (`index.js`); missing or empty exits the process before the client is even constructed. |
| `YOUTUBE_COOKIES_BASE64` | yes | — | string (base64) | Base64 blob decoded and normalized into the `cookie` session option for every Innertube session (`cookies.js`). Accepts either an already-correct header string or a Netscape `cookies.txt` export — format is auto-detected, not configured. Also checked at boot. |
| `POT_PROVIDER_URL` | no | `http://127.0.0.1:4416` | string (URL) | Base URL the bot's own HTTP client uses to reach the `bgutil-pot` sidecar for `/ping` and `/get_pot` (`potProvider.js`). Only needs changing if the sidecar isn't co-located with the bot process — not the case in the shipped Docker setup. |
| `POT_SERVER_HOST` | no | `127.0.0.1` | string (host) | Bind address `start.sh` passes to `bgutil-pot server`. Controls what the *sidecar* binds to — independent of `POT_PROVIDER_URL`, which controls what the *bot* connects to. Nothing keeps the two in sync automatically if you change one. |
| `POT_SERVER_PORT` | no | `4416` | integer (TCP port) | Bind port for the same sidecar process. Same caveat as above — change `POT_PROVIDER_URL`'s port to match if you change this. |
| `MB_PREBUFFER_SECONDS` | no | `1.5` | seconds (float) | Seconds of audio, computed from the chosen format's real bitrate, withheld before playback is allowed to start at all (`config.js` / `prebuffer.js`). Raising this trades startup latency for resilience against early-stream jitter. |
| `MB_PREBUFFER_TIMEOUT_MS` | no | `8000` | milliseconds (int) | Upper bound on how long the prebuffer gate waits before starting playback anyway, regardless of whether the byte target was reached. Exists so a stalled source can't hang the queue indefinitely. |
| `MB_NETWORK_BUFFER_MS` | no | `2000` | milliseconds (int) | Ongoing buffer the network stage keeps topped up *after* the prebuffer releases, sized in time-at-bitrate rather than a fixed byte count. Absorbs CDN throughput variance for the rest of the track, not the initial gate. |
| `MB_STALL_BUFFER_MS` | no | `400` | milliseconds (int) | Post-demux object-mode buffer depth, converted to a frame count assuming fixed 20ms Opus frames (see "Buffer" below). Cushions irregular frame-emission timing from the demuxer, not network-level stalls — that's `MB_NETWORK_BUFFER_MS`'s job. |
| `MB_ASSUMED_BITRATE_BPS` | no | `128000` | bits/sec (int) | Fallback used only when `format.bitrate` is absent or non-positive. youtubei.js formats normally always report a real bitrate, so this is a defensive default, not a tuning knob you should expect to need. |
| `MB_PLAYLIST_MAX_TRACKS` | no | `500` | count (int) | Hard cap on tracks resolved per `/play <playlist-url>` (`extract.js`). Pagination stops as soon as the cap is hit rather than fetching and discarding further pages. |

All six `MB_*` values are numeric and go through `envNumber()` (`config.js`) — this parses via `Number(raw)`, so decimals are accepted even on vars documented as "integer" above (e.g. `MB_STALL_BUFFER_MS=350.5` is accepted, not rejected); "integer" here describes intent, not enforcement. A value that's unset, empty, non-numeric, or negative falls back to the default **silently** — no warning is logged. If a var appears to have no effect, check for exactly this before assuming a wiring bug elsewhere.

### Cookies

`YOUTUBE_COOKIES_BASE64` accepts either of these, base64-encoded:

- an already-correct Cookie header string: `name=value; name2=value2`
- a raw Netscape-format `cookies.txt` export (7 tab-separated columns per
  line; `#`-comments and `#HttpOnly_`-prefixed lines are handled)

`src/lib/cookies.js` auto-detects which one it got and converts to the
header-string format youtubei.js's `cookie` session option expects. It's
unit-tested in `test/cookies.test.js`.

```
base64 -w0 cookies.txt
```

## PO token flow

youtubei.js's `po_token` session option is **bound to `visitor_data`**,
and `visitor_data` itself is minted per **client context** — a token
bootstrapped under the default WEB client is not valid for a YTMUSIC
request, or vice versa. `src/lib/innertube.js` therefore keeps one cached,
attested session **per `client_type`** (`WEB` and `YTMUSIC`/`WEB_REMIX`),
each going through the same sequence independently:

1. Create a bootstrap Innertube session for that `client_type` (no
   `po_token` yet) to obtain a fresh `session.context.client.visitorData`
   valid for that specific context.
2. `POST` that `visitor_data` to the sidecar's `/get_pot` as
   `content_binding`, getting back `{ "po_token": "..." }`.
3. Recreate the session with `{ client_type, cookie, visitor_data,
   po_token }` so every subsequent request under that client context is
   attested.

Each cached session is reused for 5 hours (the sidecar's own TTL is 6h by
default) before being rebuilt, independently per `client_type`. Concurrent
callers for the same `client_type` are coalesced into a single rebuild
rather than triggering duplicate session bootstraps.

The sidecar is **jim60105/bgutil-ytdlp-pot-provider-rs**, run in HTTP
server mode (`bgutil-pot server`). Real endpoints, confirmed against a live
instance of the binary:

- `GET /ping` — health check
- `POST /get_pot` with `{ "content_binding": "<visitor_data>" }` →
  `{ "po_token": "<token>" }` (the binary's internal token struct uses
  camelCase `poToken` — the client accepts either key defensively, since
  this inconsistency isn't documented anywhere)

There's no `/token` endpoint and no `video_id`/`data_sync_id` body on this
implementation — those belonged to the older TypeScript version.

**Also required, separately from po_token:** `Platform.shim.eval` must be
set (`src/lib/innertube.js`) — youtubei.js doesn't bundle a JS interpreter
for deciphering YouTube's signature-cipher code, and without it
`MediaInfo#download()` throws on any ciphered format, in Node just as much
as in a browser.


### YouTube Music

YTM tracks need two things that plain YouTube tracks don't, both
confirmed the hard way against production, not assumed:

1. **A session bootstrapped with `client_type: ClientType.MUSIC`**
   (`'WEB_REMIX'`), not just a per-call `{ client: 'YTMUSIC' }` override on
   a WEB-bootstrapped session. `po_token`/`visitor_data` are minted per
   client context — a token bootstrapped under WEB is not valid for a
   YTMUSIC request. `src/lib/innertube.js` caches one session per
   `clientType` for exactly this reason.
2. **`session.music.getInfo()`, not `session.getInfo()`/`getBasicInfo()`**,
   for the actual track lookup. This is a separate issue from (1) and easy
   to miss even after fixing it — a correctly YTMUSIC-bootstrapped session
   still throws if you call the plain `getInfo()`, because that method
   unconditionally parses the response as `VideoInfo` via
   `.as(TwoColumnWatchNextResults)`, and a YTMUSIC watch response comes
   back shaped as `SingleColumnMusicWatchNextResults` instead — regardless
   of session client_type. The failure mode is exactly this error:
   `Cannot cast SingleColumnMusicWatchNextResults to one of
   TwoColumnWatchNextResults`. `session.music.getInfo()` returns
   `TrackInfo`, built for that shape (and still extends the same
   `MediaInfo` mixin, so `chooseFormat()`/`download()` work identically).

Both `src/lib/extract.js#resolveQuery` and `src/lib/player.js#_buildResource`
branch on `track.isMusic` to call the right method. `test/extract.test.js`
has a regression test for this specific branch — it's the kind of bug
that only shows up against a real YTM URL, not a plain one, so it's easy
to reintroduce without noticing.

## Playlists

`/play <url>` recognizes three URL shapes, handled in `src/lib/extract.js#classifyInput`:

- **Playlist** (`list=PL...`, `UU...`, `OL...`, etc.) — every track's
  metadata (id + title) is fetched up front via pagination, so the full
  queue shows immediately after `/play` returns. Capped at
  `MB_PLAYLIST_MAX_TRACKS` (see "Environment variables" above); pagination
  stops as soon as the cap is hit rather than fetching pages it'll discard.
- **Radio/mix** (`list=RD...`) — deliberately *excluded* from playlist
  expansion. Treated as a single video using the URL's `v=` anchor id
  instead, since a radio "playlist" is really an endless personalized
  stream, not a fixed track list. A radio link with no anchor video is
  rejected with a message asking for a direct track link.
- **Single video / search** — unchanged from before.

Audio extraction stays exactly as lazy as it already was — playlist
support only changes what gets *listed* up front, not when each track's
stream actually gets fetched. `_buildResource()` in `player.js` still only
runs right before a given track plays.

YouTube and YouTube Music playlists go through genuinely different
youtubei.js endpoints (`session.getPlaylist` vs `session.music.getPlaylist`)
with different item shapes — both are handled explicitly in
`resolvePlaylistTracks()`, not assumed to be interchangeable.

## Buffer

Two stages, both configurable via env vars listed above, plus a prebuffer
gate before playback starts at all. All handled in `src/lib/config.js` and
`src/lib/prebuffer.js`, wired into `player.js#_buildResource`.

**Prebuffer mechanism:** a `PrebufferTransform` sits on the raw webm byte
stream, before demuxing. It withholds all output until the byte target is
reached, then flushes everything held so far in one chunk and passes
subsequent data straight through. `_buildResource()` awaits a
`'prebuffered'` event before ever calling `createAudioResource`/`play()` —
so this genuinely delays playback start, it doesn't just smooth an
already-started stream.

**Known limit:** the stall buffer (stage 2) protects against jitter and
short scheduling delays, not a long synchronous block of the event loop
(e.g. a slow extraction for a different guild on the same process) —
buffered frames still need the event loop free to be pushed out. Moving
extraction/demux to a worker thread would fix that properly; not done
here.

**Frame-duration assumption:** stage 2 sizing assumes standard 20ms Opus
frames (both Discord's requirement and what YouTube's opus-in-webm audio
uses in practice) — not verified against a live YouTube stream in the
environment this was built in. Confirm against one real track before
trusting `MB_STALL_BUFFER_MS` precisely.

## Known limitation: gvs-context tokens

Some Innertube clients need a **second, separate "gvs"-context PO token**
bound to the actual CDN streaming URL, distinct from the session/player
token this bot fetches. That second token isn't implemented here. If
search and track lookup work but audio downloads start failing with 403s,
this is the most likely next thing to add — see the sidecar's own docs and
the [yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
for background.

## Docker

Single `Dockerfile`, multi-stage:

1. **`potfetch`** (Debian bookworm-slim) — downloads the
   `bgutil-pot-linux-x86_64` release binary over HTTPS.
2. **`final`** (`node:20-bookworm-slim`) — installs `ca-certificates` (the
   sidecar makes its own HTTPS calls to Google at runtime, so this has to
   be in the *shipped* stage, not just the fetch stage), installs npm deps,
   copies the app and the sidecar binary, and runs a **build-time smoke
   test** (`bgutil-pot --version`).

The smoke test matters because the release binary is built on a recent
Ubuntu CI runner and can need a newer glibc than an older base image ships.
Confirmed against the current binary: it needs glibc ≥ 2.34.
`node:20-bookworm-slim` ships 2.36 (fine); a bullseye-based image ships
2.31 and would **not** work — you'd get a working build but a runtime
crash-loop. Don't swap the base image without re-running the smoke test.

Do **not** switch to an Alpine base — it's musl, not glibc, and the
dynamically-linked release binary won't run at all.

```
docker build -t musicbutler .
docker run --env-file .env musicbutler
```

`start.sh` launches the sidecar first, polls `/ping` until it's healthy (or
gives up after ~30s and starts the bot anyway, so a slow-starting sidecar
doesn't crash-loop the whole container), then `exec`s the Node process.

For local dev: `docker compose up --build` (reads `.env`).

## Commands

- `/play <query>` — URL or search terms
- `/skip`
- `/pause`
- `/resume`
- `/leave`
- `/queue list|remove|swap|move|clear`

Registered globally via `client.application.commands.set()` after `ready`,
which uses the client's own authenticated application ID — passing an
explicit (and possibly wrong/empty) application ID is what produces
Discord's hard-to-parse 400 on registration.

## Development

```
npm install
cp .env.example .env   # fill in DISCORD_TOKEN and YOUTUBE_COOKIES_BASE64
npm test                # unit tests for cookies.js and queueManager.js
npm start                # requires a local bgutil-pot server on :4416 —
                          # run it yourself outside Docker, see the sidecar's
                          # own README for `bgutil-pot server`
```

## What's verified vs. what isn't

Verified directly against the pinned dependency versions and a running
instance of the sidecar during development:

- Cookie parsing (both formats) — unit tested
- Queue manager, including the generation-counter skip-race guard — unit
  tested
- `bgutil-pot`'s actual `/ping` and `/get_pot` HTTP contract, against the
  real v0.8.1 binary
- Every youtubei.js call signature used here (`getInfo`/`getBasicInfo`
  options shape, `search` filters, `Innertube.create` session options,
  `MediaInfo#download`/`#chooseFormat`) against the installed `17.2.0`
  type definitions
- `@discordjs/voice` and `discord.js` exports/method signatures used here,
  against the installed packages' type definitions

Not verified end-to-end (no Docker or live Discord/YouTube access in the
environment this was built in):

- An actual `docker build` of the final image
- A live `/play` against real YouTube/YTM traffic and a live Discord guild
- Whether `YOUTUBE_COOKIES_BASE64` + the sidecar together are sufficient to
  avoid bot detection on Render's IP ranges specifically — this varies by
  host and can require the gvs-context token above
