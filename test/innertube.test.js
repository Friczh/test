'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getSabrClientInfo } = require('../src/lib/innertube');

function fakeSession(clientVersion) {
  return { session: { client_version: clientVersion } };
}

test('getSabrClientInfo: WEB maps to numeric clientName 1', () => {
  const result = getSabrClientInfo(fakeSession('2.20250101.00.00'), 'WEB');
  assert.deepEqual(result, { clientName: 1, clientVersion: '2.20250101.00.00' });
});

test('getSabrClientInfo: YTMUSIC maps to numeric clientName 67 (WEB_REMIX)', () => {
  const result = getSabrClientInfo(fakeSession('1.20250101.01.00'), 'YTMUSIC');
  assert.deepEqual(result, { clientName: 67, clientVersion: '1.20250101.01.00' });
});

test('getSabrClientInfo: clientVersion is read from the passed-in session, not hardcoded', () => {
  const a = getSabrClientInfo(fakeSession('AAA'), 'WEB');
  const b = getSabrClientInfo(fakeSession('BBB'), 'WEB');
  assert.equal(a.clientVersion, 'AAA');
  assert.equal(b.clientVersion, 'BBB');
});

test('getSabrClientInfo: unknown clientType throws', () => {
  assert.throws(
    () => getSabrClientInfo(fakeSession('1.0'), 'ANDROID'),
    /unknown clientType|no CLIENT_NAME_IDS/
  );
});
