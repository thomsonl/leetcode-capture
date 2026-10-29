// companion/capture-log.js - clearing the capture log as it is consumed.
//
// captures.jsonl is only a short-lived delivery queue: the relay appends each
// Run and Submit, and the companion tails it by byte offset. Old captures are
// worth nothing once the student has moved on, so the companion asks the
// relay to drop the prefix it has already read and handled (the relay owns
// appends, so only it may cut the file; see relay-server/server.js,
// trimCaptureLog). The companion asks with its own read offset, between
// polls, so every byte before it belongs to a line already handled and
// everything after it (the line that triggered a problem switch included,
// if it has not been read yet) stays. It moves its offset back by the
// removed byte count only once the relay confirms.
//
// One window is left: the relay may have trimmed and the companion died (or
// lost the answer) before it saved its new offset. So before asking, the
// companion saves a `pendingTrim` in its state file with the last bytes before
// the cut; afterwards those bytes are either still at the same place (no trim
// happened) or not (it did). Each capture line carries its own receive time,
// so a different line landing on exactly the same bytes is not a real risk.

const COMPANION_HEADERS = { 'Content-Type': 'application/json', 'X-LC-Companion': '1' };
const TRIM_TIMEOUT_MS = 5000;
// How many bytes before the cut a pendingTrim remembers.
export const GUARD_BYTES = 256;

// Asks the relay to drop the first `before` bytes of the log at `logPath`.
// Resolves to one of:
//   { outcome: 'trimmed', removed }          the relay cut the file
//   { outcome: 'refused', status, error }    it answered and did not cut
//   { outcome: 'unsupported' }               an older relay without the route
//   { outcome: 'unknown', error }            no answer: it may or may not have cut
export async function requestCaptureTrim({ baseUrl, before, logPath, fetchImpl = fetch, timeoutMs = TRIM_TIMEOUT_MS }) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/panel/trim-captures`, {
      method: 'POST',
      headers: COMPANION_HEADERS,
      body: JSON.stringify({ before, path: logPath }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { outcome: 'unknown', error: err.message };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status === 200 && body && Number.isSafeInteger(body.removed) && body.removed === before) {
    return { outcome: 'trimmed', removed: body.removed };
  }
  if (res.status === 404) return { outcome: 'unsupported' };
  if (res.status === 200) return { outcome: 'unknown', error: 'the relay gave an unexpected answer' };
  return { outcome: 'refused', status: res.status, error: (body && body.error) || `HTTP ${res.status}` };
}

// The pendingTrim to save before asking: the cut position and the bytes just
// before it, base64. `readAt(position, length)` returns a Buffer-like of the
// log's bytes there (shorter at the end of the file).
export function pendingTrimFor(before, readAt) {
  const length = Math.min(before, GUARD_BYTES);
  const tail = readAt(before - length, length);
  return { before, tail: Buffer.from(tail).toString('base64') };
}

// Whether a saved pendingTrim was carried out: the bytes it remembered are no
// longer right before its cut position.
export function pendingTrimHappened(pending, readAt) {
  const expected = Buffer.from(pending.tail, 'base64');
  const actual = Buffer.from(readAt(pending.before - expected.length, expected.length));
  return !actual.equals(expected);
}

export function isPendingTrim(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    Number.isSafeInteger(value.before) &&
    value.before > 0 &&
    typeof value.tail === 'string'
  );
}
