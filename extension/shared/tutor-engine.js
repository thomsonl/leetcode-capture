// extension/shared/tutor-engine.js - the tutor itself, running inside the
// browser extension's background worker (the "extension" runtime): no relay
// server, no companion process. It takes captures and Tutor-panel messages,
// decides what the tutor is sent, talks to the backend and publishes the
// conversation into an event hub (event-hub.js) that the panels follow.
//
// The rules are the companion's, built on the same shared modules:
//   - code-ledger.js decides what the tutor is sent: a Run is only recorded,
//     never sent; a Submit is sent only when its code differs from what the
//     tutor last saw; every request carries the current full code (pinned by
//     the backend) and a message leads with a numbered diff of what changed;
//     what the tutor saw advances only once the backend answered.
//   - Every backend is stateless or rebuilds from its own record, and a
//     backend swap moves the conversation to the new one
//     (conversation.js), so a model switch keeps the chat and the code.
//   - The active problem is whichever one the student last sent a message,
//     Run or Submit from. Activity on another problem (with autoClearContext
//     on, the default) resets the backend's context, drops the old problem
//     from the ledger and its buffered chat from the hub, and says so in the
//     panel.
//   - Every capture, message, reset and settings swap runs in one queue, so a
//     reset or a swap never lands in the middle of a backend call.
//   - Every reply goes through the post-check guard (reply-guard.js, the
//     companion uses the same one): rule repairs everywhere, hint and stuck
//     replies held and re-asked once when broken, other replies released
//     sentence by sentence with broken parts dropped.
//   - Message limits match the relay's (relay-server/panel-broker.js): 8000
//     characters of text, 100,000 of snapshot code, 50,000 of description.
// Nothing is persisted: the conversation lives in memory only, and the
// capture log the relay keeps (captures.jsonl) has no counterpart here.
//
// Pure JavaScript with no Node API (extension/shared.test.js checks that).
// The browser wiring (ports, storage, permissions) is in background.js.

import {
  createCodeLedger,
  sendsToTutor,
  chatPreamble,
  prepareChatTurn,
  prepareSubmitTurn,
  DEFAULT_MAX_PROBLEMS,
} from './code-ledger.js';
import { transferConversation } from './conversation.js';
import { sanitizeCapture, stripControlChars, oneLine } from './sanitize.js';
import { createReplyGuard, guardedSend } from './reply-guard.js';
import { SUBMIT_ADDENDUM, captureHeaderLine, captureProblemId, captureProblemContext } from './tutor-prompt.js';

export const MAX_MESSAGE_CHARS = 8000;
export const MAX_SNAPSHOT_CODE_CHARS = 100_000;
export const MAX_SNAPSHOT_DESCRIPTION_CHARS = 50_000;
// A capture's code and description, past which the capture is refused (the
// relay's 5 MB body cap, in characters).
export const MAX_CAPTURE_CODE_CHARS = 2_000_000;
export const BUSY_IDLE_DELAY_MS = 100;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/i;

export const NEW_PROBLEM_NOTICE = 'New problem detected. Started a fresh tutor session.';

function isShortString(value, max) {
  return typeof value === 'string' && value.length <= max;
}

// The live editor code a panel message carries, made safe the way the relay
// and the companion do (panel-broker.js's sanitizeSnapshot, companion.js's
// panelSnapshot); the code itself is left exactly as typed. Null when absent
// or over a limit.
export function cleanSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || !isShortString(raw.code, MAX_SNAPSHOT_CODE_CHARS)) return null;
  const snapshot = { code: raw.code, language: null, problemTitle: null, problemDescription: null };
  if (isShortString(raw.language, 50)) snapshot.language = oneLine(raw.language) || null;
  if (isShortString(raw.problemTitle, 300)) snapshot.problemTitle = oneLine(raw.problemTitle) || null;
  if (isShortString(raw.problemDescription, MAX_SNAPSHOT_DESCRIPTION_CHARS)) {
    snapshot.problemDescription = stripControlChars(raw.problemDescription);
  }
  return snapshot;
}

// createTutorEngine({ hub, log? }). The backend is set with configure(); until
// then (or when the settings cannot build one) every turn ends with
// `configError`.
export function createTutorEngine({ hub, log = () => {} }) {
  const ledger = createCodeLedger({ maxProblems: DEFAULT_MAX_PROBLEMS });
  let backend = null;
  let backendKey = null;
  // A backend set aside while none is configured (see installBackend).
  let parked = null;
  let label = 'tutor';
  let configError = 'The tutor is not set up yet. Open the extension options to choose a model.';
  let options = { autoClearContext: true };
  // Rewords a backend error into what to do about it (see
  // extension-settings.js's explainError), per configuration.
  let explain = (message) => message;
  // Attempt numbers per problem, like the relay's attemptSeq, in memory only.
  const attempts = new Map();
  let turnCounter = 0;
  // Hint count and what the student named or saw, for the post-check guard;
  // reset with the conversation.
  const guard = createReplyGuard();

  // ---- the turn queue ----------------------------------------------------
  let chain = Promise.resolve();
  function queueTurn(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  // ---- the "Processing" light (see companion.js's holdBusy) --------------
  let busyTurns = 0;
  let busyIdleTimer = null;
  function holdBusy() {
    busyTurns += 1;
    if (busyIdleTimer) {
      clearTimeout(busyIdleTimer);
      busyIdleTimer = null;
    }
    hub.setBusy(true);
    let released = false;
    return function releaseBusy() {
      if (released) return;
      released = true;
      busyTurns -= 1;
      if (busyTurns > 0 || busyIdleTimer) return;
      busyIdleTimer = setTimeout(() => {
        busyIdleTimer = null;
        if (busyTurns === 0) hub.setBusy(false);
      }, BUSY_IDLE_DELAY_MS);
    };
  }

  function publish(event) {
    // An event for no problem would sit under a key no panel shows (see
    // companion.js's panelPublish).
    if ('problemSlug' in event && !event.problemSlug) return;
    hub.publish(event);
  }

  function newTurnId() {
    turnCounter += 1;
    return `x${Date.now().toString(36)}-${turnCounter}`;
  }

  // ---- problem switching ---------------------------------------------------
  function activateProblem(problemId, slug) {
    const result = ledger.activate(problemId, { slug, resetOnSwitch: options.autoClearContext });
    if (!result.reset) return result;
    if (backend) backend.resetContext();
    guard.reset();
    parked = null;
    if (result.dropped && result.dropped.slug) {
      hub.dropProblem(result.dropped.slug);
      attempts.delete(result.dropped.slug);
    }
    // `switch` tells the panels this notice opens a fresh session (see
    // panel.js's applyEventInEpoch), unlike any other notice.
    publish({ type: 'notice', problemSlug: slug || null, text: NEW_PROBLEM_NOTICE, switch: true });
    return result;
  }

  // ---- one tutor turn ----------------------------------------------------
  // Publishes turn-start, each chunk the guard releases, then turn-end with
  // the whole text as shown (exactly the chunks) or the error. Resolves true
  // only for a real reply, so the caller commits the code as held only then.
  // `studentText` is the student's own words (null for a Submit) and
  // `trigger` 'submit' or null, for the guard.
  async function sendTurn(text, { problemContext, currentCode, compactText, problemSlug, studentText = null, trigger = null }) {
    const turnId = newTurnId();
    publish({ type: 'turn-start', turnId, problemSlug });
    const end = (fields) => publish({ type: 'turn-end', turnId, problemSlug, ...fields });
    if (!backend) {
      end({ error: configError });
      return false;
    }
    let reply;
    try {
      reply = await guardedSend({
        backend,
        text,
        options: { problemContext, currentCode, compactText },
        turn: guard.begin({ text: studentText, trigger, code: currentCode && typeof currentCode.code === 'string' ? currentCode.code : null }),
        onText: (chunk) => {
          if (problemSlug) hub.publish({ type: 'chunk', turnId, text: chunk });
        },
        log,
      });
    } catch (err) {
      end({ error: `Error talking to the backend (${label}): ${explain(err.message)}` });
      return false;
    } finally {
      for (const warning of backend.takeWarnings?.() || []) log(`warning: ${warning}`);
    }
    if (!(typeof reply === 'string' && reply.trim())) {
      end({ error: 'The backend returned an empty reply.' });
      return false;
    }
    end({ text: reply });
    return true;
  }

  async function sendChatTurn({ text, problemId, problemSlug, preamble = null, codeUnavailable = false }) {
    const turn = prepareChatTurn(ledger, { text, problemId, preamble, codeUnavailable });
    const ok = await sendTurn(turn.message.text, {
      problemContext: turn.problemContext,
      currentCode: turn.currentCode,
      compactText: turn.message.compactText,
      problemSlug,
      studentText: text,
    });
    if (ok && (turn.plan.kind === 'full' || turn.plan.kind === 'diff')) ledger.commit(problemId, turn.plan);
  }

  // Puts `next` in place of the running backend, moving the conversation
  // over (conversation.js) so the new model sees the same chat, statement
  // and code. Only when that is impossible (nothing to move from, or a
  // backend that cannot export) does the ledger forget what the tutor saw,
  // so the next message describes the code from scratch. Setting no backend
  // parks the old one, whose conversation the next backend then takes over.
  function installBackend(next, key) {
    if (!next) {
      if (backend) parked = backend;
      backend = null;
      backendKey = null;
      return;
    }
    const moved = transferConversation(backend || parked, next);
    parked = null;
    backend = next;
    backendKey = key;
    if (!moved) ledger.forgetHeld();
  }

  return {
    // Swaps in the backend built from saved settings, between turns. A
    // configuration whose `key` is unchanged (only an option changed) keeps
    // the running backend; a new backend takes over the conversation (see
    // installBackend). `error` (no backend) is what every turn says until a
    // working configuration arrives.
    configure({ backend: nextBackend = null, key = null, label: nextLabel, options: nextOptions, config = null, error = null, explainError = null, keep = false }) {
      return queueTurn(async () => {
        explain = explainError || ((message) => message);
        if (nextOptions) options = { ...options, ...nextOptions };
        if (nextLabel) label = nextLabel;
        configError = error || configError;
        if (keep && backend) {
          // Same backend configuration (only an option changed): keep it.
        } else if (!nextBackend) {
          installBackend(null, null);
        } else if (key === null || key !== backendKey) {
          installBackend(nextBackend, key);
        }
        hub.setConfig(config);
      });
    },

    // The model switcher's entry point: swaps to `backend` (a profile's
    // backend, built by the caller) between turns, keeping the chat history,
    // the pinned statement and the code the tutor has seen. Resolves once the
    // swap has happened, after any turn already queued.
    swapBackend({ backend: nextBackend, key = null, label: nextLabel = null, config = null }) {
      if (!nextBackend) return Promise.reject(new Error('swapBackend needs a backend'));
      return queueTurn(async () => {
        if (nextLabel) label = nextLabel;
        installBackend(nextBackend, key);
        if (config) hub.setConfig(config);
      });
    },

    // A Run or Submit from content.js. Returns false (and does nothing) for
    // something that is not a capture.
    handleCapture(raw) {
      if (!raw || typeof raw !== 'object' || (raw.trigger !== 'run' && raw.trigger !== 'submit')) return false;
      if (typeof raw.code !== 'string' || raw.code.length > MAX_CAPTURE_CODE_CHARS) return false;
      if (typeof raw.problemDescription === 'string' && raw.problemDescription.length > MAX_CAPTURE_CODE_CHARS) return false;
      const capture = sanitizeCapture(raw);
      if (capture.problemSlug && !SLUG_RE.test(capture.problemSlug)) return false;
      const problemId = captureProblemId(capture);
      const slug = capture.problemSlug || null;
      // The reset (if this is another problem) runs in the queue, and drops
      // the old problem's attempt numbers; numbering this one first is fine.
      const attemptSeq = slug ? (attempts.get(slug) || 0) + 1 : null;
      if (slug) attempts.set(slug, attemptSeq);
      queueTurn(async () => {
        if (problemId) {
          activateProblem(problemId, slug);
          ledger.record(problemId, {
            code: capture.code,
            language: capture.language || null,
            slug,
            context: captureProblemContext(capture),
          });
        }
        if (!sendsToTutor(capture.trigger)) return;
        const plan = problemId ? ledger.planUpdate(problemId) : { kind: 'none' };
        if (plan.kind === 'unchanged' || plan.kind === 'none') return;
        // Only a capture the tutor is about to see shows its chip in the
        // panel: a Run or an unchanged Submit shows nothing at all.
        publish({ type: 'capture', problemSlug: slug, problemTitle: capture.problemTitle || null, trigger: capture.trigger, attemptSeq });
        const releaseBusy = holdBusy();
        try {
          const turn = prepareSubmitTurn(ledger, {
            problemId,
            plan,
            headerLine: captureHeaderLine(capture),
            addendum: SUBMIT_ADDENDUM,
            fallbackContext: captureProblemContext(capture),
          });
          const ok = await sendTurn(turn.message.text, {
            problemContext: turn.problemContext,
            currentCode: turn.currentCode,
            compactText: turn.message.compactText,
            problemSlug: slug,
            trigger: 'submit',
          });
          if (ok) ledger.commit(problemId, plan);
        } finally {
          releaseBusy();
        }
      }).catch((err) => log(`error handling a capture: ${err.message}`));
      return true;
    },

    // A message typed into the Tutor panel: { text, problemSlug, snapshot }.
    // Resolves to { ok: true } once queued, or { ok: false, error } for a
    // message refused the way the relay refuses it (the panel shows why).
    handleMessage(raw) {
      if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string') return { ok: false, error: 'invalid' };
      if (raw.text.length > MAX_MESSAGE_CHARS) return { ok: false, error: 'too-long' };
      const text = stripControlChars(raw.text).trim();
      if (!text) return { ok: false, error: 'invalid' };
      const problemSlug = typeof raw.problemSlug === 'string' && SLUG_RE.test(raw.problemSlug) ? raw.problemSlug : null;
      if (!problemSlug) return { ok: false, error: 'invalid' };
      const snapshot = cleanSnapshot(raw.snapshot);
      const releaseBusy = holdBusy();
      queueTurn(async () => {
        const { previousId } = activateProblem(problemSlug, problemSlug);
        publish({ type: 'user', text, problemSlug });
        if (snapshot) {
          ledger.record(problemSlug, {
            code: snapshot.code,
            language: snapshot.language,
            slug: problemSlug,
            context: {
              problemId: problemSlug,
              title: snapshot.problemTitle || problemSlug,
              slug: problemSlug,
              description: snapshot.problemDescription && snapshot.problemDescription.trim() ? snapshot.problemDescription : null,
            },
          });
        }
        const codeUnavailable = !snapshot;
        const preamble = ({ hasHeld }) => chatPreamble({ previousId, problemId: problemSlug, codeUnavailable, hasHeld });
        await sendChatTurn({ text, problemId: problemSlug, problemSlug, preamble, codeUnavailable });
      })
        .catch((err) => log(`error handling a message: ${err.message}`))
        .finally(releaseBusy);
      return { ok: true };
    },

    // Resolves once everything queued so far has run (for tests).
    idle() {
      return queueTurn(async () => {});
    },

    // For tests and diagnostics.
    get activeProblemId() {
      return ledger.activeProblemId;
    },
  };
}
