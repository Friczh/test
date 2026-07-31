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

// SabrStream's own internal retry (executeWithRetry) keeps hitting the SAME
// request up to `maxRetries` times (default 10) before giving up -- for a
// genuine server-requested reload (RELOAD_PLAYER_RESPONSE), every one of
// those retries is doomed, since the session itself was invalidated, not
// just one flaky request. Confirmed against installed googlevideo@4.0.4
// source (SabrStream#executeWithRetry: backoff = min(500 * 2^(attempt-1),
// 8000ms), attempted maxRetries+1 times total) -- at the default of 10,
// exhausting retries before the reload-reconnect logic below even gets a
// chance to run takes ~59s of silent stall. Lowered here so a real reload
// hands off to reconnection in a few seconds instead of most of a minute
// of dead air.
const SABR_MAX_RETRIES = 3;

// Distinct failure mode from RELOAD_PLAYER_RESPONSE, discovered from a real
// production log ("Maximum retries (10) exceeded while fetching segment:
// No media parts or protocol updates received from server."), confirmed
// against installed googlevideo@4.0.4 source
// (SabrStream#fetchAndProcessSegments / #handleStreamProtectionStatus):
// the server can send a STREAM_PROTECTION_STATUS part with status 2
// ("attestation pending") or 3 ("attestation required"); once that
// happens, SabrStream starts throwing on any subsequent response that
// doesn't carry an actual MEDIA part -- and since it retries the exact
// same request/token unchanged, a request stuck in this state never
// recovers on its own. This lines up with the video-bound PO token
// (minted once per track via getPoToken(videoId) in player.js, distinct
// from the session-level visitor_data-bound token) going stale mid-track
// on longer playback -- "after an amount of time" is the reported
// symptom. Treated the same way as a reload below: reconnect with a
// freshly re-minted token instead of erroring the track out.
const RECOVERABLE_SABR_ERROR_MESSAGES = new Set([
  'Player response reload requested by server',
  'No media parts or protocol updates received from server.',
  'Cannot proceed with stream: attestation required',
]);

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
 * @param {import('youtubei.js').Innertube} session
 *   The Innertube wrapper -- needed for session.session.player.decipher()
 *   to transform server_abr_streaming_url's n-sig before use.
 * @param {{ clientName: number, clientVersion: string }} clientInfo
 *   From innertube.js's getSabrClientInfo(session, clientType).
 * @param {string} poToken
 *   The video-ID-bound PO token -- same one used for the direct-URL GVS
 *   fetch (see player.js: getPoToken(track.videoId)). NOT the
 *   session/visitor_data-bound one.
 * @param {{ preferredItag?: number, refetchInfo?: () => Promise<import('youtubei.js').VideoInfo | import('youtubei.js').TrackInfo>, refetchPoToken?: () => Promise<string> }} [opts]
 *   preferredItag: itag of the format info.chooseFormat() already chose
 *   for direct download, see chooseAudioFormat() above.
 *   refetchInfo: called on a recoverable mid-stream failure (server
 *   reload request, or the video-bound PO token going stale -- see
 *   RECOVERABLE_SABR_ERROR_MESSAGES above) to fetch a fresh `info` for
 *   the SAME track (e.g. `() => session.getInfo(track.videoId)`/
 *   `session.music.getInfo(...)`, matching whichever call originally
 *   produced `info`). Without this, these failures surface as a normal
 *   stream error, ending the track early.
 *   refetchPoToken: called alongside refetchInfo on the same recoverable
 *   failures to re-mint the video-bound PO token (e.g.
 *   `() => getPoToken(track.videoId)`). If omitted, the original
 *   `poToken` is reused on reconnect -- fine for a reload, but won't
 *   help if the token itself is what went stale.
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
/**
 * Derives the per-attempt SABR request parameters (deciphered streaming
 * URL, ustreamer config, format list) from an `info` object. Split out of
 * buildSabrAudioStream() so a reload-reconnect can re-derive these from a
 * freshly refetched `info` without duplicating the extraction/validation
 * logic (see buildSabrAudioStream's relay loop below).
 *
 * Order matters here: all three cheap, synchronous field checks run BEFORE
 * the decipher() call, which is the one async, session-dependent step.
 * This keeps a malformed/non-SABR response failing fast without touching
 * `session` at all -- required so the existing guard-clause unit tests
 * (sabr.test.js) keep passing without needing a real session object, since
 * those tests only exist to exercise these validation branches.
 *
 * @param {import('youtubei.js').VideoInfo | import('youtubei.js').TrackInfo} info
 * @param {import('youtubei.js').Innertube} session
 * @private
 */
async function deriveSabrParams(info, session) {
  const streamingData = info.streaming_data;
  const rawServerAbrStreamingUrl = streamingData?.server_abr_streaming_url;
  if (!rawServerAbrStreamingUrl) {
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

  // CRITICAL: server_abr_streaming_url carries the same n-sig cipher as
  // regular adaptive_formats URLs and MUST be deciphered before use --
  // confirmed against the googlevideo/shaka-player reference integration
  // (LuanRT/sabr-shaka-example, main.ts), which calls
  // `session.player.decipher(streaming_data.server_abr_streaming_url)`
  // before handing the URL to SabrStream. youtubei.js's Player.decipher()
  // reads the `n` query param and runs it through the player's nsig
  // transform (core/Player.js); skipping this leaves a stale/invalid `n`
  // on the URL, which the CDN rejects outright -- this was the actual
  // cause of the "SabrStream Maximum retries exceeded: Server returned
  // 403 Forbidden" production failure, not a token or IP issue.
  // session.player.decipher() is on the real Session object, reached via
  // the public `.session` getter on the Innertube wrapper class -- see
  // player.js's po_token-mutation note for why `session.session` (not
  // `session`) is required here.
  const serverAbrStreamingUrl = await session.session.player.decipher(rawServerAbrStreamingUrl);

  return { serverAbrStreamingUrl, videoPlaybackUstreamerConfig, sabrFormats };
}

/**
 * Starts one SABR attempt (fresh, or resumed from a captured `state`) and
 * wires up reload-request capture on it. `state`/reload plumbing exists
 * because YouTube can send a mid-stream RELOAD_PLAYER_RESPONSE UMP part
 * (session invalidated server-side) -- see buildSabrAudioStream's relay
 * loop for how a reload is turned into a seamless reconnect instead of a
 * hard failure.
 * @private
 */
async function startSabrAttempt(params, clientInfo, poToken, preferredItag, resumeState) {
  const stream = new SabrStream({
    serverAbrStreamingUrl: params.serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: params.videoPlaybackUstreamerConfig,
    clientInfo,
    poToken,
    formats: params.sabrFormats,
  });

  // Captured synchronously INSIDE the 'reloadPlayerResponse' listener --
  // confirmed against installed source (SabrStream#handleReloadPlayerResponse):
  // the emit() call happens synchronously, immediately before the throw
  // that unwinds up to setupStreamingProcess()'s catch/finally, and that
  // finally block calls resetState() unconditionally. getState() has to
  // run before that reset wipes the very state it reads, so it can't be
  // deferred to whenever the caller notices the stream errored.
  let reloadState = null;
  stream.on('reloadPlayerResponse', () => {
    captureReloadState();
  });
  // Attestation-pending/required (see RECOVERABLE_SABR_ERROR_MESSAGES
  // above) has no dedicated event -- STREAM_PROTECTION_STATUS only emits
  // 'streamProtectionStatusUpdate', it doesn't itself throw for status 2,
  // and by the time the eventual "No media parts..." error reaches the
  // relay loop's catch block below, resetState() has already run in
  // setupStreamingProcess()'s finally. So capture state proactively on
  // every status-2/3 update, same as the reload listener, rather than
  // trying to capture it after the fact.
  stream.on('streamProtectionStatusUpdate', (status) => {
    if (status?.status >= 2) captureReloadState();
  });
  function captureReloadState() {
    try {
      reloadState = stream.getState();
    } catch (err) {
      // getState() throws if the main format never initialized yet (the
      // event arrived before the very first segment) -- nothing to
      // resume from in that case; the reconnect below just starts cold.
      reloadState = null;
    }
  }

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
      maxRetries: SABR_MAX_RETRIES,
      state: resumeState,
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

  return {
    stream,
    audioStream,
    selectedFormats,
    getReloadState: () => reloadState,
  };
}

async function buildSabrAudioStream(info, session, clientInfo, poToken, { preferredItag, refetchInfo, refetchPoToken } = {}) {
  const params = await deriveSabrParams(info, session);
  let attempt = await startSabrAttempt(params, clientInfo, poToken, preferredItag, undefined);
  let currentPoToken = poToken;

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
  // This first attempt's format selection is now FIXED for the whole
  // track: every reload-reconnect attempt below re-requests this exact
  // itag via preferredItag, because SabrStream#restoreState() matches
  // resumed state against the newly selected format's key and rejects it
  // on a mismatch (confirmed against installed source) -- switching
  // formats mid-track would desync from the captured state and silently
  // fall back to a cold restart (audible gap) instead of a seamless
  // splice.
  const audioFormat = attempt.selectedFormats.audioFormat;

  let currentReader = attempt.audioStream.getReader();
  let aborted = false;

  // Async fetch/UMP-processing errors (network failures, server-sent
  // SABR_ERROR parts, stalls, retries exhausted, etc.) do NOT throw from
  // start() above -- it kicks off the actual segment-fetching loop in the
  // background and returns immediately. Confirmed against installed
  // source (SabrStream#errorHandler): failures call
  // audioController.error(err), which is what makes reader.read() reject
  // below, once the background loop actually hits one.
  //
  // Everything is relayed through this OWN ReadableStream instead of
  // returning SabrStream's audioStream directly. That's what makes these
  // failures invisible to player.js: on a genuine post-retry-exhaustion
  // error whose message matches RECOVERABLE_SABR_ERROR_MESSAGES (as
  // opposed to some other, non-recoverable fetch failure), a fresh
  // `info` (and PO token) is pulled via `refetchInfo`/`refetchPoToken`, a
  // new SabrStream is started resumed from the captured state, and
  // pumping continues into this SAME outer stream -- player.js's 'error'
  // listener on the wrapped Node stream never fires at all, instead of
  // it treating the failure as "this track failed" and ending playback
  // early.
  const relay = new ReadableStream({
    async pull(controller) {
      for (;;) {
        let result;
        try {
          result = await currentReader.read();
        } catch (err) {
          if (aborted) {
            controller.close();
            return;
          }
          if (!RECOVERABLE_SABR_ERROR_MESSAGES.has(err.message) || !refetchInfo) {
            controller.error(err);
            return;
          }
          const reloadState = attempt.getReloadState();
          console.warn(
            `buildSabrAudioStream: recoverable SABR failure mid-stream (${err.message}) -- ` +
            `reconnecting${reloadState ? ' with resumed playback position' : ' from a cold start (no resumable state captured)'}` +
            `${refetchPoToken ? ', re-minting PO token' : ''}`
          );
          try {
            if (refetchPoToken) {
              currentPoToken = await refetchPoToken();
            }
            const freshInfo = await refetchInfo();
            const freshParams = await deriveSabrParams(freshInfo, session);
            attempt = await startSabrAttempt(
              freshParams,
              clientInfo,
              currentPoToken,
              audioFormat.itag,
              reloadState || undefined
            );
            currentReader = attempt.audioStream.getReader();
            continue; // retry the read against the newly reconnected stream
          } catch (reconnectErr) {
            controller.error(
              new Error(`buildSabrAudioStream: reload reconnect failed: ${reconnectErr.message}`)
            );
            return;
          }
        }
        if (result.done) {
          controller.close();
          return;
        }
        controller.enqueue(result.value);
        return;
      }
    },
    cancel() {
      aborted = true;
      attempt.stream.abort();
    },
  });

  // `abort` stops the CURRENTLY ACTIVE underlying SabrStream's background
  // segment-fetch loop (reassigned on every reload-reconnect above, so
  // this always targets the live one, not a stale pre-reload instance).
  // Confirmed against installed source (googlevideo@4.0.4's SabrStream
  // constructor): the ReadableStream wrapping `audioStream` has no
  // `cancel` handler wired up at all, so destroying/cancelling the Node
  // stream this gets wrapped into (e.g. via Readable.fromWeb(), as
  // player.js does) does NOT stop the fetch loop on its own -- it relies
  // on this relay's own `cancel()` above calling `.abort()` on the real
  // instance. Callers must still call this `abort` on any downstream
  // failure or track skip, or the fetch loop keeps running/fetching after
  // nothing is consuming it.
  return {
    audioStream: relay,
    format: audioFormat,
    abort: () => {
      aborted = true;
      attempt.stream.abort();
    },
  };
}

module.exports = { buildSabrAudioStream, chooseAudioFormat };
