'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSabrAudioStream, chooseAudioFormat } = require('../src/lib/sabr');

// These tests cover only the synchronous guard clauses in
// buildSabrAudioStream(), which run before any network call is made
// (before `new SabrStream(...).start()`). The actual segment-fetching
// loop needs a live server_abr_streaming_url and is out of scope for a
// unit test — see README for the live-verification note.

const CLIENT_INFO = { clientName: 67, clientVersion: '1.20250101.00.00' };
const PO_TOKEN = 'fake-po-token';

function baseInfo(overrides = {}) {
  return {
    streaming_data: {
      server_abr_streaming_url: 'https://example.invalid/videoplayback',
      adaptive_formats: [
        { itag: 251, mime_type: 'audio/webm; codecs="opus"', bitrate: 128000 },
        { itag: 137, mime_type: 'video/mp4; codecs="avc1"', bitrate: 500000, height: 1080 },
      ],
      ...overrides.streaming_data,
    },
    player_config: {
      media_common_config: {
        media_ustreamer_request_config: {
          video_playback_ustreamer_config: 'ZmFrZS11c3RyZWFtZXItY29uZmln',
        },
      },
      ...overrides.player_config,
    },
    ...overrides.rest,
  };
}

test('buildSabrAudioStream: throws when streaming_data has no server_abr_streaming_url', async () => {
  const info = baseInfo({ streaming_data: { server_abr_streaming_url: undefined } });
  await assert.rejects(
    () => buildSabrAudioStream(info, CLIENT_INFO, PO_TOKEN),
    /no server_abr_streaming_url/
  );
});

test('buildSabrAudioStream: throws when video_playback_ustreamer_config is missing', async () => {
  const info = baseInfo();
  info.player_config.media_common_config.media_ustreamer_request_config.video_playback_ustreamer_config = undefined;
  await assert.rejects(
    () => buildSabrAudioStream(info, CLIENT_INFO, PO_TOKEN),
    /video_playback_ustreamer_config/
  );
});

test('buildSabrAudioStream: throws when player_config itself is entirely absent', async () => {
  const info = baseInfo();
  delete info.player_config;
  await assert.rejects(
    () => buildSabrAudioStream(info, CLIENT_INFO, PO_TOKEN),
    /video_playback_ustreamer_config/
  );
});

test('buildSabrAudioStream: throws when adaptive_formats has no video-type candidate', async () => {
  const info = baseInfo({
    streaming_data: {
      adaptive_formats: [
        { itag: 251, mime_type: 'audio/webm; codecs="opus"', bitrate: 128000 },
      ],
    },
  });
  await assert.rejects(
    () => buildSabrAudioStream(info, CLIENT_INFO, PO_TOKEN),
    /no video-type format present/
  );
});

test('buildSabrAudioStream: throws when adaptive_formats is entirely empty', async () => {
  const info = baseInfo({ streaming_data: { adaptive_formats: [] } });
  await assert.rejects(
    () => buildSabrAudioStream(info, CLIENT_INFO, PO_TOKEN),
    /no video-type format present/
  );
});

// --- chooseAudioFormat -----------------------------------------------------

const FORMATS = [
  { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 },
  { itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 160000 },
  { itag: 250, mimeType: 'audio/webm; codecs="opus"', bitrate: 70000 },
];

test('chooseAudioFormat: with no preferredItag, picks the highest-bitrate opus candidate', () => {
  const result = chooseAudioFormat(FORMATS);
  assert.equal(result.itag, 251);
});

test('chooseAudioFormat: with a preferredItag present in the list, uses it exactly, ignoring bitrate/codec heuristics', () => {
  const result = chooseAudioFormat(FORMATS, 140);
  assert.equal(result.itag, 140);
});

test('chooseAudioFormat: with a preferredItag NOT present in the list, falls back to the opus heuristic', () => {
  const result = chooseAudioFormat(FORMATS, 999);
  assert.equal(result.itag, 251);
});

test('chooseAudioFormat: falls back to highest bitrate (any codec) when no opus candidate exists', () => {
  const noOpus = [
    { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 },
    { itag: 139, mimeType: 'audio/mp4; codecs="mp4a.40.5"', bitrate: 48000 },
  ];
  const result = chooseAudioFormat(noOpus);
  assert.equal(result.itag, 140);
});

test('chooseAudioFormat: preferredItag of 0/undefined is treated as "no preference"', () => {
  const result = chooseAudioFormat(FORMATS, undefined);
  assert.equal(result.itag, 251);
});
