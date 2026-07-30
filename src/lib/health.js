'use strict';

const http = require('node:http');

/**
 * Minimal HTTP server for Render's own health check ping -- unrelated to
 * Discord's connection state or SABR/playback. Render's web services
 * expect something listening on $PORT and answering 2xx, or the
 * deploy is marked unhealthy and gets cycled.
 *
 * Deliberately does NOT check bgutil-pot or Discord voice state here --
 * those already have their own non-fatal handling in index.js/player.js
 * (a transient POT hiccup shouldn't make Render kill and restart an
 * otherwise-working bot). This only reflects whether the Discord client
 * itself has finished logging in, via `isReady()`.
 *
 * @param {() => boolean} isReady
 * @param {{ port?: number | string }} [opts]
 * @returns {import('node:http').Server}
 */
function startHealthServer(isReady, { port = process.env.PORT || 8080 } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/' && req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    const ready = isReady();
    // 503 before Discord login completes, not 200 -- so Render's health
    // check doesn't report healthy during the startup window (bgutil-pot
    // boot + Discord login), only once the bot can actually do something.
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'text/plain' });
    res.end(ready ? 'ok' : 'starting');
  });

  server.on('error', (err) => {
    // Non-fatal by design -- losing the health endpoint (e.g. port
    // already bound) shouldn't take the whole bot down; Render will
    // just mark the deploy unhealthy, which is the correct outcome for
    // an actual port conflict, rather than crash-looping the bot itself.
    console.error(`Health check server error: ${err.message}`);
  });

  server.listen(port, () => {
    console.log(`Health check server listening on :${port}`);
  });

  return server;
}

module.exports = { startHealthServer };
