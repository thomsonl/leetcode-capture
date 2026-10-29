// Native Messaging framing: every message, in both directions, is a 4-byte
// little-endian length followed by that many bytes of UTF-8 JSON.
// https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
// Firefox uses the same framing.

// The browser refuses a message from the host above 1 MB.
export const MAX_OUTGOING_BYTES = 1024 * 1024;
// Messages from the extension are small commands; anything far larger is a
// broken stream, not a message.
export const MAX_INCOMING_BYTES = 1024 * 1024;

export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_OUTGOING_BYTES) throw new Error(`message too large (${body.length} bytes)`);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

// Feed it chunks as they arrive; it calls onMessage once per whole message,
// however the chunks split them. onError is called once for a length over
// the limit or a body that is not JSON, and nothing more is decoded after
// that (the stream can no longer be trusted to be in step).
export function createDecoder({ onMessage, onError, maxBytes = MAX_INCOMING_BYTES }) {
  let buffered = Buffer.alloc(0);
  let broken = false;
  return {
    push(chunk) {
      if (broken) return;
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0);
        if (length > maxBytes) {
          broken = true;
          onError(new Error(`incoming message too large (${length} bytes)`));
          return;
        }
        if (buffered.length < 4 + length) return;
        const body = buffered.subarray(4, 4 + length).toString('utf8');
        buffered = buffered.subarray(4 + length);
        let message;
        try {
          message = JSON.parse(body);
        } catch {
          broken = true;
          onError(new Error('incoming message is not JSON'));
          return;
        }
        onMessage(message);
      }
    },
    // Bytes of a message that never finished (for a clean-shutdown check).
    get pending() {
      return buffered.length;
    },
  };
}
