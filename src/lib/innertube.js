'use strict';

const { Innertube, UniversalCache, Platform, ClientType, Constants, Parser } = require('youtubei.js');
const { getPoToken } = require('./potProvider');
const { decodeCookiesEnv } = require('./cookies');

// youtubei.js never bundles a JS interpreter for deciphering YouTube's
// obfuscated signature-cipher code (needed for MediaInfo#download on
// ciphered formats) — this is required in Node.js too, not just browsers,
// per the current docs (ytjs.dev/guide/getting-started, "Providing a
// Custom JavaScript Interpreter"). Without this, download() throws
// "you must provide your own JavaScript evaluator". `Function` is a
// Node.js global, safe to use here the same as the docs' example.
Platform.shim.eval = async (data) => new Function(data.output)();

// youtubei.js's default parser ERROR_HANDLER (parser/parser.js) logs a
// multi-line dump per warning -- full stack trace, and for the common
// "class_not_found"/"typecheck" cases (a UI panel this package version
// has no parser class for yet, e.g. the "Ask" AI sidebar seen in prod
// logs) it also prints the entire JIT-introspected TypeScript class body.
// These are non-fatal by design -- confirmed against installed source,
// this handler only ever logs and returns null, it never throws, and
// getInfo()/music.getInfo() completes normally either way (see
// player.js's comment on this same warning). `setParserErrorHandler` is
// youtubei.js's own supported override hook for this (parser/parser.js),
// scoped to parser warnings only -- unlike Utils.Log.setLevel(), which
// would silence ALL of youtubei.js's WARNING-level logs project-wide,
// including genuinely useful ones unrelated to parsing.
//
// To go fully silent instead of one line, replace the body with a no-op:
// Parser.setParserErrorHandler(() => {});
Parser.setParserErrorHandler(({ classname, error_type, ...context }) => {
  let detail;
  switch (error_type) {
    case 'parse':
      detail = context.error instanceof Error ? context.error.message : 'parse error';
      break;
    case 'typecheck':
      detail = `expected ${Array.isArray(context.expected) ? context.expected.join('|') : context.expected}`;
      break;
    case 'class_not_found':
      detail = 'no parser class yet (new YouTube UI element)';
      break;
    case 'class_changed':
      detail = `keys changed: ${(context.changed_keys || []).map(([k]) => k).join(', ')}`;
      break;
    case 'mutation_data_missing':
      detail = 'mutation data missing';
      break;
    case 'mutation_data_invalid':
      detail = `${context.failed}/${context.total} items missing valid mutation data`;
      break;
    default:
      detail = error_type || 'unknown';
  }
  console.warn(`[youtubei.js parser] ${error_type}: ${classname} — ${detail}`);
});

// The session-bootstrap `client_type` option requires the RAW internal
// client name (matched against Constants.CLIENTS[x].NAME), not the
// friendly alias youtubei.js accepts as a per-call `{ client: '...' }'
// override elsewhere (getInfo/search). Those are two different resolution
// paths. Confirmed directly against the installed package's exported
// ClientType enum (`node -e "console.log(require('youtubei.js').ClientType)"`)
// after 'YTMUSIC' was rejected at runtime with "Unknown client name:
// YTMUSIC." — the correct raw value is ClientType.MUSIC === 'WEB_REMIX'.
const CLIENT_TYPE_FOR = {
  WEB: ClientType.WEB,
  YTMUSIC: ClientType.MUSIC,
};

// youtubei.js's `po_token` session option is bound to `visitor_data`, and
// visitor_data itself is minted per client context — a token bootstrapped
// under the default WEB client is NOT valid for a YTMUSIC-context request,
// even though youtubei.js lets you pass `{ client: 'YTMUSIC' }` as a
// per-call override on a WEB-bootstrapped session without complaining.
// Confirmed the hard way: doing exactly that gets rejected by YouTube with
// a non-2xx. Correct flow per client_type, each cached independently:
//   1. Bootstrap an Innertube session with that specific `client_type` (no
//      po_token yet) to obtain a visitor_data that's actually valid for
//      that client context.
//   2. Ask the POT provider for a token bound to that visitor_data.
//   3. Recreate the session with { client_type, cookie, visitor_data,
//      po_token }.
const TOKEN_TTL_MS = 5 * 60 * 60 * 1000; // 5h

let cookieHeader = null;
// clientType -> { session, tokenIssuedAt, refreshPromise }
const sessions = new Map();

function getCookieHeader() {
  if (!cookieHeader) {
    cookieHeader = decodeCookiesEnv(process.env.YOUTUBE_COOKIES_BASE64);
  }
  return cookieHeader;
}

async function bootstrapVisitorData(clientType) {
  const bootstrap = await Innertube.create({
    client_type: CLIENT_TYPE_FOR[clientType],
    cookie: getCookieHeader(),
    cache: new UniversalCache(false),
    generate_session_locally: true,
  });
  const visitorData = bootstrap.session?.context?.client?.visitorData;
  if (!visitorData) {
    throw new Error(`bootstrapVisitorData(${clientType}): failed to obtain visitor_data from bootstrap session`);
  }
  return visitorData;
}

async function buildSession(clientType) {
  const visitorData = await bootstrapVisitorData(clientType);
  const poToken = await getPoToken(visitorData);
  const session = await Innertube.create({
    client_type: CLIENT_TYPE_FOR[clientType],
    cookie: getCookieHeader(),
    cache: new UniversalCache(false),
    generate_session_locally: true,
    visitor_data: visitorData,
    po_token: poToken,
  });
  return session;
}

/**
 * Returns a cached, attested Innertube session for the given client_type
 * ('WEB' or 'YTMUSIC'), transparently rebuilding it (and fetching a fresh
 * po_token bound to that client's own visitor_data) if it's missing,
 * expired, or a refresh is explicitly requested.
 */
async function getSession({ clientType = 'WEB', forceRefresh = false } = {}) {
  if (!(clientType in CLIENT_TYPE_FOR)) {
    throw new Error(`getSession: unknown clientType "${clientType}" (expected one of: ${Object.keys(CLIENT_TYPE_FOR).join(', ')})`);
  }
  let entry = sessions.get(clientType);
  const expired = !entry || Date.now() - entry.tokenIssuedAt > TOKEN_TTL_MS;

  if (entry?.session && !forceRefresh && !expired) {
    return entry.session;
  }

  // Coalesce concurrent callers (per client_type) into a single rebuild.
  if (!entry?.refreshPromise) {
    const refreshPromise = buildSession(clientType).then((session) => {
      sessions.set(clientType, { session, tokenIssuedAt: Date.now(), refreshPromise: null });
      return session;
    });
    sessions.set(clientType, { session: entry?.session ?? null, tokenIssuedAt: entry?.tokenIssuedAt ?? 0, refreshPromise });
    return refreshPromise;
  }
  return entry.refreshPromise;
}

/**
 * Builds the `clientInfo` object googlevideo's SabrStream needs to
 * identify itself in SABR requests (StreamerContext_ClientInfo proto).
 *
 * `clientName` must be the numeric client ID, not the friendly name --
 * confirmed against installed youtubei.js source
 * (utils/Constants.js: CLIENT_NAME_IDS, keyed by the same raw NAME
 * values as CLIENT_TYPE_FOR above -- ClientType.WEB === 'WEB' === the
 * CLIENT_NAME_IDS key, so CLIENT_TYPE_FOR[clientType] is reused
 * directly as the lookup key here, no separate mapping needed).
 * CLIENT_NAME_IDS values are strings ('1', '67'); the proto field wants
 * a number.
 *
 * `clientVersion` is pulled from the already-bootstrapped session so it
 * matches whatever version string that session's requests are using --
 * confirmed via `session.session.client_version` getter
 * (core/Session.js), NOT a static constant.
 *
 * @param {import('youtubei.js').Innertube} session
 * @param {'WEB' | 'YTMUSIC'} clientType
 * @returns {{ clientName: number, clientVersion: string }}
 */
function getSabrClientInfo(session, clientType) {
  const rawName = CLIENT_TYPE_FOR[clientType];
  const clientNameId = Constants.CLIENT_NAME_IDS[rawName];
  if (!clientNameId) {
    throw new Error(`getSabrClientInfo: no CLIENT_NAME_IDS entry for "${rawName}" (clientType "${clientType}")`);
  }
  return {
    clientName: Number(clientNameId),
    clientVersion: session.session.client_version,
  };
}

module.exports = { getSession, getSabrClientInfo };
