// Regression test for the shared vault note helpers (vault-notes.js). These
// back both the manual CLI (log-session.js) and the companion's automatic
// vault-summary feature, so a bug here silently corrupts real vault notes on
// both paths. Exercises real files under a temp directory, not mocks.
//
// Run with: node --test vault-tool/vault-notes.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  safeFileName,
  findTopicNoteByProblemLink,
  findTopicNoteByTagName,
  ensurePerProblemNoteFile,
  readSection,
  upsertSection,
} = require("./vault-notes");

function makeTempVault() {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "leetcode-capture-vault-test-"));
  const algDir = path.join(vaultPath, "Study", "Algorithms");
  fs.mkdirSync(algDir, { recursive: true });
  return vaultPath;
}

test("safeFileName strips filesystem-unsafe characters", () => {
  assert.equal(safeFileName('A/B: C? "D"'), "A-B- C- -D-");
});

test("findTopicNoteByProblemLink matches on existing content link, not filename", () => {
  const vaultPath = makeTempVault();
  const notePath = path.join(vaultPath, "Study", "Algorithms", "Arrays and Hashing.md");
  fs.writeFileSync(
    notePath,
    "## LeetCode Problems\n\n- [x] [1. Two Sum](https://leetcode.com/problems/two-sum/)\n"
  );

  const found = findTopicNoteByProblemLink(vaultPath, "two-sum");
  assert.equal(found, notePath);
  assert.equal(findTopicNoteByProblemLink(vaultPath, "house-robber"), null);
});

test("findTopicNoteByTagName matches an existing topic note by filename, case-insensitively", () => {
  const vaultPath = makeTempVault();
  const notePath = path.join(vaultPath, "Study", "Algorithms", "Dynamic Programming.md");
  fs.writeFileSync(notePath, "---\ntags:\n  - study/algorithms\n---\n\nDP notes.\n");

  assert.equal(findTopicNoteByTagName(vaultPath, "dynamic programming"), notePath);
  assert.equal(findTopicNoteByTagName(vaultPath, "Dynamic Programming"), notePath);
  // A raw LeetCode tag with no curated note yet must not match anything -
  // the automatic feature relies on this to avoid inventing stub topic notes.
  assert.equal(findTopicNoteByTagName(vaultPath, "Array"), null);
});

test("ensurePerProblemNoteFile creates a note once and reuses it on repeat calls", () => {
  const vaultPath = makeTempVault();
  const args = { problemSlug: "house-robber", problemTitle: "198. House Robber" };

  const firstPath = ensurePerProblemNoteFile(vaultPath, args);
  assert.match(fs.readFileSync(firstPath, "utf8"), /198\. House Robber.*leetcode\.com\/problems\/house-robber/s);

  // Simulate the note having since been edited (e.g. an AI Notes section
  // added by a prior submit); a second call must not clobber it.
  fs.appendFileSync(firstPath, "\n## AI Notes\n\nexisting content\n");
  const secondPath = ensurePerProblemNoteFile(vaultPath, args);
  assert.equal(secondPath, firstPath);
  assert.match(fs.readFileSync(secondPath, "utf8"), /existing content/);
});

test("upsertSection inserts, replaces in place, and is idempotent", () => {
  let content = "---\ntags:\n  - study/algorithms\n---\n\n[Title](url)\n";

  content = upsertSection(content, "## AI Notes", "**Rating:** 3/5\n\nfirst pass");
  assert.match(content, /## AI Notes\n\n\*\*Rating:\*\* 3\/5\n\nfirst pass/);

  content += "\n## Other Section\n\nunrelated, must survive\n";

  const rewritten = upsertSection(content, "## AI Notes", "**Rating:** 5/5\n\nsecond pass");
  assert.match(rewritten, /\*\*Rating:\*\* 5\/5\n\nsecond pass/);
  assert.doesNotMatch(rewritten, /first pass/);
  assert.match(rewritten, /## Other Section\n\nunrelated, must survive/);

  const rewrittenAgain = upsertSection(rewritten, "## AI Notes", "**Rating:** 5/5\n\nsecond pass");
  assert.equal(rewrittenAgain, rewritten, "re-applying the same body must be a no-op");
});

test("readSection returns null for a missing section and the trimmed body for an existing one", () => {
  const content = "# Note\n\n## AI Notes\n\nbody text here\n\n## Next\n\nother\n";
  assert.equal(readSection(content, "## AI Notes"), "body text here");
  assert.equal(readSection(content, "## Missing"), null);
});
