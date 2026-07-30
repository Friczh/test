'use strict';

const { YTNodes } = require('youtubei.js');

const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be']);
const MUSIC_HOSTS = new Set(['music.youtube.com']);

/**
 * @param {string} input
 * @returns {{ videoId: string, isMusic: boolean } | null}
 */
function parseVideoIdFromUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return null; // not a URL at all -> treat as a search query upstream
  }

  const host = url.hostname.toLowerCase();
  const isMusic = MUSIC_HOSTS.has(host);
  const isYouTube = YOUTUBE_HOSTS.has(host) || isMusic;
  if (!isYouTube) return null;

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return id ? { videoId: id, isMusic: false } : null;
  }

  const vParam = url.searchParams.get('v');
  if (vParam) return { videoId: vParam, isMusic };

  const shortsMatch = url.pathname.match(/^\/shorts\/([^/]+)/);
  if (shortsMatch) return { videoId: shortsMatch[1], isMusic };

  const embedMatch = url.pathname.match(/^\/embed\/([^/]+)/);
  if (embedMatch) return { videoId: embedMatch[1], isMusic };

  return null;
}

/**
 * Classifies a /play argument before any resolution happens, so playlist
 * and radio URLs can be routed differently from single videos.
 *
 * Radio/mix URLs (list=RD...) are deliberately excluded from playlist
 * expansion — treated as a single video using the URL's anchor `v=` id
 * instead. RD-prefix as the radio/mix marker is standard YouTube
 * convention; not verified against a live URL in this environment, so
 * sanity-check against a few real radio links before relying on it.
 *
 * @param {string} input
 * @returns {
 *   | { kind: 'playlist', playlistId: string, isMusic: boolean }
 *   | { kind: 'video', videoId: string, isMusic: boolean }
 *   | { kind: 'search', query: string }
 *   | { kind: 'unsupported', reason: string }
 * }
 */
function classifyInput(input) {
  const trimmed = input.trim();
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { kind: 'search', query: trimmed };
  }

  const host = url.hostname.toLowerCase();
  const isMusic = MUSIC_HOSTS.has(host);
  if (!YOUTUBE_HOSTS.has(host) && !isMusic) {
    return { kind: 'search', query: trimmed };
  }

  const listParam = url.searchParams.get('list');
  if (listParam) {
    if (listParam.startsWith('RD')) {
      const anchorVideoId = url.searchParams.get('v');
      if (anchorVideoId) {
        return { kind: 'video', videoId: anchorVideoId, isMusic };
      }
      return { kind: 'unsupported', reason: 'radio_without_anchor' };
    }
    return { kind: 'playlist', playlistId: listParam, isMusic };
  }

  const direct = parseVideoIdFromUrl(trimmed);
  if (direct) {
    return { kind: 'video', videoId: direct.videoId, isMusic: direct.isMusic };
  }

  return { kind: 'search', query: trimmed };
}

/**
 * Resolves a /play argument (URL or free-text query) to a video ID.
 * @param {import('youtubei.js').Innertube} session
 * @param {string} query
 * @returns {Promise<{ videoId: string, isMusic: boolean, title: string }>}
 */
async function resolveQuery(session, query) {
  const direct = parseVideoIdFromUrl(query.trim());
  if (direct) {
    // Session is already bootstrapped with the matching client_type (see
    // innertube.js / play.js) — that solves the po_token/visitor_data
    // mismatch. But it does NOT make session.getBasicInfo() safe to call
    // for a music track: that method (like session.getInfo()) hardcodes a
    // parse into VideoInfo, which does `.as(TwoColumnWatchNextResults)` on
    // the response — a YTMUSIC-client watch response comes back as
    // SingleColumnMusicWatchNextResults instead, and that cast throws.
    // Confirmed directly against node_modules/youtubei.js/dist/src/parser/
    // youtube/VideoInfo.js — it's unconditional, not client-aware. The
    // fix is a different method entirely: session.music.getInfo(), which
    // returns TrackInfo (built for the Music response shape). TrackInfo
    // extends the same MediaInfo mixin as VideoInfo, so basic_info.title,
    // chooseFormat(), and download() all still work identically below and
    // in player.js.
    const info = direct.isMusic
      ? await session.music.getInfo(direct.videoId)
      : await session.getBasicInfo(direct.videoId);
    return {
      videoId: direct.videoId,
      isMusic: direct.isMusic,
      title: info.basic_info.title ?? direct.videoId,
    };
  }

  const results = await session.search(query, { type: 'video' });
  const firstVideo = results.results.firstOfType(YTNodes.Video);
  if (!firstVideo) {
    throw new Error(`No results found for "${query}"`);
  }
  return {
    videoId: firstVideo.video_id,
    isMusic: false,
    title: firstVideo.title?.text ?? firstVideo.video_id,
  };
}

/**
 * Fetches every track's metadata (id + title) for a playlist up front, so
 * the full queue can be listed immediately. Audio extraction for each
 * track still only happens lazily, right before it plays (unchanged —
 * that's handled entirely in player.js, this function never touches
 * streaming data).
 *
 * YouTube and YouTube Music use genuinely different playlist endpoints and
 * item shapes in youtubei.js (session.getPlaylist vs session.music.getPlaylist,
 * PlaylistVideo vs MusicResponsiveListItem), not just a client flag — both
 * paths are handled explicitly rather than assumed to share one shape.
 *
 * @param {import('youtubei.js').Innertube} session
 * @param {string} playlistId
 * @param {boolean} isMusic
 * @param {{ maxTracks?: number }} [opts]
 * @returns {Promise<Array<{ videoId: string, isMusic: boolean, title: string }>>}
 */
async function resolvePlaylistTracks(session, playlistId, isMusic, { maxTracks = Infinity } = {}) {
  const tracks = [];

  if (isMusic) {
    let playlist = await session.music.getPlaylist(playlistId);
    while (tracks.length < maxTracks) {
      const items = playlist.items?.filterType(YTNodes.MusicResponsiveListItem) ?? [];
      for (const item of items) {
        if (tracks.length >= maxTracks) break;
        const playable = item.item_type === 'song' || item.item_type === 'video';
        if (!playable || !item.id) continue; // skip unavailable / non-track entries
        tracks.push({ videoId: item.id, isMusic: true, title: item.title ?? item.id });
      }
      if (tracks.length >= maxTracks || !playlist.has_continuation) break;
      playlist = await playlist.getContinuation();
    }
    return tracks;
  }

  let playlist = await session.getPlaylist(playlistId);
  while (tracks.length < maxTracks) {
    const items = playlist.items.filterType(YTNodes.PlaylistVideo);
    for (const item of items) {
      if (tracks.length >= maxTracks) break;
      if (!item.is_playable) continue; // skip private/deleted/region-locked placeholders
      tracks.push({ videoId: item.id, isMusic: false, title: item.title?.text ?? item.id });
    }
    if (tracks.length >= maxTracks || !playlist.has_continuation) break;
    playlist = await playlist.getContinuation();
  }
  return tracks;
}

module.exports = { parseVideoIdFromUrl, classifyInput, resolveQuery, resolvePlaylistTracks };
