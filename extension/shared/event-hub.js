// extension/shared/event-hub.js - the in-extension stand-in for the relay's
// panel broker (relay-server/panel-broker.js): a bounded, numbered buffer of
// tutor events that every Tutor panel replays on connect and then follows
// live. The background worker owns one; tutor-engine.js publishes into it.
//
// It keeps the relay's event protocol exactly, so the panel applies these
// events with the same code either way (see extension/panel.js):
//   - every event carries `seq` and the hub's random `epoch`; a panel that
//     reconnects with `after` and the same epoch gets only what it missed,
//     and one from another epoch (the worker restarted) gets everything;
//   - a turn-end drops that turn's buffered chunks, since it carries the
//     whole text;
//   - after the replay a subscriber gets the newest `config` event, then a
//     `status` event ({ companionOnline, busy, epoch, openTurns });
//   - dropProblem forgets a problem's events (the reset on a problem switch).
//
// Pure JavaScript with no Node API (extension/shared.test.js checks that).

export const MAX_BUFFERED_EVENTS = 2000;
export const MAX_OPEN_TURNS = 100;

function randomEpoch() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createEventHub({ epoch = randomEpoch(), maxEvents = MAX_BUFFERED_EVENTS } = {}) {
  let nextSeq = 1;
  let events = [];
  const subscribers = new Set();
  const openTurns = new Map(); // turnId -> problemSlug
  let busy = false;
  let config = null;

  function send(subscriber, event) {
    try {
      subscriber(event);
    } catch {
      // A subscriber whose port went away; its own disconnect handler
      // unsubscribes it.
    }
  }

  function statusEvent() {
    return { type: 'status', companionOnline: true, busy, epoch, openTurns: [...openTurns.keys()] };
  }

  function broadcast(event) {
    for (const subscriber of subscribers) send(subscriber, event);
  }

  function track(event) {
    if (!event.turnId) return;
    if (event.type === 'turn-start') {
      openTurns.delete(event.turnId);
      openTurns.set(event.turnId, event.problemSlug || null);
      if (openTurns.size > MAX_OPEN_TURNS) openTurns.delete(openTurns.keys().next().value);
    } else if (event.type === 'turn-end') {
      openTurns.delete(event.turnId);
    }
  }

  return {
    epoch,

    // Adds one event ({ type, problemSlug?, turnId?, text?, ... }) and sends
    // it to every subscriber. Returns the stored event.
    publish(event) {
      track(event);
      const stored = { ...event, seq: nextSeq++, epoch };
      if (stored.type === 'turn-end' && stored.turnId) {
        events = events.filter((e) => !(e.type === 'chunk' && e.turnId === stored.turnId));
      }
      events.push(stored);
      if (events.length > maxEvents) events = events.slice(events.length - maxEvents);
      broadcast(stored);
      return stored;
    },

    // Forgets every buffered event of one problem, chunks of its turns too
    // (they carry only a turn id).
    dropProblem(slug) {
      if (!slug) return 0;
      const before = events.length;
      const turnIds = new Set(events.filter((e) => e.problemSlug === slug && e.turnId).map((e) => e.turnId));
      events = events.filter((e) => e.problemSlug !== slug && !(e.turnId && turnIds.has(e.turnId)));
      for (const [turnId, problemSlug] of openTurns) if (problemSlug === slug) openTurns.delete(turnId);
      return before - events.length;
    },

    setBusy(next) {
      if (busy === Boolean(next)) return;
      busy = Boolean(next);
      broadcast(statusEvent());
    },

    // The non-secret summary of what the tutor runs on ({ provider, label,
    // model }), for the panel header.
    setConfig(next) {
      config = next ? { type: 'config', provider: next.provider, label: next.label, model: next.model ?? null } : null;
      if (config) broadcast(config);
    },

    // Replays the buffer after `after` (everything when `clientEpoch` is from
    // another run), then config and status, then follows live. Returns the
    // unsubscribe function.
    subscribe(subscriber, { after = 0, epoch: clientEpoch = null } = {}) {
      const from = clientEpoch && clientEpoch !== epoch ? 0 : Number.isFinite(after) ? after : 0;
      for (const event of events) if (event.seq > from) send(subscriber, event);
      if (config) send(subscriber, config);
      send(subscriber, statusEvent());
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },

    subscriberCount() {
      return subscribers.size;
    },

    // For tests.
    events() {
      return events.slice();
    },
  };
}
