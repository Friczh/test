'use strict';

// Client for jim60105/bgutil-ytdlp-pot-provider-rs running in HTTP server
// mode (`bgutil-pot server`). Real contract, confirmed against the project's
// README (v0.8.x):
//   GET  /ping                                    -> 200 if ready
//   POST /get_pot { "content_binding": "<...>" }   -> { "po_token": "<...>" }
// Do NOT use /token or a video_id/data_sync_id body — those belonged to the
// older TypeScript implementation and are not this binary's contract.

const DEFAULT_BASE_URL = process.env.POT_PROVIDER_URL || 'http://127.0.0.1:4416';
const PING_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Polls GET /ping until the sidecar responds 200 or attempts are exhausted.
 * Intended to be called by start.sh (or index.js on boot) before any
 * playback is attempted.
 */
async function waitForReady(baseUrl = DEFAULT_BASE_URL, { retries = 20, delayMs = 500 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/ping`, { method: 'GET' }, PING_TIMEOUT_MS);
      if (res.ok) return true;
      lastError = new Error(`ping returned HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(
    `POT provider at ${baseUrl} did not become ready after ${retries} attempts: ${lastError?.message}`
  );
}

/**
 * @param {string} contentBinding - session visitor_data (NOT a video id) for
 *   the session-bound token youtubei.js's `po_token` option expects.
 * @param {string} baseUrl
 * @returns {Promise<string>} po_token
 */
async function getPoToken(contentBinding, baseUrl = DEFAULT_BASE_URL) {
  if (!contentBinding) {
    throw new Error('getPoToken: contentBinding is required');
  }
  const res = await fetchWithTimeout(
    `${baseUrl}/get_pot`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_binding: contentBinding }),
    },
    REQUEST_TIMEOUT_MS
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POT provider /get_pot failed: HTTP ${res.status} ${text}`);
  }
  const data = await res.json();
  // The request body is snake_case (content_binding), but this binary's
  // internal token struct uses camelCase (poToken/contentBinding/expiresAt
  // — confirmed via `strings` on the actual release binary). Accepting
  // both here rather than betting on one, since that inconsistency isn't
  // documented anywhere and is easy to get wrong in either direction.
  const token = (data && (data.po_token || data.poToken)) || null;
  if (!token || typeof token !== 'string' || token.length === 0) {
    throw new Error(`POT provider /get_pot response missing po_token/poToken: ${JSON.stringify(data)}`);
  }
  return token;
}

module.exports = { waitForReady, getPoToken, DEFAULT_BASE_URL };
