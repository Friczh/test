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
  ReloadPlaybackContext,
  VideoPlaybackAbrRequest,
  UMPPartId,
} = require('googlevideo/protos');
const { concatenateChunks, EnabledTrackTypes } = require('googlevideo/utils');

const { buildOpusPipeline, buildTranscodedOpusPipeline } = require('../src/lib/demuxPipeline');
const { buildSabrAudioStream, chooseAudioFormat } = require('../src/lib/sabr');
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'tone.webm');

const CLIENT_INFO = { clientName: 1, clientVersion: '2.20240101.00.00' };

// Unlike sabr.test.js's guard-clause tests, the AAC e2e test below has a
// fully valid streaming_data, so it genuinely reaches deriveSabrParams()'s
// decipher() call -- this needs a real (mock) session.session.player, not
// a dummy. Identity function: the fixture URL isn't actually n-sig
// ciphered, so nothing to transform.
const MOCK_SESSION = { session: { player: { decipher: async (url) => url } } };

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
    ({ audioStream, format } = await buildSabrAudioStream(info, MOCK_SESSION, CLIENT_INFO, 'abc'));
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

test('SABR e2e: buildSabrAudioStream survives a mid-stream RELOAD_PLAYER_RESPONSE by reconnecting, producing the byte-identical file with no error surfaced to the caller', async () => {
  // Models the real production failure this fix addresses: the server
  // sends RELOAD_PLAYER_RESPONSE for every request from some point
  // onward (session invalidated), SabrStream's internal retry
  // (executeWithRetry) burns through SABR_MAX_RETRIES attempts all
  // hitting the same reload, then throws -- and buildSabrAudioStream's
  // relay loop must catch that, refetch `info`, and reconnect using the
  // state captured in the 'reloadPlayerResponse' listener, splicing into
  // the SAME output stream so the caller (player.js) never sees an
  // error.
  //
  // One shared mutable "server" (segment index/position) backs BOTH the
  // pre-reload and post-reconnect requests, exactly like a real YouTube
  // CDN would be a single continuous source across the reload boundary
  // -- this is what lets the reassembled output be asserted byte-perfect
  // against the source fixture, not just "didn't throw".
  const fileBuffer = fs.readFileSync(FIXTURE_PATH);
  const audioFormat = makeAudioFormat(fileBuffer.length);
  const initSize = 1500;
  const segmentSize = 1800;
  const initBytes = fileBuffer.subarray(0, initSize);
  const restBytes = fileBuffer.subarray(initSize);
  const mediaSegments = [];
  for (let i = 0; i < restBytes.length; i += segmentSize) {
    mediaSegments.push(restBytes.subarray(i, i + segmentSize));
  }
  assert.ok(mediaSegments.length >= 2, 'fixture must split into at least 2 media segments for this test to be meaningful');

  let nextSegmentIndex = 0;
  let startMs = 0;
  let startRange = initSize;
  // SABR_MAX_RETRIES is 3 in sabr.js -> executeWithRetry makes 4 total
  // attempts per segment fetch before giving up. Reload on all 4 so
  // retries are genuinely exhausted (not just "recovers on its own"),
  // which is the scenario that used to end the track early.
  let reloadResponsesSent = 0;
  const RELOAD_COUNT = 4;

  const fetchFn = async (_url, options) => {
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
      // AUDIO_ONLY discards the video track's actual bytes (formatToDiscard
      // skips it from validateDownloadedSegments), but SabrStream#restoreState()
      // still requires BOTH the video and audio format keys to be present
      // in a resumed state's initializedFormats, or it rejects the whole
      // resume and falls back to a cold restart -- confirmed against
      // installed source. Registering the video format here (no actual
      // media bytes needed for it) is what lets the post-reload reconnect
      // below genuinely resume mid-track instead of silently restarting.
      parts.push(part(UMPPartId.FORMAT_INITIALIZATION_METADATA, FormatInitializationMetadata.encode({
        formatId: VIDEO_FORMAT,
        durationUnits: '1000',
        durationTimescale: '1000',
        endSegmentNumber: '0',
        mimeType: VIDEO_FORMAT.mimeType,
        endTimeMs: '1000',
        videoId: '',
      }).finish()));
      parts.push(mediaHeaderPart(0, 0, 0, 0, 0, initBytes.length, true, audioFormat));
      parts.push(mediaPart(0, initBytes));
      parts.push(mediaEndPart(0));
    } else if (reloadResponsesSent < RELOAD_COUNT) {
      // Reload every request past the init one, until exhausted -- does
      // NOT touch nextSegmentIndex/startMs/startRange, so once reloading
      // stops, the next real request picks up exactly where the last
      // successfully-downloaded segment left off.
      reloadResponsesSent++;
      parts.push(part(UMPPartId.RELOAD_PLAYER_RESPONSE, ReloadPlaybackContext.encode({
        reloadPlaybackParams: { token: 'test-reload-token' },
      }).finish()));
      const buffer = new CompositeBuffer();
      const writer = new UmpWriter(buffer);
      for (const p of parts) writer.write(p.partType, p.partData);
      return new Response(concatenateChunks(buffer.chunks), {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.yt-ump' },
      });
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

  const info = {
    streaming_data: {
      server_abr_streaming_url: 'https://test.invalid/sabr-reload',
      adaptive_formats: [VIDEO_FORMAT, audioFormat],
    },
    player_config: {
      media_common_config: {
        media_ustreamer_request_config: { video_playback_ustreamer_config: 'abc' },
      },
    },
  };
  // refetchInfo returns the same info -- in production this re-derives
  // from a real re-fetched player response, but the mock server here is
  // keyed by URL/segment position, not by which `info` object was passed,
  // so returning the identical object is a faithful enough stand-in for
  // "get a fresh, valid player response for the same track".
  const refetchInfo = async () => info;

  // Mock fetch must stay installed through the ENTIRE read loop below, not
  // just the initial buildSabrAudioStream() call -- the reload-triggered
  // reconnect happens lazily inside the relay ReadableStream's pull(),
  // i.e. while the caller is draining the stream, well after
  // buildSabrAudioStream() itself has already returned.
  const originalFetch = global.fetch;
  global.fetch = fetchFn;
  let audioStream;
  let format;
  let reassembled;
  try {
    ({ audioStream, format } = await buildSabrAudioStream(
      info,
      MOCK_SESSION,
      CLIENT_INFO,
      'abc',
      { refetchInfo }
    ));

    assert.equal(format.itag, audioFormat.itag);

    const reader = audioStream.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    reassembled = Buffer.concat(chunks);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(reassembled.length, fileBuffer.length, 'reconnected stream must still deliver the complete file');
  assert.ok(reassembled.equals(fileBuffer), 'bytes across the reload boundary must reassemble identically to the source file');
  assert.equal(reloadResponsesSent, RELOAD_COUNT, 'sanity check: the mock must have actually exhausted all retry attempts with reloads');
});

test('SABR e2e: buildSabrAudioStream survives a stale PO token (STREAM_PROTECTION_STATUS attestation-pending -> "No media parts" exhaustion) by re-minting the token and reconnecting', async () => {
  const fileBuffer = fs.readFileSync(FIXTURE_PATH);
  const audioFormat = makeAudioFormat(fileBuffer.length);
  const initSize = 1500;
  const segmentSize = 1800;
  const initBytes = fileBuffer.subarray(0, initSize);
  const restBytes = fileBuffer.subarray(initSize);
  const mediaSegments = [];
  for (let i = 0; i < restBytes.length; i += segmentSize) {
    mediaSegments.push(restBytes.subarray(i, i + segmentSize));
  }
  assert.ok(mediaSegments.length >= 2, 'fixture must split into at least 2 media segments for this test to be meaningful');

  let nextSegmentIndex = 0;
  let startMs = 0;
  let startRange = initSize;
  let starvedResponsesSent = 0;
  const STARVE_COUNT = 4;
  let sawStatusTwo = false;

  const fetchFn = async (_url, options) => {
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
      parts.push(part(UMPPartId.FORMAT_INITIALIZATION_METADATA, FormatInitializationMetadata.encode({
        formatId: VIDEO_FORMAT,
        durationUnits: '1000',
        durationTimescale: '1000',
        endSegmentNumber: '0',
        mimeType: VIDEO_FORMAT.mimeType,
        endTimeMs: '1000',
        videoId: '',
      }).finish()));
      parts.push(mediaHeaderPart(0, 0, 0, 0, 0, initBytes.length, true, audioFormat));
      parts.push(mediaPart(0, initBytes));
      parts.push(mediaEndPart(0));
    } else if (starvedResponsesSent < STARVE_COUNT) {
      starvedResponsesSent++;
      sawStatusTwo = true;
      parts.push(part(UMPPartId.STREAM_PROTECTION_STATUS, StreamProtectionStatus.encode({ status: 2 }).finish()));
      const buffer = new CompositeBuffer();
      const writer = new UmpWriter(buffer);
      for (const p of parts) writer.write(p.partType, p.partData);
      return new Response(concatenateChunks(buffer.chunks), {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.yt-ump' },
      });
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

  const info = {
    streaming_data: {
      server_abr_streaming_url: 'https://test.invalid/sabr-stale-token',
      adaptive_formats: [VIDEO_FORMAT, audioFormat],
    },
    player_config: {
      media_common_config: {
        media_ustreamer_request_config: { video_playback_ustreamer_config: 'abc' },
      },
    },
  };
  const refetchInfo = async () => info;
  let refetchPoTokenCalls = 0;
  const refetchPoToken = async () => {
    refetchPoTokenCalls++;
    return 'fresh-po-token';
  };

  const originalFetch = global.fetch;
  global.fetch = fetchFn;
  let audioStream;
  let format;
  let reassembled;
  try {
    ({ audioStream, format } = await buildSabrAudioStream(
      info,
      MOCK_SESSION,
      CLIENT_INFO,
      'stale-po-token',
      { refetchInfo, refetchPoToken }
    ));

    assert.equal(format.itag, audioFormat.itag);

    const reader = audioStream.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    reassembled = Buffer.concat(chunks);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(reassembled.length, fileBuffer.length, 'reconnected stream must still deliver the complete file');
  assert.ok(reassembled.equals(fileBuffer), 'bytes across the token-refresh boundary must reassemble identically to the source file');
  assert.ok(sawStatusTwo, 'sanity check: the mock must have actually sent an attestation-pending status');
  assert.equal(starvedResponsesSent, STARVE_COUNT, 'sanity check: the mock must have exhausted all retry attempts while starved of media');
  assert.equal(refetchPoTokenCalls, 1, 'refetchPoToken must be called exactly once to recover from the stale token');
});
