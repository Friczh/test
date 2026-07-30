'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCookiesToHeader, decodeCookiesEnv, isNetscapeFormat } = require('../src/lib/cookies');

test('parses an already-correct header string, normalizing whitespace', () => {
  const input = '  SID=abc123;   HSID=def456  ;SSID=ghi789';
  assert.equal(parseCookiesToHeader(input), 'SID=abc123; HSID=def456; SSID=ghi789');
});

test('parses a header string split across lines', () => {
  const input = 'SID=abc123;\nHSID=def456;\nSSID=ghi789';
  assert.equal(parseCookiesToHeader(input), 'SID=abc123; HSID=def456; SSID=ghi789');
});

test('parses a Netscape cookies.txt export', () => {
  const input = [
    '# Netscape HTTP Cookie File',
    '# This is a generated file! Do not edit.',
    '',
    '.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tabc123',
    '.youtube.com\tTRUE\t/\tTRUE\t1999999999\tHSID\tdef456',
  ].join('\n');
  assert.equal(parseCookiesToHeader(input), 'SID=abc123; HSID=def456');
});

test('handles #HttpOnly_ prefixed Netscape lines', () => {
  const input = [
    '# Netscape HTTP Cookie File',
    '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tabc123',
    '.youtube.com\tTRUE\t/\tTRUE\t1999999999\tHSID\tdef456',
  ].join('\n');
  assert.equal(parseCookiesToHeader(input), 'SID=abc123; HSID=def456');
});

test('detects Netscape format correctly', () => {
  const netscape = '.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tabc123';
  const header = 'SID=abc123; HSID=def456';
  assert.equal(isNetscapeFormat(netscape), true);
  assert.equal(isNetscapeFormat(header), false);
});

test('ignores blank lines and pure comment lines in Netscape input', () => {
  const input = [
    '',
    '# comment',
    '   ',
    '.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tabc123',
  ].join('\n');
  assert.equal(parseCookiesToHeader(input), 'SID=abc123');
});

test('throws on empty input', () => {
  assert.throws(() => parseCookiesToHeader(''), /empty/);
  assert.throws(() => parseCookiesToHeader('   \n  '), /empty/);
});

test('throws on non-string input', () => {
  assert.throws(() => parseCookiesToHeader(null), /empty or not a string/);
});

test('decodeCookiesEnv base64-decodes then parses (Netscape)', () => {
  const raw = '.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tabc123';
  const b64 = Buffer.from(raw, 'utf8').toString('base64');
  assert.equal(decodeCookiesEnv(b64), 'SID=abc123');
});

test('decodeCookiesEnv base64-decodes then parses (header string)', () => {
  const raw = 'SID=abc123; HSID=def456';
  const b64 = Buffer.from(raw, 'utf8').toString('base64');
  assert.equal(decodeCookiesEnv(b64), 'SID=abc123; HSID=def456');
});

test('decodeCookiesEnv throws when env var is missing', () => {
  assert.throws(() => decodeCookiesEnv(undefined), /YOUTUBE_COOKIES_BASE64/);
  assert.throws(() => decodeCookiesEnv(''), /YOUTUBE_COOKIES_BASE64/);
});
