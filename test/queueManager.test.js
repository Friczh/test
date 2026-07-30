'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { QueueManager, GuildQueue } = require('../src/lib/queueManager');

function track(id) {
  return { videoId: id, title: id };
}

test('add/next preserve FIFO order', () => {
  const q = new GuildQueue('g1');
  q.add(track('a'));
  q.add(track('b'));
  q.add(track('c'));
  assert.equal(q.next().videoId, 'a');
  assert.equal(q.next().videoId, 'b');
  assert.equal(q.playing.videoId, 'b');
  assert.equal(q.next().videoId, 'c');
  assert.equal(q.next(), null);
  assert.equal(q.playing, null);
});

test('addMany appends a batch in order in one call', () => {
  const q = new GuildQueue('g1');
  q.add(track('a'));
  q.addMany([track('b'), track('c'), track('d')]);
  assert.deepEqual(q.list().map((t) => t.videoId), ['a', 'b', 'c', 'd']);
});

test('addMany with an empty array is a no-op', () => {
  const q = new GuildQueue('g1');
  q.add(track('a'));
  q.addMany([]);
  assert.deepEqual(q.list().map((t) => t.videoId), ['a']);
});

test('remove takes a 1-based-caller / 0-based-internal index and returns the removed track', () => {
  const q = new GuildQueue('g1');
  q.add(track('a'));
  q.add(track('b'));
  q.add(track('c'));
  const removed = q.remove(1); // remove 'b'
  assert.equal(removed.videoId, 'b');
  assert.deepEqual(q.list().map((t) => t.videoId), ['a', 'c']);
});

test('remove returns null for out-of-range index', () => {
  const q = new GuildQueue('g1');
  q.add(track('a'));
  assert.equal(q.remove(5), null);
  assert.equal(q.remove(-1), null);
});

test('swap exchanges two tracks', () => {
  const q = new GuildQueue('g1');
  q.add(track('a'));
  q.add(track('b'));
  q.add(track('c'));
  assert.equal(q.swap(0, 2), true);
  assert.deepEqual(q.list().map((t) => t.videoId), ['c', 'b', 'a']);
});

test('swap returns false for out-of-range index and leaves queue untouched', () => {
  const q = new GuildQueue('g1');
  q.add(track('a'));
  q.add(track('b'));
  assert.equal(q.swap(0, 5), false);
  assert.deepEqual(q.list().map((t) => t.videoId), ['a', 'b']);
});

test('move relocates a track', () => {
  const q = new GuildQueue('g1');
  q.add(track('a'));
  q.add(track('b'));
  q.add(track('c'));
  assert.equal(q.move(0, 2), true);
  assert.deepEqual(q.list().map((t) => t.videoId), ['b', 'c', 'a']);
});

test('move returns false for out-of-range index', () => {
  const q = new GuildQueue('g1');
  q.add(track('a'));
  assert.equal(q.move(0, 3), false);
});

test('clear empties the queue but not the currently-playing track', () => {
  const q = new GuildQueue('g1');
  q.add(track('a'));
  q.add(track('b'));
  q.next();
  q.clear();
  assert.deepEqual(q.list(), []);
  assert.equal(q.playing.videoId, 'a');
});

test('generation counter starts at 0 and increments on bump', () => {
  const q = new GuildQueue('g1');
  assert.equal(q.generation, 0);
  assert.equal(q.isCurrentGeneration(0), true);
  const next = q.bumpGeneration();
  assert.equal(next, 1);
  assert.equal(q.isCurrentGeneration(0), false);
  assert.equal(q.isCurrentGeneration(1), true);
});

test('a stale generation captured before a skip is correctly detected as stale', () => {
  const q = new GuildQueue('g1');
  const capturedGeneration = q.generation; // as if extraction started here
  q.bumpGeneration(); // a skip happens mid-extraction
  assert.equal(q.isCurrentGeneration(capturedGeneration), false);
});

test('QueueManager lazily creates one queue per guild and reuses it', () => {
  const mgr = new QueueManager();
  const q1 = mgr.get('guildA');
  const q2 = mgr.get('guildA');
  const q3 = mgr.get('guildB');
  assert.equal(q1, q2);
  assert.notEqual(q1, q3);
  assert.equal(mgr.has('guildA'), true);
});

test('QueueManager.delete removes the queue', () => {
  const mgr = new QueueManager();
  mgr.get('guildA');
  mgr.delete('guildA');
  assert.equal(mgr.has('guildA'), false);
});
