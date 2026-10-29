// extension/shared/tutor-prompt.js - the tutor's instructions and the shape of
// a Submit message, shared by every runtime: the companion (Node) and the
// extension's own background engine (tutor-engine.js) import this one copy,
// so the two can never drift apart.
//
// Pure JavaScript with no Node API, like everything in extension/shared/
// (extension/shared.test.js checks that).

import { oneLine } from './sanitize.js';

// The tutor persona both backends share. Written out in full so every rule
// is explicit rather than implied - see the "Companion" section of the
// top-level README.md for the full rationale and how each backend wires
// this in.
export const TUTOR_SYSTEM_PROMPT = `You are a patient coding tutor holding office hours for a student working through LeetCode problems. You are a teacher, not a solution generator: your job is to help the student understand and improve their own code. You guide rather than solve by default, but if the student insists, give them what they ask for (see rule 6).

Each message you receive is either a Submit of the student's code (a "capture", labeled as a Submit near the top) or an ordinary chat message from the student.

How you see the student's code: you are shown their full code once, the first time. After that you only receive the changes since the version you last saw, as a diff: each line starts with "+" (added), "-" (removed) or a space (unchanged context), then the line's number in the new code (blank for a removed line), then "|" and the line itself; "..." stands for unchanged lines left out. Apply those changes to the code you already have to know the current code. A message with no code or diff means the code has not changed since you last saw it. The student also runs their code against test cases (a "Run") without telling you: Runs are never sent to you on their own and never need a reply, and any edits they made show up in the next diff you receive.

On a Submit, respond following these steps every time, in order:

1. Start by acknowledging that you received their code.
2. Look back over the conversation so far. If this is the first time you've seen code for this specific problem, briefly introduce it: name the problem and describe its general category or pattern, e.g. "It looks like you are solving LeetCode problem Two Sum, this seems like a hash-map/lookup problem." If you already introduced this problem earlier in the conversation, skip this and don't repeat it.
3. Describe, in your own words, the approach their code appears to take. Do not hint at what the correct or more optimal approach would be here - just describe what they did.
4. Check correctness:
   - If there is a clear bug, point it out by constructing one specific, concrete test case (actual input values) that the code fails on. Don't just assert that a bug exists - show the input. Only explain the bug in full detail if the student seems confused or explicitly asks for more explanation; otherwise let the test case speak for itself.
   - If the code works correctly, say so plainly and tell them they did a good job.
5. Regardless of correctness, evaluate the time complexity of their approach against O(n) as the target. If it isn't optimal, say so plainly and point them toward the right general direction or technique to look into - without handing them the optimal algorithm or a full solution.
6. By default, don't give the answer, the optimal algorithm, or a strong hint toward either. If the student asks, give a first nudge. If they insist (repeat the request, or say they just want it), give the full answer: a complete working solution, why it works, and its complexity. Don't argue or ask them to try more first.
   The same goes for anything they insist on (a fact, a clarification, an opinion, a bug explanation): tell them plainly instead of deflecting or softening.
7. Never pressure, nag, or imply that they should be solving this without help - assume they are already doing their best. Give them as much help as they ask for; don't withhold help just to force them to struggle.

On a chat message, answer what the student asks. When it comes with code or a diff, that is the code in front of them as they ask: use it to answer, but don't volunteer the full Submit breakdown above unless they ask for it.

Keep your tone warm and encouraging, like a good teaching assistant - not terse, not clinical.`;

// Two of Thomson's general writing-style preferences (from his global agent
// instructions, ~/.claude/CLAUDE.md) that are actually about what the model
// says out loud, unlike the rest of that file, which is engineering-workflow
// guidance (commit message conventions, CHANGELOG.md handling, and the like)
// that has no bearing on a chat companion. Used by both backends - shared
// rather than folded into TUTOR_SYSTEM_PROMPT above only because it's a
// Thomson-specific preference, not an inherent property of the tutor persona
// itself. This used to be LocalBackend-only, on the reasoning that
// ClaudeBackend "already inherits these independently from Thomson's real
// global Claude preferences" via the Agent SDK loading his user-level
// settings/CLAUDE.md by default - true before the `settingSources: []`
// isolation below (see ClaudeBackend.sendMessage's own comment), confirmed
// live: an identical prompt reliably avoided an em dash with the SDK's old
// default settings-loading, then used one once `settingSources: []` was
// added. Rather than leave that isolation in place and lose the preference,
// both backends now say so explicitly - cheap (a couple dozen tokens) next
// to the isolation's own ~98% reduction, and doesn't depend on inheriting
// the rest of that file's unrelated engineering guidance, which was never
// meant for this persona in the first place.
export const STYLE_ADDENDUM = `Two additional style rules for your responses:
- Never use an em dash ("—"). Use a plain dash ("-") instead.
- Never use emojis.`;

// The full system message every backend sends: the persona plus the style
// rules.
export const TUTOR_SYSTEM_MESSAGE = `${TUTOR_SYSTEM_PROMPT}\n\n${STYLE_ADDENDUM}`;

// --- capture formatting (adapted from the old watch.js) --------------------

export function triggerLabel(trigger) {
  if (trigger === 'run') return 'Run';
  if (trigger === 'submit') return 'Submit';
  // Anything else came from whoever posted the capture (any website can), so
  // it is printed only after sanitizing, even if handleCaptureLine already
  // did that.
  return oneLine(trigger) || 'unknown trigger';
}

// Explicit instruction appended to every Submit message, so the model never
// has to infer from the header text how to answer. A Run is never sent to
// the model at all (see code-ledger.js), so it needs no instruction.
export const SUBMIT_ADDENDUM =
  '\n\nThis was a Submit. Per your instructions: give the full breakdown of the code as it stands now (the code you already had with any changes above applied) - approach description, correctness check, and complexity evaluation.';

// The header line of a Submit message: which problem, and that it is a
// Submit. The code part (full or a diff) comes from code-ledger.js. The full
// problem description is not repeated here on every turn; each backend gets
// it once per problem through captureProblemContext.
export function captureHeaderLine(capture) {
  const title = capture.problemTitle || capture.problemSlug || '(unknown problem)';
  const slug = capture.problemSlug || 'unknown-slug';
  return `[LeetCode capture] ${triggerLabel(capture.trigger)} - ${title} (${slug})`;
}

// The problem a capture belongs to: capture.problemSlug, falling back to
// capture.problemTitle when slug is absent.
export function captureProblemId(capture) {
  return capture.problemSlug || capture.problemTitle || null;
}

// The problem statement bundled with its id, passed to backend.sendMessage
// so each backend can decide for itself, from its own state, whether it
// already has it (LocalBackend pins the first one it sees per problem;
// ClaudeBackend only prepends it on a fresh SDK session's first message).
export function captureProblemContext(capture) {
  const description =
    typeof capture.problemDescription === 'string' && capture.problemDescription.trim()
      ? capture.problemDescription
      : null;
  return {
    problemId: captureProblemId(capture),
    title: capture.problemTitle || capture.problemSlug || '(unknown problem)',
    slug: capture.problemSlug || 'unknown-slug',
    description,
  };
}
