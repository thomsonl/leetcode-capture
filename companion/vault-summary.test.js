// Regression test for the vault auto-summary feature's actual logic
// (companion/vault-summary.js), exercised directly against real temp files
// so it doesn't need a live backend or the companion's readline loop -
// see that file's header for the design this backs. companion/ had no
// automated tests before this feature; this is the first.
//
// Run with: node --test companion/vault-summary.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { prepareVaultContext, buildVaultAddendum, extractVaultBlock, writeVaultAutoSummary } from './vault-summary.js';

function makeTempVault() {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'leetcode-capture-vault-summary-test-'));
  fs.mkdirSync(path.join(vaultPath, 'Study', 'Algorithms'), { recursive: true });
  return vaultPath;
}

function writeTopicNote(vaultPath, name, body) {
  const p = path.join(vaultPath, 'Study', 'Algorithms', `${name}.md`);
  fs.writeFileSync(p, body);
  return p;
}

test('prepareVaultContext only matches tags that already have a topic note, and reads prior AI Notes', () => {
  const vaultPath = makeTempVault();
  writeTopicNote(vaultPath, 'Dynamic Programming', '---\ntags:\n  - study/algorithms\n---\n\nDP notes.\n');
  // "Array" deliberately has no note - matches Two Sum's real LeetCode tags.

  const capture = {
    problemSlug: 'house-robber',
    problemTitle: '198. House Robber',
    problemTags: ['Array', 'Dynamic Programming'],
    attemptSeq: 1,
  };

  const ctx = prepareVaultContext({ capture, vaultPath });
  assert.deepEqual(ctx.matchedTopics, ['Dynamic Programming']);
  assert.equal(ctx.tags.length, 2);
  assert.match(ctx.addendum, /VAULT_JSON/);
  assert.match(ctx.addendum, /Dynamic Programming/);
  assert.ok(fs.existsSync(ctx.problemNotePath));
  assert.match(fs.readFileSync(ctx.problemNotePath, 'utf8'), /198\. House Robber/);
});

test('prepareVaultContext returns null when the capture lacks a slug or title', () => {
  const vaultPath = makeTempVault();
  assert.equal(prepareVaultContext({ capture: { problemTitle: 'X' }, vaultPath }), null);
  assert.equal(prepareVaultContext({ capture: { problemSlug: 'x' }, vaultPath }), null);
});

test('buildVaultAddendum omits topicProficiency guidance when no tag matched a topic note', () => {
  const addendum = buildVaultAddendum({ tags: ['Array'], matchedTopics: [], priorAiNotes: null, priorTopicIndexes: {} });
  assert.match(addendum, /omit topicProficiency entirely/);
});

test('extractVaultBlock strips the JSON block from the display text and parses it', () => {
  const reply = [
    'Nice work, your two-pointer approach is correct.',
    '',
    '<<<VAULT_JSON>>>',
    '{"rightThings":"Correct two-pointer usage.","notConnecting":"Nothing major.","problemStars":5,"complexityNote":"O(n), matches optimal.","topicProficiency":{"Array":8}}',
    '<<<END_VAULT_JSON>>>',
  ].join('\n');

  const { displayText, vaultData } = extractVaultBlock(reply);
  assert.equal(displayText, 'Nice work, your two-pointer approach is correct.');
  assert.equal(vaultData.problemStars, 5);
  assert.equal(vaultData.topicProficiency.Array, 8);
});

test('extractVaultBlock is a no-op when there is no marker (e.g. a Run capture or typed chat)', () => {
  const reply = 'Just a normal reply with no vault block.';
  const { displayText, vaultData } = extractVaultBlock(reply);
  assert.equal(displayText, reply);
  assert.equal(vaultData, null);
});

test('extractVaultBlock still strips a malformed block and calls warn instead of throwing', () => {
  const reply = 'Hi.\n<<<VAULT_JSON>>>not valid json<<<END_VAULT_JSON>>>';
  let warned = null;
  const { displayText, vaultData } = extractVaultBlock(reply, { warn: (msg) => (warned = msg) });
  assert.equal(displayText, 'Hi.');
  assert.equal(vaultData, null);
  assert.match(warned, /could not parse/);
});

test('writeVaultAutoSummary rewrites the AI Notes section in place, factoring in nothing being lost elsewhere in the file', () => {
  const vaultPath = makeTempVault();
  writeTopicNote(vaultPath, 'Dynamic Programming', '---\ntags:\n  - study/algorithms\n---\n\nDP notes.\n\n## LeetCode Problems\n\n- [ ] [198. House Robber](https://leetcode.com/problems/house-robber/)\n');

  const capture = {
    problemSlug: 'house-robber',
    problemTitle: '198. House Robber',
    problemTags: ['Dynamic Programming'],
    attemptSeq: 1,
  };
  const vaultContext = prepareVaultContext({ capture, vaultPath });

  writeVaultAutoSummary({
    capture,
    vaultContext,
    vaultData: {
      rightThings: 'Correctly identifies the DP recurrence.',
      notConnecting: 'Not yet using O(1) space.',
      problemStars: 4,
      complexityNote: 'O(n) time, which matches optimal; O(n) space where O(1) is achievable.',
      topicProficiency: { 'Dynamic Programming': 6 },
    },
  });

  const problemContent = fs.readFileSync(vaultContext.problemNotePath, 'utf8');
  assert.match(problemContent, /## AI Notes/);
  assert.match(problemContent, /4\/5/);
  assert.match(problemContent, /\[\[Dynamic Programming\]\]/);
  assert.match(problemContent, /Correctly identifies the DP recurrence\./);

  const topicPath = vaultContext.topicNotePaths['Dynamic Programming'];
  const topicContent = fs.readFileSync(topicPath, 'utf8');
  // The pre-existing curated checklist must survive untouched.
  assert.match(topicContent, /## LeetCode Problems\n\n- \[ \] \[198\. House Robber\]/);
  assert.match(topicContent, /## AI Topic Index/);
  assert.match(topicContent, /6\/10/);
  assert.match(topicContent, /- \[\[198\. House Robber\]\] - .*4\/5/);
});

test('writeVaultAutoSummary preserves other problems already in a topic index when updating one', () => {
  const vaultPath = makeTempVault();
  const topicPath = writeTopicNote(
    vaultPath,
    'Dynamic Programming',
    '---\ntags:\n  - study/algorithms\n---\n\n## AI Topic Index\n\n**Overall proficiency:** 5/10 (AI holistic judgment)\n\n- [[70. Climbing Stairs]] - ⭐⭐⭐⭐⭐ (5/5)\n'
  );

  const capture = {
    problemSlug: 'house-robber',
    problemTitle: '198. House Robber',
    problemTags: ['Dynamic Programming'],
    attemptSeq: 2,
  };
  const vaultContext = prepareVaultContext({ capture, vaultPath });
  assert.equal(vaultContext.topicNotePaths['Dynamic Programming'], topicPath);

  writeVaultAutoSummary({
    capture,
    vaultContext,
    vaultData: {
      rightThings: 'Good.',
      notConnecting: 'Nothing major.',
      problemStars: 3,
      complexityNote: 'O(n) time, matches optimal.',
      topicProficiency: { 'Dynamic Programming': 7 },
    },
  });

  const topicContent = fs.readFileSync(topicPath, 'utf8');
  assert.match(topicContent, /7\/10/);
  assert.match(topicContent, /\[\[70\. Climbing Stairs\]\] - ⭐⭐⭐⭐⭐ \(5\/5\)/);
  assert.match(topicContent, /\[\[198\. House Robber\]\] - ⭐⭐⭐☆☆ \(3\/5\)/);
});

test('writeVaultAutoSummary is idempotent for a repeated identical submission', () => {
  const vaultPath = makeTempVault();
  writeTopicNote(vaultPath, 'Dynamic Programming', '---\ntags:\n  - study/algorithms\n---\n');

  const capture = {
    problemSlug: 'house-robber',
    problemTitle: '198. House Robber',
    problemTags: ['Dynamic Programming'],
    attemptSeq: 1,
  };
  const vaultContext = prepareVaultContext({ capture, vaultPath });
  const vaultData = {
    rightThings: 'Good.',
    notConnecting: 'Nothing.',
    problemStars: 5,
    complexityNote: 'O(n), matches optimal.',
    topicProficiency: { 'Dynamic Programming': 8 },
  };

  writeVaultAutoSummary({ capture, vaultContext, vaultData });
  const first = fs.readFileSync(vaultContext.problemNotePath, 'utf8');
  writeVaultAutoSummary({ capture, vaultContext, vaultData });
  const second = fs.readFileSync(vaultContext.problemNotePath, 'utf8');

  // Only the timestamp line legitimately changes between two identical
  // writes; strip it before comparing so the test isn't a flaky clock race.
  const stripTimestamp = (s) => s.replace(/Last updated .*? after submit/, 'Last updated <ts> after submit');
  assert.equal(stripTimestamp(first), stripTimestamp(second));
});
