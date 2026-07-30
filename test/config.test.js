'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { envNumber, config } = require('../src/lib/config');

test('envNumber returns fallback when unset', () => {
  assert.equal(envNumber('MB_TEST_UNSET_VAR', 42), 42);
});

test('envNumber returns fallback for an empty string', () => {
  process.env.MB_TEST_EMPTY = '';
  assert.equal(envNumber('MB_TEST_EMPTY', 7), 7);
  delete process.env.MB_TEST_EMPTY;
});

test('envNumber parses a valid numeric string, including decimals', () => {
  process.env.MB_TEST_NUM = '2.5';
  assert.equal(envNumber('MB_TEST_NUM', 0), 2.5);
  delete process.env.MB_TEST_NUM;
});

test('envNumber falls back on a non-numeric value', () => {
  process.env.MB_TEST_BAD = 'not-a-number';
  assert.equal(envNumber('MB_TEST_BAD', 9), 9);
  delete process.env.MB_TEST_BAD;
});

test('envNumber falls back on a negative value', () => {
  process.env.MB_TEST_NEG = '-5';
  assert.equal(envNumber('MB_TEST_NEG', 3), 3);
  delete process.env.MB_TEST_NEG;
});

test('envNumber accepts zero', () => {
  process.env.MB_TEST_ZERO = '0';
  assert.equal(envNumber('MB_TEST_ZERO', 99), 0);
  delete process.env.MB_TEST_ZERO;
});

test('default config has sane out-of-the-box values', () => {
  assert.equal(config.prebufferSeconds, 1.5);
  assert.equal(config.networkBufferMs, 2000);
  assert.equal(config.prebufferTimeoutMs, 8000);
  assert.equal(config.assumedBitrateBps, 128_000);
  assert.equal(config.stallBufferMs, 400);
});

test('stallBufferFrames derives from stallBufferMs using a 20ms frame', () => {
  assert.equal(config.stallBufferFrames, 20); // 400ms / 20ms
});

test('stallBufferFrames rounds and never returns less than 1', () => {
  const original = config.stallBufferMs;
  config.stallBufferMs = 5; // < half a frame
  assert.equal(config.stallBufferFrames, 1);
  config.stallBufferMs = 30; // rounds to 2 frames (30/20 = 1.5 -> 2)
  assert.equal(config.stallBufferFrames, 2);
  config.stallBufferMs = original;
});
