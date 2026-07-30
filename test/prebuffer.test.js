'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { PrebufferTransform } = require('../src/lib/prebuffer');

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

test('throws on a non-positive targetBytes', () => {
  assert.throws(() => new PrebufferTransform({ targetBytes: 0 }));
  assert.throws(() => new PrebufferTransform({ targetBytes: -5 }));
  assert.throws(() => new PrebufferTransform({ targetBytes: NaN }));
});

test('withholds output until the byte target is reached, then emits prebuffered', async () => {
  const t = new PrebufferTransform({ targetBytes: 10 });
  let prebufferedFired = false;
  let bufferedAtEvent = 0;
  t.once('prebuffered', ({ bufferedBytes }) => {
    prebufferedFired = true;
    bufferedAtEvent = bufferedBytes;
  });

  const source = Readable.from([Buffer.alloc(4, 'a'), Buffer.alloc(4, 'b'), Buffer.alloc(4, 'c')]);
  const outputPromise = collect(t);
  source.pipe(t);
  const output = await outputPromise;

  assert.equal(prebufferedFired, true);
  assert.equal(bufferedAtEvent, 12); // released as soon as cumulative >= 10 (after 3rd chunk)
  assert.equal(output.length, 12); // all data eventually passed through, nothing dropped
});

test('passes chunks through live once released', async () => {
  const t = new PrebufferTransform({ targetBytes: 2 });
  const releasedAt = [];
  t.on('data', (chunk) => releasedAt.push(chunk.length));

  const done = new Promise((resolve) => t.on('end', resolve));
  t.write(Buffer.alloc(2)); // meets target immediately -> one combined chunk of 2
  t.write(Buffer.alloc(3)); // now released -> passed straight through as its own chunk
  t.end();
  await done;

  assert.deepEqual(releasedAt, [2, 3]);
});

test('short streams that never reach the target still flush and emit prebuffered', async () => {
  const t = new PrebufferTransform({ targetBytes: 1_000_000 });
  let prebufferedFired = false;
  let bufferedAtEvent = 0;
  t.once('prebuffered', ({ bufferedBytes }) => {
    prebufferedFired = true;
    bufferedAtEvent = bufferedBytes;
  });

  const source = Readable.from([Buffer.alloc(5), Buffer.alloc(5)]);
  const outputPromise = collect(t);
  source.pipe(t);
  const output = await outputPromise;

  assert.equal(prebufferedFired, true);
  assert.equal(bufferedAtEvent, 10);
  assert.equal(output.length, 10);
});

test('an empty source still ends cleanly without emitting prebuffered', async () => {
  const t = new PrebufferTransform({ targetBytes: 100 });
  let prebufferedFired = false;
  t.once('prebuffered', () => {
    prebufferedFired = true;
  });

  const source = Readable.from([]);
  const outputPromise = collect(t);
  source.pipe(t);
  const output = await outputPromise;

  assert.equal(prebufferedFired, false);
  assert.equal(output.length, 0);
});
