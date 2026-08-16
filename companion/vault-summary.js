// companion/vault-summary.js - vault auto-summary logic
//
// Split out from companion.js so this feature's actual logic (building the
// addendum, parsing the model's reply, writing the notes) can be exercised
// directly by tests without booting companion.js's interactive readline
// loop or relay-server lifecycle. See README.md → "Vault auto-summary" for
// the full design and companion.js for how this gets wired into the capture
// handling path.
//
// The core constraint shaping this file: reuse the same backend response
// already being shown in the terminal for a Submit, and never make a
// second LLM call just for the vault note. So buildVaultAddendum appends
// one extra instruction to the Submit message, asking the model to tack a
// machine-readable block onto the very end of the same reply it was
// already going to give; extractVaultBlock then peels that block back off
// before the reply is printed, so the chat experience is unchanged.
//
// Honest limitation, worth repeating here and in README.md: both "the
// optimal complexity for this problem" and "what complexity is this code"
// are things the model has to infer, not facts it can look up (LeetCode
// doesn't expose either). Reliable for well-known problems, could be wrong
// on obscure ones - the resulting star rating is a judgment call, not a
// verified fact.

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const vaultNotes = require('../vault-tool/vault-notes.js');

export const defaultVaultPath = vaultNotes.defaultVaultPath;

const VAULT_JSON_RE = /<<<VAULT_JSON>>>([\s\S]*?)<<<END_VAULT_JSON>>>/;
export const AI_NOTES_HEADER = '## AI Notes';
export const AI_TOPIC_INDEX_HEADER = '## AI Topic Index';

export function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

export function starRatingLine(stars) {
  const full = Math.max(0, Math.min(5, stars ?? 0));
  return `${'⭐'.repeat(full)}${'☆'.repeat(5 - full)} (${stars ?? '?'}/5)`;
}

// Gathers everything the model needs to make a well-grounded,
// continuity-aware judgment for this Submit, and builds the addendum
// instructing it to emit the structured block. Returns null if the capture
// doesn't carry enough to act on (missing slug/title - shouldn't happen
// with a current extension build, but captures can predate a field).
export function prepareVaultContext({ capture, vaultPath }) {
  if (!capture.problemSlug || !capture.problemTitle) return null;

  const tags = Array.isArray(capture.problemTags)
    ? capture.problemTags.filter((t) => typeof t === 'string' && t.trim())
    : [];

  const problemNotePath = vaultNotes.ensurePerProblemNoteFile(vaultPath, {
    problemSlug: capture.problemSlug,
    problemTitle: capture.problemTitle,
  });
  const priorAiNotes = vaultNotes.readSection(fs.readFileSync(problemNotePath, 'utf8'), AI_NOTES_HEADER);

  // Only tags that already have a curated Study/Algorithms/<Tag>.md note get
  // linked and rated - this deliberately doesn't invent a new topic note for
  // every raw LeetCode tag (see vault-notes.js's findTopicNoteByTagName).
  const matchedTopics = [];
  const topicNotePaths = {};
  const priorTopicIndexes = {};
  for (const tag of tags) {
    const topicPath = vaultNotes.findTopicNoteByTagName(vaultPath, tag);
    if (!topicPath) continue;
    matchedTopics.push(tag);
    topicNotePaths[tag] = topicPath;
    priorTopicIndexes[tag] = vaultNotes.readSection(fs.readFileSync(topicPath, 'utf8'), AI_TOPIC_INDEX_HEADER);
  }

  const addendum = buildVaultAddendum({ tags, matchedTopics, priorAiNotes, priorTopicIndexes });
  return { problemNotePath, tags, matchedTopics, topicNotePaths, addendum };
}

export function buildVaultAddendum({ tags, matchedTopics, priorAiNotes, priorTopicIndexes }) {
  const topicList = matchedTopics.length
    ? matchedTopics.join(', ')
    : "(none of this problem's topic tags have a matching topic note in the vault yet - omit topicProficiency entirely)";

  const lines = [
    '',
    '---',
    "This was a Submit capture with the vault auto-summary feature on. After your tutoring response above, append exactly one more block at the very end, between the literal markers <<<VAULT_JSON>>> and <<<END_VAULT_JSON>>>, containing a single-line JSON object (no markdown, no code fence around it) with these exact keys:",
    '- "rightThings": string, 1-3 sentences on what the student\'s submitted code does right, based on your analysis above.',
    '- "notConnecting": string, 1-3 sentences on what the student does not seem to be connecting or missing. If the solution is already fully correct and optimal, say so plainly here instead of inventing a gap.',
    '- "problemStars": integer 1-5, rating purely how this code\'s inferred time complexity compares to the best achievable time complexity for this exact problem. Matching the optimal is 5, regardless of what the optimal actually is. This is your best inference, not a verified fact.',
    '- "complexityNote": string, one sentence stating the inferred complexity of the submitted code and the inferred optimal complexity for this problem.',
    `- "topicProficiency": an object with one integer 1-10 entry per topic in [${topicList}], a holistic judgment of the student's overall proficiency at that topic across every attempt at it you know about (see prior context below) - not a strict average of star ratings. Key each entry by the exact topic name given.`,
    '',
    `This problem's LeetCode topic tags: ${tags.length ? tags.join(', ') : '(none captured)'}.`,
    '',
    'Existing "AI Notes" already recorded for this problem - factor this into your new notes rather than discarding it (this is the first submission logged for it if empty):',
    priorAiNotes || '(none yet)',
  ];
  for (const topic of matchedTopics) {
    lines.push(
      '',
      `Existing AI topic index for "${topic}", to factor into your topicProficiency judgment for it (empty if none yet):`,
      priorTopicIndexes[topic] || '(none yet)'
    );
  }
  return lines.join('\n');
}

// Splits a backend reply into the text meant for the terminal and the
// parsed vault JSON block, if the addendum's marker is present. Always
// strips the raw block from displayText, even if JSON.parse fails, so a
// malformed block never leaks into the chat transcript. `warn`, if given, is
// called with a message when the block is present but unparseable.
export function extractVaultBlock(text, { warn } = {}) {
  const match = text.match(VAULT_JSON_RE);
  if (!match) return { displayText: text, vaultData: null };

  const displayText = (text.slice(0, match.index) + text.slice(match.index + match[0].length))
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  let vaultData = null;
  try {
    vaultData = JSON.parse(match[1].trim());
  } catch (err) {
    if (warn) warn(`could not parse vault auto-summary JSON (${err.message})`);
  }
  return { displayText, vaultData };
}

// Rewrites a per-problem note's "AI Notes" section and every matched topic
// note's "AI Topic Index" section in place. The topic index is rebuilt as
// an overall proficiency line plus one wikilinked bullet per problem
// attempted under that topic, keyed by title so updating one problem's line
// never disturbs the others.
export function writeVaultAutoSummary({ capture, vaultContext, vaultData }) {
  const stars = clampInt(vaultData.problemStars, 1, 5);
  const topicsLine = vaultContext.tags.length
    ? vaultContext.tags.map((tag) => (vaultContext.matchedTopics.includes(tag) ? `[[${tag}]]` : tag)).join(', ')
    : '(none captured)';
  const updatedAt = new Date().toISOString();

  const aiNotesBody = [
    `**Rating:** ${starRatingLine(stars)}`,
    `**Complexity:** ${vaultData.complexityNote || '(not provided)'}`,
    `**Topics:** ${topicsLine}`,
    '',
    `**Doing right:** ${vaultData.rightThings || '(not provided)'}`,
    '',
    `**Not connecting:** ${vaultData.notConnecting || '(not provided)'}`,
    '',
    `*Last updated ${updatedAt} after submit attempt #${capture.attemptSeq ?? '?'}. Rating is an AI inference, not a verified fact - both the optimal complexity for this problem and this code's complexity are estimated by the model, not looked up. Reliable for well-known problems, may be wrong on obscure ones.*`,
  ].join('\n');

  const problemContent = fs.readFileSync(vaultContext.problemNotePath, 'utf8');
  fs.writeFileSync(vaultContext.problemNotePath, vaultNotes.upsertSection(problemContent, AI_NOTES_HEADER, aiNotesBody));

  for (const topic of vaultContext.matchedTopics) {
    const topicPath = vaultContext.topicNotePaths[topic];
    const proficiency = clampInt(vaultData.topicProficiency && vaultData.topicProficiency[topic], 1, 10);
    const topicContent = fs.readFileSync(topicPath, 'utf8');
    const existingBody = vaultNotes.readSection(topicContent, AI_TOPIC_INDEX_HEADER);

    const bulletsByTitle = new Map();
    if (existingBody) {
      for (const line of existingBody.split('\n')) {
        const m = line.match(/^- \[\[(.+?)\]\] - (.+)$/);
        if (m) bulletsByTitle.set(m[1], m[2]);
      }
    }
    bulletsByTitle.set(capture.problemTitle, starRatingLine(stars));

    const sortedTitles = Array.from(bulletsByTitle.keys()).sort((a, b) => a.localeCompare(b));
    const overallLine =
      proficiency !== null
        ? `**Overall proficiency:** ${proficiency}/10 (AI holistic judgment)`
        : existingBody?.match(/^\*\*Overall proficiency:.*$/m)?.[0] || '**Overall proficiency:** (not yet rated)';
    const newBody = [overallLine, '', ...sortedTitles.map((title) => `- [[${title}]] - ${bulletsByTitle.get(title)}`)].join(
      '\n'
    );

    fs.writeFileSync(topicPath, vaultNotes.upsertSection(topicContent, AI_TOPIC_INDEX_HEADER, newBody));
  }
}
