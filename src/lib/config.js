'use strict';

// Standard Opus frame duration — both Discord's voice gateway and YouTube's
// opus-in-webm audio use 20ms frames. Assumption, not verified against a
// live YouTube stream in this environment; check against one real track
// before relying on it for anything precision-sensitive.
const OPUS_FRAME_MS = 20;

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const config = {
  // Stage 1 (network) + prebuffer-before-play. Withholds output from the
  // raw webm byte stream until this many seconds' worth of data (estimated
  // from the chosen format's real bitrate) has accumulated, before
  // playback is allowed to start at all.
  prebufferSeconds: envNumber('MB_PREBUFFER_SECONDS', 1.5),
  // Ongoing smoothing once the prebuffer has released — how much the
  // network stage keeps buffered internally as new data continues to
  // arrive, to absorb CDN jitter.
  networkBufferMs: envNumber('MB_NETWORK_BUFFER_MS', 2000),
  // Safety valve: if the prebuffer target is never reached (stalled/slow
  // connection), start playback anyway after this long rather than hang
  // the queue forever.
  prebufferTimeoutMs: envNumber('MB_PREBUFFER_TIMEOUT_MS', 8000),
  // Defensive fallback only. youtubei.js's Format#bitrate is a required
  // field on real formats, so this should rarely be used.
  assumedBitrateBps: envNumber('MB_ASSUMED_BITRATE_BPS', 128_000),

  // Stage 2 (stall buffer): cushions irregular Opus-frame emission after
  // demuxing. Configured in milliseconds, converted to a frame count using
  // OPUS_FRAME_MS.
  stallBufferMs: envNumber('MB_STALL_BUFFER_MS', 400),

  // Guards against a pathological playlist size on a free-tier host. A
  // resolved playlist longer than this is truncated, not rejected.
  playlistMaxTracks: envNumber('MB_PLAYLIST_MAX_TRACKS', 500),

  get stallBufferFrames() {
    return Math.max(1, Math.round(this.stallBufferMs / OPUS_FRAME_MS));
  },
};

module.exports = { config, envNumber };
