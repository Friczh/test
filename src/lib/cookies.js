'use strict';

// Converts either (a) an already-correct "name=value; name2=value2" Cookie
// header string, or (b) a raw Netscape-format cookies.txt export, into the
// header-string format that youtubei.js's `cookie` session option expects.
//
// Netscape format: 7 tab-separated columns per line:
//   domain  include_subdomains  path  secure  expiry  name  value
// Comment lines start with "#", except lines prefixed "#HttpOnly_" which are
// still real cookie lines (the prefix just marks the cookie as HttpOnly) and
// must be unwrapped before splitting on tabs.

const HTTPONLY_PREFIX = '#HttpOnly_';

function stripHttpOnlyPrefix(line) {
  return line.startsWith(HTTPONLY_PREFIX) ? line.slice(HTTPONLY_PREFIX.length) : line;
}

function significantLines(raw) {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function isNetscapeFormat(raw) {
  for (const line of significantLines(raw)) {
    if (line.startsWith('#') && !line.startsWith(HTTPONLY_PREFIX)) continue; // pure comment
    const fields = stripHttpOnlyPrefix(line).split('\t');
    return fields.length === 7;
  }
  return false;
}

function parseNetscapeCookies(raw) {
  const pairs = [];
  for (const line of significantLines(raw)) {
    if (line.startsWith('#') && !line.startsWith(HTTPONLY_PREFIX)) continue;
    const fields = stripHttpOnlyPrefix(line).split('\t');
    if (fields.length !== 7) continue;
    const [, , , , , name, value] = fields;
    if (!name) continue;
    pairs.push(`${name}=${value ?? ''}`);
  }
  if (pairs.length === 0) {
    throw new Error('parseNetscapeCookies: no valid cookie lines found');
  }
  return pairs.join('; ');
}

function normalizeHeaderString(raw) {
  // Already "name=value; name2=value2" — collapse whitespace/newlines and
  // normalize separators, but don't touch the name/value content itself.
  const joined = significantLines(raw).join(' ');
  return joined
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.includes('='))
    .join('; ');
}

/**
 * @param {string} raw - either a Cookie header string or a cookies.txt body
 * @returns {string} a "name=value; name2=value2" Cookie header string
 */
function parseCookiesToHeader(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('parseCookiesToHeader: input is empty or not a string');
  }
  const header = isNetscapeFormat(raw) ? parseNetscapeCookies(raw) : normalizeHeaderString(raw);
  if (!header) {
    throw new Error('parseCookiesToHeader: could not extract any cookies from input');
  }
  return header;
}

/**
 * @param {string} base64 - value of YOUTUBE_COOKIES_BASE64
 * @returns {string} Cookie header string
 */
function decodeCookiesEnv(base64) {
  if (!base64 || base64.trim().length === 0) {
    throw new Error('YOUTUBE_COOKIES_BASE64 is not set');
  }
  const raw = Buffer.from(base64, 'base64').toString('utf8');
  return parseCookiesToHeader(raw);
}

module.exports = { parseCookiesToHeader, decodeCookiesEnv, isNetscapeFormat };
