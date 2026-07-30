'use strict';

const { Readable } = require('node:stream');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
} = require('@discordjs/voice');
const { getSession, getSabrClientInfo } = require('./innertube');
const { getPoToken } = require('./potProvider');
const { buildSabrAudioStream } = require('./sabr');
const { PrebufferTransform } = require('./prebuffer');
const { buildOpusPipeline, buildTranscodedOpusPipeline } = require('./demuxPipeline');
const { config } = require('./config');

// SabrStream itself throws this exact message internally when the server
// sends a STREAM_PROTECTION_STATUS part with status 3 -- confirmed
// against installed googlevideo source (SabrStream#handleStreamProtectionStatus).
// This means YouTube is requiring a form of client attestation this bot
// cannot satisfy (a bot-check/DRM gate), not a transient network problem
// or a bug in this pipeline -- so it's worth a distinct, actionable log
// line instead of blending into the generic "pipeline error" noise,
// even though the actual handling (skip to the next track) is the same
// either way.
function isAttestationRequired(err) {
  return /attestation required/i.test(err?.message || '');
}

function describeStreamError(err, usedSabr) {
  if (usedSabr && isAttestationRequired(err)) {
    return 'SABR attestation required -- YouTube is requiring additional client verification ' +
      'this bot cannot satisfy for this video (DRM/bot-check gate), not a network or pipeline bug';
  }
  return err.message;
}

class GuildPlayer {
  constructor(guildId, queue) {
    this.guildId = guildId;
    this.queue = queue;
    this.connection = null;
    this.audioPlayer = createAudioPlayer();
    // The abort() hook for whatever track is currently playing/being
    // built, IF it's using SABR (null otherwise) -- see sabr.js's
    // buildSabrAudioStream() return value. Needed because destroying the
    // Node stream wrapping SabrStream's output does NOT stop its
    // background segment-fetch loop (no `cancel` handler wired on that
    // ReadableStream -- confirmed against installed googlevideo source);
    // only calling .abort() on the SabrStream instance itself does.
    this._activeAbort = null;
    this._wireAudioPlayerEvents();
  }

  _wireAudioPlayerEvents() {
    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      this._playNext().catch((err) =>
        console.error(`[player:${this.guildId}] playNext failed:`, err.message)
      );
    });
    this.audioPlayer.on('error', (err) => {
      console.error(`[player:${this.guildId}] audio player error:`, err.message);
      this._playNext().catch((e) =>
        console.error(`[player:${this.guildId}] playNext after error failed:`, e.message)
      );
    });
  }

  async connect(voiceChannel) {
    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
    this.connection.subscribe(this.audioPlayer);
  }

  disconnect() {
    this.queue.bumpGeneration();
    this.queue.clear();
    this.audioPlayer.stop(true);
    this.connection?.destroy();
    this.connection = null;
  }

  /** Add a track to the queue; kicks off playback if nothing is playing. */
  async enqueue(track) {
    this.queue.add(track);
    if (this.audioPlayer.state.status === AudioPlayerStatus.Idle && !this.queue.playing) {
      await this._playNext();
    }
  }

  /** Batch version of enqueue(), for playlists — one idle-check, not N. */
  async enqueueMany(tracks) {
    if (tracks.length === 0) return;
    this.queue.addMany(tracks);
    if (this.audioPlayer.state.status === AudioPlayerStatus.Idle && !this.queue.playing) {
      await this._playNext();
    }
  }

  skip() {
    // Invalidate any in-flight extraction for the current track first, so a
    // slow resolve that finishes after this call can't clobber whatever the
    // Idle handler starts next.
    this.queue.bumpGeneration();
    this.audioPlayer.stop(true);
  }

  pause() {
    return this.audioPlayer.pause();
  }

  resume() {
    return this.audioPlayer.unpause();
  }

  /**
   * Stops whatever SABR fetch loop the OUTGOING track (the one we're
   * moving away from -- finished, skipped, or failed) left running, if
   * any. Best-effort: SabrStream.abort() calls controller.error() on
   * ReadableStream controllers that may already be closed (natural
   * end-of-track), which can throw -- there's nothing useful to do about
   * that here either way, so it's swallowed.
   */
  _abortActiveSabr() {
    const abort = this._activeAbort;
    this._activeAbort = null;
    if (!abort) return;
    try {
      abort();
    } catch { /* already finished/aborted -- nothing to clean up */ }
  }

  async _playNext() {
    // Always runs first, unconditionally -- whether this call came from
    // a natural track-end (Idle), an error, skip(), or disconnect()'s
    // queue-clear, whatever SABR fetch loop the PREVIOUS track owned
    // needs to be stopped before (maybe) starting the next one. See
    // _abortActiveSabr().
    this._abortActiveSabr();

    const track = this.queue.next();
    if (!track) return;

    const generation = this.queue.generation;
    let resource;
    try {
      resource = await this._buildResource(track);
    } catch (err) {
      console.error(`[player:${this.guildId}] extraction failed for ${track.videoId}:`, err.message);
      if (this.queue.isCurrentGeneration(generation)) {
        return this._playNext(); // don't let one bad track wedge the queue
      }
      return;
    }

    if (!this.queue.isCurrentGeneration(generation)) return; // stale result, drop it

    this.audioPlayer.play(resource);
  }

  /**
   * Logs streaming_data/format shape plus CDN response detail (if any) so
   * a genuine acquisition failure (both direct AND SABR unavailable/
   * failed) can be diagnosed from logs alone. Kept as a separate method
   * so Phase 1's two failure branches (no SABR available / SABR itself
   * failed) can share it without duplicating the formatting logic.
   */
  async _logStreamFailureDiagnostic(track, info, format, directErr, sabrErr = null) {
    const sd = info.streaming_data || {};
    let cdnDetail = '';
    if (directErr.info?.response) {
      const r = directErr.info.response;
      let bodyText = '';
      try { bodyText = (await r.clone().text()).slice(0, 300); } catch { /* ignore */ }
      cdnDetail = `\n  CDN response status: ${r.status} ${r.statusText}\n  CDN response body (first 300 chars): ${bodyText}`;
    }
    console.warn(
      `[player:${this.guildId}] STREAM-ACQUISITION-DIAGNOSTIC for ${track.videoId}:\n` +
      `  direct error message: ${directErr.message}\n` +
      `  direct error_type: ${directErr.info?.error_type}\n` +
      (sabrErr ? `  sabr fallback error: ${sabrErr.message}\n` : '  sabr fallback: not attempted (no server_abr_streaming_url)\n') +
      `  streaming_data keys: ${JSON.stringify(Object.keys(sd))}\n` +
      `  has server_abr_streaming_url: ${!!sd.server_abr_streaming_url}\n` +
      `  chosen format keys: ${JSON.stringify(Object.keys(format))}\n` +
      `  format.has_audio: ${format.has_audio}, format.itag: ${format.itag}, ` +
      `format.mime_type: ${format.mime_type}\n` +
      `  format has url/cipher: url=${!!format.url}, signature_cipher=${!!format.signature_cipher}, cipher=${!!format.cipher}` +
      cdnDetail
    );
  }

  async _buildResource(track) {
    // Session client_type must match the track's context — a po_token/
    // visitor_data minted for WEB is not valid for a YTMUSIC request (or
    // vice versa). This was the actual cause of YTM playback failing with
    // a non-2xx: the old code bootstrapped one WEB session and passed
    // `{ client: 'YTMUSIC' }` as a per-call override on top of it, which
    // reuses the wrong token context. See innertube.js for the fix.
    const session = await getSession({ clientType: track.isMusic ? 'YTMUSIC' : 'WEB' });
    // Correct client_type on the session isn't enough by itself — the
    // *method* matters too. session.getInfo() always builds a VideoInfo
    // via `.as(TwoColumnWatchNextResults)` regardless of session
    // client_type (confirmed against node_modules/youtubei.js/dist/src/
    // parser/youtube/VideoInfo.js — the cast target is hardcoded, not
    // client-aware), and a YTMUSIC watch response comes back shaped as
    // SingleColumnMusicWatchNextResults instead, so that cast throws:
    // "Cannot cast SingleColumnMusicWatchNextResults to one of
    // TwoColumnWatchNextResults". session.music.getInfo() returns
    // TrackInfo, built for that shape, and internally still forces
    // client: 'YTMUSIC' on its own HTTP calls while reusing the session's
    // po_token — which is exactly why the session still needs to be
    // YTMUSIC-bootstrapped above, even though this call doesn't take a
    // client option itself.
    //
    // NOTE: youtubei.js commonly logs a "[YOUTUBEJS][Parser]: ParsingError:
    // Type mismatch..." warning here for videos with newer UI panels
    // (e.g. the "Ask"/AI sidebar) that this library version doesn't have a
    // parser class for yet. That's harmless — youtubei.js's default error
    // handler only warns and returns null for that one panel, it doesn't
    // throw (confirmed against parser.js source: the 'typecheck' case in
    // ERROR_HANDLER never throws). getInfo() still completes normally and
    // still returns valid streaming_data. Don't treat it as a failure.
    const info = track.isMusic
      ? await session.music.getInfo(track.videoId)
      : await session.getInfo(track.videoId);

    // NOTE: info.chooseFormat() (youtubei.js's FormatUtils.chooseFormat)
    // throws InnertubeError('No matching formats found') itself when there
    // are no candidates -- confirmed against installed source, it never
    // returns null/undefined. That throw is still caught by the try/catch
    // around _buildResource() in _playNext(), so no separate null check is
    // needed here; kept as a try/wrap only so the error message identifies
    // which track failed.
    let format;
    try {
      format = info.chooseFormat({ type: 'audio', format: 'webm', quality: 'best' });
    } catch (err) {
      throw new Error(`No suitable audio-only webm/opus format found for ${track.videoId}: ${err.message}`);
    }

    // GVS (the actual CDN media fetch) needs a PO token bound to the VIDEO
    // ID, not the session/visitor_data-bound one used for API calls like
    // getInfo/search — confirmed against yt-dlp's PO Token Guide ("Most PO
    // Tokens (such as for web GVS/Player) are bound to the video ID, so a
    // new token is required for each video"). Without this, decipher()
    // still runs successfully and produces a URL, but the CDN itself
    // rejects the fetch with 403 — which is exactly the failure this was
    // built to fix (see SABR-DIAGNOSTIC output for XDjB9E3YtUE).
    //
    // youtubei.js's Player.decipher() has no per-call token override — it
    // reads whatever's currently on session.player.po_token and stamps it
    // onto the URL verbatim (confirmed in node_modules/youtubei.js/dist/
    // src/core/Player.js). So the token has to be set there directly,
    // right before the call that consumes it.
    //
    // CONCURRENCY CAVEAT: session (and therefore session.player) is a
    // single object cached and shared globally per client_type across ALL
    // guilds (see innertube.js). Mutating session.player.po_token here is
    // NOT safe if two guilds are extracting simultaneously — guild A's
    // video-bound token could race into guild B's concurrent download.
    // Acceptable for this deployment (single-guild use), but if this ever
    // needs to support concurrent multi-guild playback, this needs a
    // per-download Player instance or a request-scoped token override
    // instead of mutating shared session state.
    // youtubei.js's `session` variable here is the top-level `Innertube`
    // wrapper class. Its real Session object (which holds `.player`) is a
    // PRIVATE `#session` field internally — only reachable via the public
    // `.session` getter (`get session() { return this.#session; }`,
    // confirmed directly in node_modules/youtubei.js/dist/src/
    // Innertube.js). So this is `session.session.player`, not
    // `session.player` — the latter is undefined on the wrapper and would
    // throw.
    const poToken = await getPoToken(track.videoId);
    session.session.player.po_token = poToken;

    // PHASE 1: acquire a raw webm/opus byte stream, direct-URL first,
    // falling back to SABR (googlevideo's SabrStream — see sabr.js) if
    // that fails. Two genuinely different failure shapes land here:
    //   - "No valid URL to decipher" thrown synchronously from INSIDE
    //     download() itself, before any network fetch — the chosen
    //     format has no direct url/signature_cipher/cipher at all.
    //   - An async CDN-fetch rejection (e.g. 403) surfaced through the
    //     awaited download() call, as seen in production
    //     (SABR-DIAGNOSTIC: error_type FETCH_FAILED, CDN 403).
    // Both are format/session/CDN-state failures unrelated to whether
    // SABR delivery is available for this video, so both trigger the
    // same fallback check below.
    let nodeStream;
    let usedSabr = false;
    // Only meaningful when usedSabr is true: whether the SABR-selected
    // format is Opus-coded, and therefore whether Phase 2 needs to route
    // through buildOpusPipeline() (plain WebM demux) or
    // buildTranscodedOpusPipeline() (FFmpeg decode + Opus re-encode --
    // see demuxPipeline.js and sabr.js's chooseAudioFormat()). The
    // direct-download path above always requests `format: 'webm'`
    // explicitly, so it never needs this check.
    let sabrNeedsTranscode = false;
    try {
      const webStream = await info.download({
        type: 'audio',
        format: 'webm',
        quality: 'best',
      });
      nodeStream = Readable.fromWeb(webStream);
    } catch (directErr) {
      const sd = info.streaming_data || {};
      if (!sd.server_abr_streaming_url) {
        // No SABR delivery available for this video either — genuine
        // failure, nothing left to try. Log full diagnostic and rethrow
        // the original direct-download error.
        await this._logStreamFailureDiagnostic(track, info, format, directErr);
        throw directErr;
      }

      console.warn(
        `[player:${this.guildId}] direct download failed for ${track.videoId} ` +
        `(${directErr.message}); falling back to SABR`
      );

      try {
        const clientInfo = getSabrClientInfo(session, track.isMusic ? 'YTMUSIC' : 'WEB');
        const { audioStream: sabrWebStream, format: sabrFormat, abort } = await buildSabrAudioStream(
          info,
          clientInfo,
          poToken,
          { preferredItag: format.itag }
        );
        nodeStream = Readable.fromWeb(sabrWebStream);
        usedSabr = true;
        // Set immediately, not after Phase 2 succeeds -- a failure
        // anywhere below (prebuffer, demux/transcode) still needs this
        // track's fetch loop stopped, and _playNext()'s next call
        // handles that unconditionally via _abortActiveSabr().
        this._activeAbort = abort;
        sabrNeedsTranscode = !sabrFormat.mimeType?.includes('opus');
        if (sabrNeedsTranscode) {
          console.warn(
            `[player:${this.guildId}] SABR selected a non-Opus format for ${track.videoId} ` +
            `(itag ${sabrFormat.itag}, mimeType "${sabrFormat.mimeType}"); transcoding via FFmpeg`
          );
        }
      } catch (sabrErr) {
        await this._logStreamFailureDiagnostic(track, info, format, directErr, sabrErr);
        throw sabrErr;
      }
    }

    // PHASE 2: prebuffer wiring — identical regardless of which stream
    // acquisition path succeeded above. Errors here (e.g. the acquired
    // stream itself errors mid-prebuffer) are NOT retried with the other
    // path; by this point we already have a "working" stream per
    // whichever method succeeded in Phase 1, so a failure here is a
    // genuine playback failure, not a reason to fall back again.
    let stage1 = null;

    // Permanent, not torn down after prebuffering finishes. `.pipe()`
    // does NOT forward 'error' events from source to destination -- a
    // well-known Node stream gotcha. The prebuffer-phase promise below
    // only listens with `.once()`, removed as soon as it settles, so
    // WITHOUT this, any nodeStream error occurring after the initial
    // buffering window (a mid-track network drop, a stall, or SABR's own
    // "attestation required" throw -- see isAttestationRequired() below,
    // all of which happen well into playback in practice, not up front)
    // would be a fully unhandled 'error' event, which crashes the entire
    // bot process, not just this one track. Forwarding into stage1 here
    // routes it through the exact same handling the demux/transcode
    // pipeline below already has wired for stage1 errors.
    nodeStream.on('error', (err) => {
      if (stage1 && !stage1.destroyed) stage1.destroy(err);
    });

    // TEMP DIAGNOSTIC: confirm whether nodeStream ever delivers bytes at
    // all. If total stays 0 for the whole track, the SABR/direct fetch
    // loop itself is stalling silently (no 'error' emitted) -- rules out
    // demux/prebuffer as the cause.
    let _diagBytes = 0;
    let _diagChunks = 0;
    nodeStream.on('data', (chunk) => {
      _diagBytes += chunk.length;
      _diagChunks += 1;
      if (_diagChunks === 1) {
        console.warn(`[player:${this.guildId}] DIAG first chunk for ${track.videoId}: ${chunk.length} bytes (source: ${usedSabr ? 'SABR' : 'direct'})`);
      }
    });
    nodeStream.on('end', () => {
      console.warn(`[player:${this.guildId}] DIAG stream end for ${track.videoId}: total ${_diagBytes} bytes / ${_diagChunks} chunks`);
    });
    setTimeout(() => {
      console.warn(`[player:${this.guildId}] DIAG 8s mark for ${track.videoId}: ${_diagBytes} bytes / ${_diagChunks} chunks received so far`);
    }, 8000).unref();

    let result;
    try {
      const bitrateBps = format.bitrate > 0 ? format.bitrate : config.assumedBitrateBps;
      const prebufferTargetBytes = Math.max(
        1,
        Math.ceil((bitrateBps / 8) * config.prebufferSeconds)
      );
      const networkHighWaterMark = Math.max(
        prebufferTargetBytes,
        Math.ceil((bitrateBps / 8) * (config.networkBufferMs / 1000))
      );

      // Stage 1: network buffer. Withholds output until prebufferTargetBytes
      // has accumulated (the "wait N seconds before playing" gate), then
      // keeps buffering up to networkHighWaterMark on an ongoing basis to
      // smooth CDN jitter for the rest of the track.
      stage1 = new PrebufferTransform({
        targetBytes: prebufferTargetBytes,
        highWaterMark: networkHighWaterMark,
      });

      const prebufferedPromise = new Promise((resolve, reject) => {
        const onPrebuffered = () => {
          cleanup();
          resolve({ timedOut: false });
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve({ timedOut: true });
        }, config.prebufferTimeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          stage1.off('prebuffered', onPrebuffered);
          stage1.off('error', onError);
        };
        stage1.once('prebuffered', onPrebuffered);
        stage1.once('error', onError);
      });

      nodeStream.pipe(stage1);

      result = await prebufferedPromise;
    } catch (err) {
      console.warn(
        `[player:${this.guildId}] prebuffer stage failed for ${track.videoId} ` +
        `(source: ${usedSabr ? 'SABR' : 'direct'}): ${describeStreamError(err, usedSabr)}`
      );
      throw err;
    }

    if (result.timedOut) {
      console.warn(
        `[player:${this.guildId}] prebuffer timed out for ${track.videoId}; starting anyway`
      );
    }

    // Stage 2 + demux: stall-buffered stream of raw Opus frames, wired
    // with explicit error propagation across every stage (see
    // demuxPipeline.js -- .pipe() alone does NOT forward 'error' events,
    // and an unhandled one here would crash the whole bot process, not
    // just fail this track).
    const buildPipeline = sabrNeedsTranscode ? buildTranscodedOpusPipeline : buildOpusPipeline;
    const opusStream = buildPipeline(stage1, {
      highWaterMark: config.stallBufferFrames,
      onError: (err, { firstBytes }) => {
        const hex = firstBytes ? firstBytes.toString('hex') : '(no data received before failure)';
        console.error(
          `[player:${this.guildId}] ${sabrNeedsTranscode ? 'transcode' : 'demux'} pipeline error ` +
          `for ${track.videoId} (source: ${usedSabr ? 'SABR' : 'direct'}): ${describeStreamError(err, usedSabr)}\n` +
          `  first bytes received: ${hex}`
        );
      },
    });

    return createAudioResource(opusStream, {
      inputType: StreamType.Opus,
      metadata: track,
    });
  }
}

class PlayerManager {
  constructor(queueManager) {
    this.queueManager = queueManager;
    /** @type {Map<string, GuildPlayer>} */
    this.players = new Map();
  }

  get(guildId) {
    if (!this.players.has(guildId)) {
      this.players.set(guildId, new GuildPlayer(guildId, this.queueManager.get(guildId)));
    }
    return this.players.get(guildId);
  }

  has(guildId) {
    return this.players.has(guildId);
  }

  delete(guildId) {
    const player = this.players.get(guildId);
    player?.disconnect();
    this.players.delete(guildId);
    this.queueManager.delete(guildId);
  }
}

module.exports = { PlayerManager, GuildPlayer };
