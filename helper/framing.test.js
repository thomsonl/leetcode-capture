import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecoder, encodeMessage, MAX_OUTGOING_BYTES } from './framing.js';

function decodeAll(chunks, maxBytes) {
  const messages = [];
  const errors = [];
  const decoder = createDecoder({ onMessage: (m) => messages.push(m), onError: (e) => errors.push(e), maxBytes });
  for (const chunk of chunks) decoder.push(chunk);
  return { messages, errors, decoder };
}

test('encodes a 4-byte little-endian length then UTF-8 JSON', () => {
  const frame = encodeMessage({ type: 'pong', text: 'é' });
  const body = JSON.stringify({ type: 'pong', text: 'é' });
  assert.equal(frame.readUInt32LE(0), Buffer.byteLength(body));
  assert.equal(frame.subarray(4).toString('utf8'), body);
});

test('decodes messages however the chunks split them', () => {
  const stream = Buffer.concat([encodeMessage({ a: 1 }), encodeMessage({ b: 'two' }), encodeMessage([3])]);
  for (let size = 1; size <= stream.length; size += 1) {
    const chunks = [];
    for (let i = 0; i < stream.length; i += size) chunks.push(stream.subarray(i, i + size));
    const { messages, errors, decoder } = decodeAll(chunks);
    assert.deepEqual(messages, [{ a: 1 }, { b: 'two' }, [3]], `chunk size ${size}`);
    assert.equal(errors.length, 0);
    assert.equal(decoder.pending, 0);
  }
});

test('a partial message waits for the rest', () => {
  const frame = encodeMessage({ type: 'ping' });
  const { messages, decoder } = decodeAll([frame.subarray(0, 6)]);
  assert.deepEqual(messages, []);
  assert.equal(decoder.pending, 6);
  decoder.push(frame.subarray(6));
  assert.equal(decoder.pending, 0);
});

test('an oversize length is an error and stops decoding', () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(1000, 0);
  const { messages, errors, decoder } = decodeAll([header], 100);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /too large/);
  decoder.push(encodeMessage({ later: true }));
  assert.deepEqual(messages, []);
});

test('a body that is not JSON is an error', () => {
  const body = Buffer.from('{nope', 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  const { errors } = decodeAll([Buffer.concat([header, body])]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /not JSON/);
});

test('refuses to send a message the browser would reject', () => {
  assert.throws(() => encodeMessage({ big: 'x'.repeat(MAX_OUTGOING_BYTES) }), /too large/);
});
