'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { buildOpusPipeline, buildTranscodedOpusPipeline } = require('../src/lib/demuxPipeline');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'tone.webm');

// Splits a Buffer into small pieces to simulate real network chunking
// (rather than handing the whole file to the stream in one shot, which
// would hide any chunk-boundary bugs).
function chunked(buffer, size) {
  const chunks = [];
  for (let i = 0; i < buffer.length; i += size) {
    chunks.push(buffer.subarray(i, i + size));
  }
  return chunks;
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const items = [];
    stream.on('data', (item) => items.push(item));
    stream.on('end', () => resolve(items));
    stream.on('error', reject);
  });
}

test('buildOpusPipeline: a real webm/opus fixture demuxes into individual Opus frames', async () => {
  const fileBuffer = fs.readFileSync(FIXTURE_PATH);
  // 512-byte chunks -- deliberately smaller than a single WebM Cluster, to
  // exercise the demuxer's cross-chunk reassembly (WebmBase._remainder).
  const source = Readable.from(chunked(fileBuffer, 512));

  let sawError = false;
  const opusStream = buildOpusPipeline(source, {
    onError: () => { sawError = true; },
  });

  const frames = await readAll(opusStream);

  assert.equal(sawError, false);
  assert.equal(frames.length, 50); // matches the direct prism-media check
  for (const frame of frames) {
    assert.ok(Buffer.isBuffer(frame));
    assert.ok(frame.length > 0);
  }
});

test('buildOpusPipeline: non-WebM input triggers onError with the EBML diagnostic, and does not crash the process', async () => {
  // This is the exact fix under test: prism-media's WebmDemuxer throws
  // synchronously when the stream doesn't start with EBML magic bytes,
  // and .pipe() does not forward 'error' events between piped streams --
  // so if buildOpusPipeline's explicit listeners weren't wired correctly,
  // this would surface as an *unhandled* 'error' event and crash the
  // entire test process (node:test runs in-process), not just fail an
  // assertion. The fact that this test can even complete and make
  // assertions is itself evidence the fix works.
  const garbage = Buffer.from('this is definitely not a webm container, just plain text bytes');
  const source = Readable.from([garbage]);

  const result = await new Promise((resolve) => {
    let capturedErr = null;
    let capturedFirstBytes = null;
    const opusStream = buildOpusPipeline(source, {
      onError: (err, { firstBytes }) => {
        capturedErr = err;
        capturedFirstBytes = firstBytes;
      },
    });
    opusStream.on('error', () => {
      // Expected: the pipeline forwards the failure here too (this is
      // exactly the event @discordjs/voice listens for in production).
      resolve({ capturedErr, capturedFirstBytes });
    });
    // Safety net so the test can't hang forever if wiring regresses.
    setTimeout(() => resolve({ capturedErr, capturedFirstBytes, timedOut: true }), 2000);
  });

  assert.ok(!result.timedOut, 'buildOpusPipeline never surfaced an error event (possible regression)');
  assert.ok(result.capturedErr, 'onError callback was never called');
  assert.match(result.capturedErr.message, /EBML/i);
  assert.ok(Buffer.isBuffer(result.capturedFirstBytes));
  assert.equal(result.capturedFirstBytes.toString(), garbage.subarray(0, 32).toString());
});

test('buildOpusPipeline: source stream error is forwarded, not left unhandled', async () => {
  const source = new Readable({ read() {} });

  const result = await new Promise((resolve) => {
    let capturedErr = null;
    const opusStream = buildOpusPipeline(source, {
      onError: (err) => { capturedErr = err; },
    });
    opusStream.on('error', () => resolve({ capturedErr }));
    setTimeout(() => resolve({ capturedErr, timedOut: true }), 2000);

    source.emit('error', new Error('simulated network failure'));
  });

  assert.ok(!result.timedOut, 'source error never propagated (possible regression)');
  assert.equal(result.capturedErr.message, 'simulated network failure');
});

test('buildOpusPipeline: a real but WRONG-container file (mp4/AAC, simulating a format-selection mismatch) is rejected cleanly, not silently played as garbage', async () => {
  // Guards the other half of the itag-consistency fix in sabr.js: if
  // format selection ever again picks a non-WebM candidate, this proves
  // the failure mode is a clean, diagnosable error -- not silent noise
  // fed to Discord.
  const fileBuffer = fs.readFileSync(path.join(__dirname, 'fixtures', 'tone_aac.m4a'));
  const source = Readable.from([fileBuffer]);

  const result = await new Promise((resolve) => {
    let capturedErr = null;
    const opusStream = buildOpusPipeline(source, {
      onError: (err) => { capturedErr = err; },
    });
    opusStream.on('error', () => resolve({ capturedErr }));
    opusStream.on('end', () => resolve({ capturedErr, endedWithoutError: true }));
    setTimeout(() => resolve({ capturedErr, timedOut: true }), 2000);
  });

  assert.ok(!result.timedOut, 'pipeline hung on a wrong-container file (possible regression)');
  assert.ok(!result.endedWithoutError, 'an MP4/AAC file must not be silently accepted as valid WebM/Opus');
  assert.ok(result.capturedErr, 'onError callback was never called');
  assert.match(result.capturedErr.message, /EBML/i);
});

test('buildOpusPipeline: valid WebM but Vorbis (not Opus) codec -- e.g. a pre-Opus-era YouTube upload -- is rejected cleanly, not silently played as noise', async () => {
  // Distinct from the EBML/container tests above: this is a well-formed
  // WebM file (real EBML header, real Tracks element) but the audio
  // codec inside it is Vorbis, not Opus. prism-media's opus.WebmDemuxer
  // validates the CodecPrivate "OpusHead" magic and throws a DIFFERENT
  // error for this case (confirmed in node_modules/prism-media/src/opus/
  // WebmDemuxer.js: `throw Error('Audio codec is not Opus!')`) -- via the
  // exact same throw-inside-_readTag path as the EBML check, so it's
  // subject to the identical unhandled-'error'-crashes-the-process risk
  // this whole pipeline exists to guard against.
  const fileBuffer = fs.readFileSync(path.join(__dirname, 'fixtures', 'tone_vorbis.webm'));
  const source = Readable.from([fileBuffer]);

  const result = await new Promise((resolve) => {
    let capturedErr = null;
    const opusStream = buildOpusPipeline(source, {
      onError: (err) => { capturedErr = err; },
    });
    opusStream.on('error', () => resolve({ capturedErr }));
    opusStream.on('end', () => resolve({ capturedErr, endedWithoutError: true }));
    setTimeout(() => resolve({ capturedErr, timedOut: true }), 2000);
  });

  assert.ok(!result.timedOut, 'pipeline hung on a Vorbis-codec WebM file (possible regression)');
  assert.ok(!result.endedWithoutError, 'a Vorbis track must not be silently accepted as Opus');
  assert.ok(result.capturedErr, 'onError callback was never called');
  assert.match(result.capturedErr.message, /not Opus/i);
});

test('buildTranscodedOpusPipeline: a real AAC/m4a fixture transcodes into individual Opus frames', async () => {
  const fileBuffer = fs.readFileSync(path.join(__dirname, 'fixtures', 'tone_aac.m4a'));
  const source = Readable.from(chunked(fileBuffer, 512));

  let sawError = false;
  const opusStream = buildTranscodedOpusPipeline(source, {
    onError: () => { sawError = true; },
  });

  const frames = await readAll(opusStream);

  assert.equal(sawError, false);
  assert.ok(frames.length > 0, 'FFmpeg->Opus transcode must produce at least one frame from a real AAC fixture');
  for (const frame of frames) {
    assert.ok(Buffer.isBuffer(frame));
    assert.ok(frame.length > 0);
  }
});

test('buildTranscodedOpusPipeline: unparseable garbage input surfaces as an explicit error, not a silent empty stream', async () => {
  // FFmpeg itself does not surface its child process's non-zero exit
  // code as a stream 'error' -- confirmed directly against installed
  // source (node_modules/prism-media/src/core/FFmpeg.js: only stdin/
  // stdout stream-level errors are forwarded, never the exit code). Left
  // alone, that means genuinely corrupt/unparseable input would silently
  // hand createAudioResource an empty, "successfully" ended stream, with
  // no log explaining why nothing played. buildTranscodedOpusPipeline()
  // guards against this itself: zero Opus frames out is never a
  // legitimate transcode result, so it's turned into an explicit error.
  const garbage = Buffer.from('this is definitely not any audio container, just plain text bytes');
  const source = Readable.from([garbage]);

  const result = await new Promise((resolve) => {
    let capturedErr = null;
    const frames = [];
    const opusStream = buildTranscodedOpusPipeline(source, {
      onError: (err) => { capturedErr = err; },
    });
    opusStream.on('data', (frame) => frames.push(frame));
    opusStream.on('error', () => resolve({ capturedErr, frames }));
    opusStream.on('end', () => resolve({ capturedErr, frames, ended: true }));
    setTimeout(() => resolve({ capturedErr, frames, timedOut: true }), 5000);
  });

  assert.ok(!result.timedOut, 'transcode pipeline hung on garbage input (possible regression)');
  assert.equal(result.frames.length, 0, 'garbage input must not produce fabricated audio frames');
  assert.ok(result.capturedErr, 'onError callback must fire for a zero-frame transcode result');
  assert.match(result.capturedErr.message, /no audio output/i);
});

test('buildTranscodedOpusPipeline: a synchronous FFmpeg construction failure (e.g. binary missing) is routed through onError, not thrown out of the function', async () => {
  // Confirmed against installed source: `new prism.FFmpeg()` calls
  // FFmpeg.getInfo() synchronously, which throws "FFmpeg/avconv not
  // found!" directly (not via an event) if no usable binary is found.
  // Stubbing prism.FFmpeg to throw reproduces that exact failure shape
  // without needing to actually break the installed ffmpeg-static binary.
  const prism = require('prism-media');
  const originalFFmpeg = prism.FFmpeg;
  prism.FFmpeg = class {
    constructor() { throw new Error('FFmpeg/avconv not found!'); }
  };

  try {
    const source = Readable.from([Buffer.from('irrelevant')]);
    let capturedErr = null;
    const opusStream = buildTranscodedOpusPipeline(source, {
      onError: (err) => { capturedErr = err; },
    });

    const result = await new Promise((resolve) => {
      opusStream.on('error', () => resolve({ capturedErr }));
      setTimeout(() => resolve({ capturedErr, timedOut: true }), 2000);
    });

    assert.ok(!result.timedOut, 'construction failure was never surfaced as an error on the returned stream');
    assert.ok(result.capturedErr, 'onError callback must fire for a synchronous construction failure');
    assert.match(result.capturedErr.message, /FFmpeg\/avconv not found/);
  } finally {
    prism.FFmpeg = originalFFmpeg;
  }
});
