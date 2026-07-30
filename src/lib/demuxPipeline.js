'use strict';

const { PassThrough } = require('node:stream');
const prism = require('prism-media');

/**
 * Wires a raw webm/opus byte stream through prism-media's WebmDemuxer into
 * a stall-buffered, object-mode stream of raw Opus frames -- the exact
 * shape @discordjs/voice's StreamType.Opus expects.
 *
 * WHY THIS EXISTS AS ITS OWN FUNCTION: `.pipe()` does NOT forward 'error'
 * events between piped streams -- a well-known Node.js pitfall (each
 * stream is its own EventEmitter; piping only forwards data/end, never
 * error). A naive `a.pipe(b).pipe(c)` chain leaves any error thrown by an
 * intermediate stream (e.g. the demuxer rejecting a malformed container)
 * completely unhandled, which Node treats as fatal by default -- if
 * nothing else in the process has a top-level 'uncaughtException'
 * handler (index.js doesn't), that crashes the whole bot over one bad
 * track. Centralizing the wiring here, with an explicit error listener on
 * every stage, is the fix.
 *
 * @discordjs/voice listens for 'error' specifically on the exact stream
 * instance passed to createAudioResource (confirmed in node_modules/
 * @discordjs/voice/dist/index.js: `resource.playStream.once('error', ...)`)
 * -- that's the stream this function returns -- so forwarding failures
 * onto it via destroy(err) is what actually plugs into @discordjs/voice's
 * own recovery path (its AudioPlayer 'error' event).
 *
 * @param {import('node:stream').Readable} byteStream - raw webm/opus bytes
 * @param {object} [opts]
 * @param {number} [opts.highWaterMark] - object-mode buffer depth for the
 *   returned stream (frame count, not bytes).
 * @param {(err: Error, ctx: { firstBytes: Buffer | null }) => void} [opts.onError]
 *   Called once per failure, before the error is forwarded onto the
 *   returned stream. `firstBytes` is up to the first 32 bytes actually
 *   received (or null if none arrived before the failure) -- useful for
 *   diagnosing e.g. "Did not find the EBML tag at the start of the
 *   stream" (prism-media's WebmBaseDemuxer requires the EBML magic bytes
 *   1a 45 df a3 to be the very first bytes it sees; confirmed against
 *   installed source: node_modules/prism-media/src/core/WebmBase.js).
 * @returns {import('node:stream').PassThrough} object-mode stream of
 *   individual raw Opus frames (Buffers), ready for
 *   createAudioResource(stream, { inputType: StreamType.Opus }).
 */
function buildOpusPipeline(byteStream, { highWaterMark = 10, onError } = {}) {
  const stage2 = new PassThrough({ objectMode: true, highWaterMark });

  // Diagnostic-only tap: an extra listener on byteStream's own 'data'
  // event, not a separate PassThrough stage. A Readable dispatches 'data'
  // to every attached listener regardless of how many there are, and
  // .pipe() below adds its own listener the same way -- so this doesn't
  // change what bytes reach the demuxer or add a buffering hop, it just
  // observes. (Previously this went through its own PassThrough purely to
  // get a 'data' handle on it, which cost a full extra stream stage --
  // object churn, an extra highWaterMark buffer, and one more backpressure
  // hop -- for every track played, for no reason other than needing
  // *a* stream to listen on.)
  let firstBytesSeen = null;
  byteStream.on('data', (chunk) => {
    if (firstBytesSeen === null) firstBytesSeen = chunk.subarray(0, 32);
  });

  const demuxer = new prism.opus.WebmDemuxer();

  let handled = false;
  const handleError = (err) => {
    if (handled) return;
    handled = true;
    onError?.(err, { firstBytes: firstBytesSeen });
    if (!stage2.destroyed) stage2.destroy(err);
  };
  byteStream.on('error', handleError);
  demuxer.on('error', handleError);
  // Guarantees 'error' is never unhandled on stage2 regardless of when
  // (or whether) a downstream consumer like @discordjs/voice attaches its
  // own listener -- see the file-level comment above.
  stage2.on('error', () => {});

  byteStream.pipe(demuxer).pipe(stage2);
  return stage2;
}

/**
 * Wires a raw, non-WebM/Opus byte stream (e.g. the fragmented-MP4/AAC audio
 * SABR increasingly hands back when a video has no Opus-coded SABR format
 * at all — see chooseAudioFormat()'s bitrate-only fallback in sabr.js)
 * through an FFmpeg decode + Opus re-encode, into the same object-mode
 * stream-of-raw-Opus-frames shape buildOpusPipeline() produces. This is the
 * one place in the pipeline that needs an actual transcode, and it exists
 * specifically because prism-media's WebmDemuxer only ever DEMUXES an
 * already-Opus payload out of a WebM container — it has no decoder, so it
 * cannot do anything with AAC.
 *
 * FFmpeg -> raw PCM (s16le/48kHz/stereo) -> prism.opus.Encoder is the
 * standard @discordjs/voice transcode chain (see prism-media's own
 * core/FFmpeg.js JSDoc example) rather than asking FFmpeg to emit Opus
 * packets itself: FFmpeg's own Opus muxer output is Ogg-wrapped, and
 * prism-media has no Ogg *demuxer* built for arbitrary Ogg (only the
 * narrower opus.OggDemuxer used elsewhere for pre-packaged Ogg/Opus
 * files), so re-encoding via prism.opus.Encoder is the path actually
 * wired end to end here (confirmed working against a real AAC fixture,
 * see test/demuxPipeline.test.js).
 *
 * Requires `ffmpeg-static` (prism.FFmpeg auto-detects it — confirmed in
 * installed source: node_modules/prism-media/src/core/FFmpeg.js,
 * `getInfo()`'s first candidate is `require('ffmpeg-static')`, so no
 * explicit binary path wiring is needed here) and `opusscript` (pure-JS
 * Opus encoder — no native build step, since @discordjs/opus would need a
 * C++ toolchain in the Docker image this project deliberately keeps
 * minimal).
 *
 * @param {import('node:stream').Readable} byteStream - raw compressed
 *   audio bytes in whatever container SABR handed back (e.g. fMP4/AAC).
 * @param {object} [opts]
 * @param {number} [opts.highWaterMark] - object-mode buffer depth for the
 *   returned stream (frame count, not bytes).
 * @param {(err: Error, ctx: { firstBytes: Buffer | null }) => void} [opts.onError]
 *   Same contract as buildOpusPipeline()'s onError.
 * @returns {import('node:stream').PassThrough} object-mode stream of
 *   individual raw Opus frames (Buffers), ready for
 *   createAudioResource(stream, { inputType: StreamType.Opus }).
 */
function buildTranscodedOpusPipeline(byteStream, { highWaterMark = 10, onError } = {}) {
  const stage2 = new PassThrough({ objectMode: true, highWaterMark });

  let firstBytesSeen = null;
  byteStream.on('data', (chunk) => {
    if (firstBytesSeen === null) firstBytesSeen = chunk.subarray(0, 32);
  });

  let handled = false;
  const handleError = (err) => {
    if (handled) return;
    handled = true;
    onError?.(err, { firstBytes: firstBytesSeen });
    if (!stage2.destroyed) stage2.destroy(err);
  };

  let ffmpeg;
  let encoder;
  let stderrTail = '';
  try {
    // No explicit `-f`/`-i` on the input side -- FFmpeg probes the
    // container from the piped bytes themselves (confirmed against the
    // AAC fixture: works without a format hint), and prism.FFmpeg's
    // create() auto-prepends `-i -` when `-i` is absent from `args`.
    ffmpeg = new prism.FFmpeg({
      args: [
        '-analyzeduration', '0',
        '-loglevel', 'warning',
        '-ar', '48000',
        '-ac', '2',
        '-f', 's16le',
      ],
    });
    // FFmpeg's actual decode diagnostics (unsupported codec, corrupt
    // stream, DRM'd content, etc.) only ever go to its stderr --
    // prism-media's Duplex wrapper (core/FFmpeg.js) never surfaces them,
    // and never surfaces the child process's exit code either (confirmed
    // against installed source). Captured here, bounded, so the
    // zero-frame check below can report *why* instead of just "no
    // output". `ffmpeg.process` is the real ChildProcess, exposed as a
    // public property on prism's FFmpeg class.
    ffmpeg.process?.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    encoder = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  } catch (err) {
    // Synchronous construction failure -- e.g. FFmpeg.getInfo() throwing
    // "FFmpeg/avconv not found!" if ffmpeg-static's binary is missing or
    // fails its own postinstall download (see Dockerfile's build-time
    // smoke test for this). Without this try/catch, that throw would
    // propagate straight out of buildTranscodedOpusPipeline() itself,
    // before any of the error listeners below exist to catch it --
    // unlike every other failure mode in this pipeline. Deferred via
    // queueMicrotask so callers can rely on a single failure path
    // (onError / the returned stream's 'error' event) regardless of
    // whether the failure was sync or async.
    queueMicrotask(() => handleError(err));
    return stage2;
  }

  // FFmpeg does not propagate its child process's exit code as a stream
  // 'error' -- confirmed by direct test: unparseable/corrupt input makes
  // it exit non-zero but end its stdout cleanly with zero bytes, which
  // prism-media's Duplex wrapper reports as an ordinary, successful end.
  // Zero Opus frames is never a legitimate result for a real audio
  // track, so it's treated as an error here explicitly rather than
  // silently handing createAudioResource an empty/finished stream (which
  // would just play nothing, with no log explaining why).
  let frameCount = 0;
  encoder.on('data', () => { frameCount++; });
  encoder.on('end', () => {
    if (frameCount === 0 && !handled) {
      handleError(new Error(
        `FFmpeg produced no audio output (0 frames) -- likely corrupt, unsupported, or ` +
        `DRM-protected input. ffmpeg stderr: ${stderrTail.trim() || '(empty)'}`
      ));
    }
  });

  byteStream.on('error', handleError);
  ffmpeg.on('error', handleError);
  encoder.on('error', handleError);
  // See buildOpusPipeline() above for why this no-op listener is required.
  stage2.on('error', () => {});

  byteStream.pipe(ffmpeg).pipe(encoder).pipe(stage2);
  return stage2;
}

module.exports = { buildOpusPipeline, buildTranscodedOpusPipeline };
