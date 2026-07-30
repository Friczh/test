'use strict';

// This is the one thing static source review can't prove: that the SABR
// client (googlevideo's SabrStream) hands buildOpusPipeline() bytes it can
// actually demux and play. This sandbox has no network access to
// youtube.com/googlevideo.com to test that against a live video, so this
// gets as close as possible instead:
//
//   1. Use the REAL, installed SabrStream class -- not a stub. It still
//      runs its actual UMP-part handling, format-initialization tracking,
//      sequential playerTimeMs loop, and segment reassembly logic.
//   2. Inject a mock `fetch` (SabrStream accepts one via its `fetch`
//      config option -- confirmed in node_modules/googlevideo/dist/src/
//      core/SabrStream.js: `this.fetchFunction = config?.fetch || fetch`,
//      and this is exactly the seam the library's own upstream test suite
//      uses at github.com/LuanRT/GoogleVideo/blob/main/tests/
//      sabr.stream.test.ts) that serves real WebM/opus bytes -- an
//      ffmpeg-generated fixture, not zero-filled dummy data -- split
//      across a realistic init-segment-then-media-segments sequence, UMP
//      part-encoded with the library's own real protobuf definitions.
//   3. Feed SabrStream's real output through the actual production
//      buildOpusPipeline() (src/lib/demuxPipeline.js) and confirm it
//      demuxes into the same Opus frames a direct download of the
//      identical file would produce.
//
// What this proves: SabrStream's segment reassembly is byte-perfect, and
// the resulting stream is genuinely demuxable by prism-media's
// WebmDemuxer end-to-end through this project's actual pipeline code.
// What this does NOT prove: behavior of a real YouTube server response
// (real timing/backoff/retry edge cases, or a video where the selected
// itag's container turns out not to be WebM at all -- see chooseAudioFormat
// in sabr.js for the mitigation there). That still needs a live run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const { SabrStream } = require('googlevideo/sabr-stream');
const { CompositeBuffer, UmpWriter } = require('googlevideo/ump');
const {
  MediaHeader,
  FormatInitializationMetadata,
  NextRequestPolicy,
  StreamProtectionStatus,
  VideoPlaybackAbrRequest,
  UMPPartId,
} = require('googlevideo/protos');
const { concatenateChunks, EnabledTrackTypes } = require('googlevideo/utils');

const { buildOpusPipeline, buildTranscodedOpusPipeline } = require('../src/lib/demuxPipeline');
const { buildSabrAudioStream, chooseAudioFormat } = require('../src/lib/sabr');
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'tone.webm');

const CLIENT_INFO = { clientName: 1, clientVersion: '2.20240101.00.00' };

function makeAudioFormat(contentLength) {
  return {
    itag: 251,
    lastModified: '1700000000',
    contentLength,
    mimeType: 'audio/webm; codecs="opus"',
    bitrate: 64000,
    approxDurationMs: 1000,
  };
}

const VIDEO_FORMAT = {
  itag: 137,
  mimeType: 'video/mp4; codecs="avc1.640028"',
  bitrate: 4337000,
  lastModified: '1700000000',
  height: 1080,
  approxDurationMs: 1000,
};

function part(partType, partData) {
  return { partType, partData };
}

function mediaHeaderPart(headerId, sequenceNumber, startMs, durationMs, startRange, contentLength, isInitSeg, format) {
  return part(UMPPartId.MEDIA_HEADER, MediaHeader.encode({
    headerId,
    videoId: '',
    itag: format.itag,
    lmt: format.lastModified,
    startRange: startRange.toString(),
    compressionAlgorithm: 0,
    isInitSeg,
    sequenceNumber,
    bitrateBps: format.bitrate.toString(),
    startMs: startMs.toString(),
    durationMs: durationMs.toString(),
    formatId: format,
    contentLength: contentLength.toString(),
    timeRange: { startTicks: startMs.toString(), durationTicks: durationMs.toString(), timescale: 1000 },
  }).finish());
}

function mediaPart(headerId, bytes) {
  return part(UMPPartId.MEDIA, new Uint8Array([headerId, ...bytes]));
}

function mediaEndPart(headerId) {
  return part(UMPPartId.MEDIA_END, new Uint8Array([headerId]));
}

/**
 * Builds a mock `fetch` that serves `fileBuffer` back to a real SabrStream
 * as a realistic sequence of SABR responses: format-init + init-segment on
 * the first request (playerTimeMs === 0), then one media segment per
 * subsequent request, in order, until the file is exhausted.
 */
function createMockFetch(fileBuffer, { initSize, segmentSize, audioFormat: audioFormatOverride } = {}) {
  const initBytes = fileBuffer.subarray(0, initSize);
  const restBytes = fileBuffer.subarray(initSize);
  const mediaSegments = [];
  for (let i = 0; i < restBytes.length; i += segmentSize) {
    mediaSegments.push(restBytes.subarray(i, i + segmentSize));
  }
  const audioFormat = audioFormatOverride || makeAudioFormat(fileBuffer.length);

  let nextSegmentIndex = 0;
  let startMs = 0;
  let startRange = initSize;
  let requestCount = 0;

  const fetchFn = async (_url, options) => {
    requestCount++;
    const bodyBytes = new Uint8Array(
      options.body instanceof ArrayBuffer ? options.body : await new Response(options.body).arrayBuffer()
    );
    const req = VideoPlaybackAbrRequest.decode(bodyBytes);
    const playerTimeMs = parseInt(req.clientAbrState?.playerTimeMs || '0');

    const parts = [];
    parts.push(part(UMPPartId.NEXT_REQUEST_POLICY, NextRequestPolicy.encode({
      targetAudioReadaheadMs: 15000,
      targetVideoReadaheadMs: 15000,
      backoffTimeMs: 0,
      playbackCookie: { resolution: 0, field2: 0, videoFmt: VIDEO_FORMAT, audioFmt: audioFormat },
      videoId: '',
    }).finish()));
    parts.push(part(UMPPartId.STREAM_PROTECTION_STATUS, StreamProtectionStatus.encode({ status: 1 }).finish()));

    if (playerTimeMs === 0) {
      parts.push(part(UMPPartId.FORMAT_INITIALIZATION_METADATA, FormatInitializationMetadata.encode({
        formatId: audioFormat,
        durationUnits: '1000',
        durationTimescale: '1000',
        endSegmentNumber: String(mediaSegments.length),
        mimeType: audioFormat.mimeType,
        endTimeMs: '1000',
        videoId: '',
      }).finish()));
      parts.push(mediaHeaderPart(0, 0, 0, 0, 0, initBytes.length, true, audioFormat));
      parts.push(mediaPart(0, initBytes));
      parts.push(mediaEndPart(0));
    }

    if (nextSegmentIndex < mediaSegments.length) {
      const seg = mediaSegments[nextSegmentIndex];
      const headerId = nextSegmentIndex + 1;
      const durationMs = Math.round(1000 / mediaSegments.length);
      parts.push(mediaHeaderPart(headerId, nextSegmentIndex + 1, startMs, durationMs, startRange, seg.length, false, audioFormat));
      parts.push(mediaPart(headerId, seg));
      parts.push(mediaEndPart(headerId));
      startMs += durationMs;
      startRange += seg.length;
      nextSegmentIndex++;
    }

    const buffer = new CompositeBuffer();
    const writer = new UmpWriter(buffer);
    for (const p of parts) writer.write(p.partType, p.partData);
    return new Response(concatenateChunks(buffer.chunks), {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.yt-ump' },
    });
  };

  return { fetchFn, audioFormat, getRequestCount: () => requestCount };
}

test('SABR e2e: real SabrStream reassembles a genuine multi-segment WebM/opus file byte-for-byte', async () => {
  const fileBuffer = fs.readFileSync(FIXTURE_PATH);
  const { fetchFn, audioFormat, getRequestCount } = createMockFetch(fileBuffer, {
    initSize: 1500,
    segmentSize: 2000,
  });

  const stream = new SabrStream({
    fetch: fetchFn,
    serverAbrStreamingUrl: 'https://test.invalid/sabr',
    videoPlaybackUstreamerConfig: 'abc',
    poToken: 'abc',
    clientInfo: CLIENT_INFO,
    formats: [VIDEO_FORMAT, audioFormat],
  });

  const { audioStream, selectedFormats } = await stream.start({
    audioFormat,
    enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
  });

  assert.equal(selectedFormats.audioFormat.itag, audioFormat.itag);

  const reader = audioStream.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  const reassembled = Buffer.concat(chunks);

  assert.equal(reassembled.length, fileBuffer.length);
  assert.ok(reassembled.equals(fileBuffer), 'SABR-reassembled bytes must match the source file exactly');
  assert.ok(getRequestCount() > 1, 'expected multiple sequential SABR requests (1 init + several media segments)');
});

test('SABR e2e: real SabrStream output demuxes through the production pipeline into the same Opus frames as a direct download', async () => {
  const fileBuffer = fs.readFileSync(FIXTURE_PATH);

  // Baseline: what direct-download-and-demux produces for this exact file.
  const directFrames = [];
  {
    const directOpusStream = buildOpusPipeline(Readable.from([fileBuffer]), {
      onError: (err) => { throw err; },
    });
    for await (const frame of directOpusStream) directFrames.push(frame);
  }
  assert.ok(directFrames.length > 0, 'sanity check: direct path must itself produce frames');

  // SABR path: same file, delivered through a real SabrStream + mock
  // network layer, then through the identical production pipeline.
  const { fetchFn, audioFormat } = createMockFetch(fileBuffer, { initSize: 1500, segmentSize: 2000 });
  const stream = new SabrStream({
    fetch: fetchFn,
    serverAbrStreamingUrl: 'https://test.invalid/sabr',
    videoPlaybackUstreamerConfig: 'abc',
    poToken: 'abc',
    clientInfo: CLIENT_INFO,
    formats: [VIDEO_FORMAT, audioFormat],
  });
  const { audioStream } = await stream.start({
    audioFormat,
    enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
  });

  let sabrPipelineError = null;
  const sabrOpusStream = buildOpusPipeline(Readable.fromWeb(audioStream), {
    onError: (err) => { sabrPipelineError = err; },
  });
  const sabrFrames = [];
  for await (const frame of sabrOpusStream) sabrFrames.push(frame);

  assert.equal(sabrPipelineError, null);
  assert.equal(sabrFrames.length, directFrames.length);
  for (let i = 0; i < directFrames.length; i++) {
    assert.ok(sabrFrames[i].equals(directFrames[i]), `frame ${i} must be byte-identical between direct and SABR paths`);
  }
});

test('SABR e2e: buildSabrAudioStream (the real production function) returns the AAC stream + format when the only SABR-eligible audio is AAC (no Opus), and the transcode pipeline plays it', async () => {
  // Answers a real question: what happens if a video's SABR-eligible
  // adaptive_formats has no Opus track at all, only AAC/mp4a? This used
  // to fail fast with an explicit "not Opus-coded" error. It no longer
  // does -- player.js now routes a non-Opus SABR result through
  // buildTranscodedOpusPipeline() (FFmpeg decode + Opus re-encode, see
  // demuxPipeline.js) instead of giving up. This confirms
  // buildSabrAudioStream() itself (the actual production function, not a
  // re-implementation) returns the stream and format cleanly for this
  // case, and that feeding its output through the real transcode
  // pipeline produces playable Opus frames.
  const aacBuffer = fs.readFileSync(path.join(__dirname, 'fixtures', 'tone_aac.m4a'));
  const aacFormat = {
    itag: 140,
    lastModified: '1700000000',
    contentLength: aacBuffer.length,
    mimeType: 'audio/mp4; codecs="mp4a.40.2"',
    bitrate: 128000,
    approxDurationMs: 1000,
  };
  const { fetchFn } = createMockFetch(aacBuffer, {
    initSize: 1000,
    segmentSize: 2000,
    audioFormat: aacFormat,
  });

  // youtubei.js-shaped `info` object -- the same field paths
  // buildSabrAudioStream reads in production (see sabr.test.js's
  // baseInfo() for the equivalent shape used in the guard-clause tests).
  const info = {
    streaming_data: {
      server_abr_streaming_url: 'https://test.invalid/sabr',
      adaptive_formats: [VIDEO_FORMAT, aacFormat],
    },
    player_config: {
      media_common_config: {
        media_ustreamer_request_config: {
          video_playback_ustreamer_config: 'abc',
        },
      },
    },
  };

  // buildSabrAudioStream() always uses the real global fetch internally
  // -- it has no fetch-override parameter of its own (that seam only
  // exists on SabrStream itself, used directly in the tests above).
  // Patching global.fetch here, restored in `finally`, is what lets this
  // test exercise the actual unmodified production code path.
  const originalFetch = global.fetch;
  global.fetch = fetchFn;
  let audioStream;
  let format;
  try {
    ({ audioStream, format } = await buildSabrAudioStream(info, CLIENT_INFO, 'abc'));
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(format.itag, aacFormat.itag);
  assert.match(format.mimeType, /mp4a/);

  let pipelineError = null;
  const opusStream = buildTranscodedOpusPipeline(Readable.fromWeb(audioStream), {
    onError: (err) => { pipelineError = err; },
  });
  const frames = [];
  for await (const frame of opusStream) frames.push(frame);

  assert.equal(pipelineError, null);
  assert.ok(frames.length > 0, 'transcode pipeline must produce at least one Opus frame from the AAC input');
  for (const frame of frames) {
    assert.ok(Buffer.isBuffer(frame));
    assert.ok(frame.length > 0);
  }
});
