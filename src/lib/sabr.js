'use strict';

// SABR fallback path. youtubei.js's own info.download()/chooseFormat() only
// handle direct-URL and ciphered formats -- confirmed against installed
// youtubei.js@17.2.0 source, there is no UMP/SABR client in that package at
// all. The actual SABR protocol client lives in `googlevideo` (npm), the
// same author's companion library, specifically its SabrStream class
// (googlevideo/sabr-stream). Both packages are ESM-only ("type": "module")
// but requiring them via CJS `require()` works the same way
// require('youtubei.js') already does elsewhere in this project -- Node's
// require(esm) has been unflagged and stable since Node 20.19.0 / 22.12.0,
// confirmed on the Dockerfile's node:20-bookworm-slim base.
const { SabrStream } = require('googlevideo/sabr-stream');
const { buildSabrFormat, EnabledTrackTypes } = require('googlevideo/utils');

/**
 * Picks which SABR-eligible audio format to request. Pulled out as a pure
 * function (no network) so it's directly unit-testable, and so the
 * selection logic is visible independent of SabrStream's own plumbing.
 *
 * When `preferredItag` is given -- normally the itag of the exact webm/
 * opus format info.chooseFormat() already picked for direct download in
 * player.js -- and that itag is present in `formats`, it's used as-is.
 * This guarantees the SABR fallback fetches the IDENTICAL container/codec
 * direct-download would have used, rather than re-deriving its own pick
 * independently (the previous behavior): the two paths could otherwise
 * select different formats, and if SABR's own opus-mimeType heuristic
 * ever failed to find an opus candidate, it fell back to "best bitrate,
 * any codec" -- which could hand a non-WebM (e.g. AAC/mp4a) payload to
 * prism-media's WebmDemuxer, which only ever parses WebM/EBML and errors
 * immediately on anything else.
 *
 * @param {Array<import('googlevideo/shared-types').SabrFormat>} formats
 *   Already filtered to audio-only by SabrStream/chooseFormat internally.
 * @param {number} [preferredItag]
 * @returns {import('googlevideo/shared-types').SabrFormat | undefined}
 */
function chooseAudioFormat(formats, preferredItag) {
  if (preferredItag) {
    const exact = formats.find((f) => f.itag === preferredItag);
    if (exact) return exact;
    // Falls through to the heuristic below -- e.g. the direct-download
    // pick came from streaming_data.formats (the rarely-populated legacy
    // muxed list) rather than adaptive_formats, so it has no SABR-side
    // counterpart at all.
  }
  const opusOnly = formats.filter((f) => f.mimeType?.includes('opus'));
  const pool = opusOnly.length ? opusOnly : formats;
  return pool.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
}

/**
 * Builds a raw (fragmented) webm/opus audio ReadableStream for a track
 * whose direct-URL download failed, using YouTube's SABR/UMP protocol.
 *
 * @param {import('youtubei.js').VideoInfo | import('youtubei.js').TrackInfo} info
 *   Result of session.getInfo()/session.music.getInfo() -- same `info`
 *   object the direct-download path already has, no extra fetch needed.
 * @param {{ clientName: number, clientVersion: string }} clientInfo
 *   From innertube.js's getSabrClientInfo(session, clientType).
 * @param {string} poToken
 *   The video-ID-bound PO token -- same one used for the direct-URL GVS
 *   fetch (see player.js: getPoToken(track.videoId)). NOT the
 *   session/visitor_data-bound one.
 * @param {{ preferredItag?: number }} [opts]
 *   preferredItag: itag of the format info.chooseFormat() already chose
 *   for direct download, see chooseAudioFormat() above.
 * @returns {Promise<{
 *   audioStream: ReadableStream<Uint8Array>,
 *   format: import('googlevideo/shared-types').SabrFormat,
 *   abort: () => void,
 * }>}
 *   `format` is the actual selected SABR audio format -- callers must
 *   check `format.mimeType` to decide whether the returned stream is
 *   WebM/Opus (route through buildOpusPipeline()) or something else,
 *   e.g. fMP4/AAC (route through buildTranscodedOpusPipeline() instead),
 *   see demuxPipeline.js.
 *   `abort` stops the underlying SabrStream's background segment-fetch
 *   loop. Confirmed against installed source (googlevideo@4.0.4's
 *   SabrStream constructor): the ReadableStream wrapping `audioStream`
 *   has no `cancel` handler wired up at all, so destroying/cancelling
 *   the Node stream this gets wrapped into (e.g. via Readable.fromWeb(),
 *   as player.js does) does NOT stop the fetch loop -- only calling
 *   `.abort()` on the SabrStream INSTANCE itself does. Callers must call
 *   this on any downstream failure or track skip, or the fetch loop
 *   keeps running/fetching after nothing is consuming it.
 */
async function buildSabrAudioStream(info, clientInfo, poToken, { preferredItag } = {}) {
  const streamingData = info.streaming_data;
  const serverAbrStreamingUrl = streamingData?.server_abr_streaming_url;
  if (!serverAbrStreamingUrl) {
    throw new Error(
      'buildSabrAudioStream: no server_abr_streaming_url on streaming_data -- not a SABR-eligible response, fallback does not apply here'
    );
  }

  // NOT nested inside streaming_data -- confirmed against installed
  // youtubei.js source (parser/parser.js line ~296 + core/mixins/
  // MediaInfo.js line ~63): it's a sibling field on `info.player_config`,
  // assembled from playerConfig.mediaCommonConfig.mediaUstreamerRequestConfig
  // .videoPlaybackUstreamerConfig in the raw player response. VideoInfo
  // and TrackInfo both go through the same MediaInfo mixin, so this path
  // is identical for regular YouTube and YouTube Music tracks.
  const videoPlaybackUstreamerConfig =
    info.player_config?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
  if (!videoPlaybackUstreamerConfig) {
    throw new Error(
      'buildSabrAudioStream: no video_playback_ustreamer_config on info.player_config -- cannot build a valid SABR request'
    );
  }

  // ALL adaptive formats (audio + video), not just audio ones. Confirmed
  // by direct test against installed googlevideo@4.0.4:
  // SabrStream#selectFormats() throws "No suitable formats found for
  // download" if EITHER track type has zero candidates in the formats
  // list, even though only audio will actually be fetched below. The
  // video pick is real but gets discarded via enabledTrackTypes.
  const sabrFormats = (streamingData.adaptive_formats || []).map(buildSabrFormat);
  if (!sabrFormats.some((f) => f.mimeType?.includes('video'))) {
    throw new Error(
      'buildSabrAudioStream: no video-type format present in adaptive_formats -- SabrStream requires at least one video candidate even for audio-only playback, cannot proceed'
    );
  }

  const stream = new SabrStream({
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig,
    clientInfo,
    poToken,
    formats: sabrFormats,
  });

  let selectedFormats;
  let audioStream;
  try {
    // IMPORTANT: do not pass preferWebM/preferMP4/preferH264 as top-level
    // start() options. Confirmed by direct test: those preferences apply
    // to BOTH the audio AND video candidate lists inside
    // SabrStream#selectFormats(), and this project only cares about
    // audio -- if the video-format candidates don't happen to match the
    // preferred container, selectFormats() throws even though the video
    // pick is discarded a moment later. Container/codec preference for
    // audio must be scoped to the audioFormat selector function only,
    // leaving video selection unconstrained (defaults to best-by-height).
    ({ audioStream, selectedFormats } = await stream.start({
      audioFormat: (formats) => chooseAudioFormat(formats, preferredItag),
      enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
    }));
  } catch (err) {
    // Synchronous throw from selectFormats() (bad/empty format list) --
    // distinct from the async mid-stream errors below, which surface
    // later through the returned ReadableStream itself, not here.
    throw new Error(`buildSabrAudioStream: SabrStream.start() failed during format selection: ${err.message}`);
  }

  if (!selectedFormats?.audioFormat) {
    throw new Error('buildSabrAudioStream: SabrStream selected no audio format');
  }

  // Whether the selected format is Opus-coded is now the CALLER's
  // decision, not this function's -- returned alongside the stream
  // rather than gating it. chooseAudioFormat() above falls back to "best
  // bitrate, any codec" when there's no Opus candidate at all among the
  // SABR-eligible formats (this happens for real: YouTube increasingly
  // serves SABR-only WEB responses whose only audio track is AAC/mp4a,
  // with no Opus alternative). player.js now routes a non-Opus result
  // through buildTranscodedOpusPipeline() (FFmpeg decode + Opus
  // re-encode, see demuxPipeline.js) instead of buildOpusPipeline()'s
  // plain WebM demuxer, so this no longer aborts/fails here for that
  // case.
  //
  // Async fetch/UMP-processing errors (network failures, server-sent
  // SABR_ERROR parts, stalls exceeding maxRetries, etc.) do NOT throw
  // here -- start() kicks off the actual segment-fetching loop in the
  // background and returns immediately. Confirmed against installed
  // source (SabrStream#errorHandler): failures call
  // audioController.error(err), which surfaces as a standard 'error'
  // event once this ReadableStream is wrapped with Readable.fromWeb() in
  // player.js -- same mechanism the direct-download path already
  // listens for, no new error-handling plumbing needed there.
  return { audioStream, format: selectedFormats.audioFormat, abort: () => stream.abort() };
}

module.exports = { buildSabrAudioStream, chooseAudioFormat };
