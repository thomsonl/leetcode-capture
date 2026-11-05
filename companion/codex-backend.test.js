// Tests for codex-backend.js against a fake `codex` executable.
//
// The real Codex CLI isn't available in CI, so the fake follows OpenAI's
// documented non-interactive contract (prompt on stdin when the argument is
// "-", JSON Lines events on stdout, `login status` exit code) and records what
// it was invoked with. This proves the invocation and parsing; it can't prove
// a real ChatGPT sign-in works, which has to be checked by hand with a real
// account.
//
// Run with: node --test codex-backend.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexBackend, buildCodexArgs, checkCodexLogin, codexSubscriptionEnv, parseCodexOutput } from './codex-backend.js';
import { SUMMARIZER_SYSTEM, SUMMARY_HEADER } from '../extension/shared/context-summary.js';

const FAKE = `
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE || 'ok';
if (args[0] === 'login') {
  console.log(process.env.FAKE_CODEX_LOGIN === 'no' ? 'Not logged in' : 'Logged in using ChatGPT');
  process.exit(process.env.FAKE_CODEX_LOGIN === 'no' ? 1 : 0);
}
let prompt = '';
process.stdin.on('data', (c) => (prompt += c));
process.stdin.on('end', () => {
  const rec = process.env.FAKE_CODEX_RECORD;
  const calls = fs.existsSync(rec) ? JSON.parse(fs.readFileSync(rec, 'utf8')) : [];
  calls.push({ args, prompt, hasCodexKey: 'CODEX_API_KEY' in process.env, hasOpenaiKey: 'OPENAI_API_KEY' in process.env });
  fs.writeFileSync(rec, JSON.stringify(calls));
  if (mode === 'hang') return setTimeout(() => {}, 60000);
  if (mode === 'fail-summary' && prompt.includes('You condense')) { console.error('summary failed'); process.exit(1); }
  if (mode === 'silent') { console.error('boom: not authenticated'); process.exit(1); }
  const emit = (e) => console.log(JSON.stringify(e));
  emit({ type: 'thread.started', thread_id: 't1' });
  emit({ type: 'turn.started' });
  if (mode === 'fail') {
    emit({ type: 'error', message: 'stream error' });
    emit({ type: 'turn.failed', error: { message: 'You are not logged in' } });
    process.exit(1);
  }
  emit({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'thinking about it' } });
  emit({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'FAKE-REPLY-' + calls.length } });
  emit({ type: 'turn.completed', usage: {} });
});
`;

function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-codex-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'fake-codex.cjs');
  fs.writeFileSync(script, FAKE);
  const record = path.join(dir, 'record.json');
  const env = { ...process.env, FAKE_CODEX_RECORD: record, CODEX_API_KEY: 'k1', OPENAI_API_KEY: 'k2', ...(extra.env || {}) };
  const backend = new CodexBackend({
    model: extra.model === undefined ? 'gpt-5-codex' : extra.model,
    cwd: path.join(dir, 'scratch'),
    systemPrompt: 'You are a patient coding tutor.',
    command: process.execPath,
    commandArgs: [script],
    env,
    ...(extra.backend || {}),
  });
  const allCalls = () => (fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : []);
  // Tutor turns only; the summary calls (condensing older exchanges) apart.
  const isSummary = (c) => c.prompt.startsWith(SUMMARIZER_SYSTEM);
  const calls = () => allCalls().filter((c) => !isSummary(c));
  const summaryCalls = () => allCalls().filter(isSummary);
  return { backend, calls, summaryCalls, allCalls, script, env, dir };
}

test('buildCodexArgs follows the documented non-interactive flags and reads the prompt from stdin', () => {
  assert.deepEqual(buildCodexArgs({ model: 'm1', cwd: '/s' }), [
    'exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-C', '/s', '-m', 'm1', '-',
  ]);
  assert.ok(!buildCodexArgs({ model: null, cwd: '/s' }).includes('-m'));
});

test('parseCodexOutput takes the last agent message and reports failures', () => {
  const ok = ['{"type":"turn.started"}', '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}', 'garbage', '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}'].join('\n');
  assert.deepEqual(parseCodexOutput(ok), { text: 'final', error: null });
  assert.equal(parseCodexOutput('{"type":"turn.failed","error":{"message":"nope"}}').error, 'nope');
  assert.equal(parseCodexOutput('{"type":"error","message":"stream died"}').error, 'stream died');
  assert.deepEqual(parseCodexOutput(''), { text: null, error: null });
});

test('the subscription environment drops API keys so a ChatGPT sign-in is never swapped for billing', () => {
  const env = codexSubscriptionEnv({ PATH: '/bin', CODEX_API_KEY: 'a', OPENAI_API_KEY: 'b', HOME: '/h' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});

test('a turn spawns codex with the right arguments, the prompt on stdin, and no API keys in its environment', async (t) => {
  const { backend, calls } = setup(t);
  const reply = await backend.sendMessage('Why is my loop slow?', {
    problemContext: { title: 'Two Sum', slug: 'two-sum', description: 'Given nums and a target...' },
  });
  assert.equal(reply, 'FAKE-REPLY-1');
  const [call] = calls();
  assert.deepEqual(call.args.slice(0, 7), ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-C']);
  assert.ok(call.args.includes('gpt-5-codex'));
  assert.equal(call.args.at(-1), '-');
  assert.equal(call.hasCodexKey, false);
  assert.equal(call.hasOpenaiKey, false);
  assert.match(call.prompt, /patient coding tutor/);
  assert.match(call.prompt, /Problem currently being discussed: Two Sum \(two-sum\)/);
  assert.match(call.prompt, /Given nums and a target/);
  assert.match(call.prompt, /Student: Why is my loop slow\?/);
});

test('later turns carry the conversation so far; resetContext clears it', async (t) => {
  const { backend, calls } = setup(t);
  await backend.sendMessage('first question');
  await backend.sendMessage('second question');
  const [, second] = calls();
  assert.match(second.prompt, /Student: first question\n\nTutor: FAKE-REPLY-1/);
  assert.match(second.prompt, /Student: second question/);
  backend.resetContext();
  await backend.sendMessage('fresh start');
  assert.ok(!calls()[2].prompt.includes('first question'));
});

test('history is bounded: older exchanges are condensed into one summary instead of dropped', async (t) => {
  const { backend, calls, summaryCalls } = setup(t, { backend: { maxHistoryTurns: 2 } });
  for (let i = 1; i <= 5; i += 1) await backend.sendMessage(`question ${i}`);
  // Turn 4 found three exchanges, one over the cap, and condensed the older
  // half (two) in one codex call.
  assert.equal(summaryCalls().length, 1);
  const summaryPrompt = summaryCalls()[0].prompt;
  assert.match(summaryPrompt, /under 250 words/);
  assert.ok(summaryPrompt.includes('question 1') && summaryPrompt.includes('question 2'));
  assert.ok(!summaryPrompt.includes('question 3'), 'only the exchanges being condensed go to the summary call');
  const last = calls()[4].prompt;
  assert.ok(last.includes('question 4') && last.includes('question 3'));
  assert.ok(!last.includes('question 2'), 'condensed turns are no longer sent whole');
  assert.ok(last.includes(`${SUMMARY_HEADER}\nFAKE-REPLY-4`), 'the summary stands in for them');
  backend.resetContext();
  await backend.sendMessage('after reset');
  assert.ok(!calls()[5].prompt.includes(SUMMARY_HEADER), 'a reset clears the summary');
});

test('a failed summary call falls back to the one-line-per-exchange digest', async (t) => {
  const { backend, calls, summaryCalls } = setup(t, { backend: { maxHistoryTurns: 1 }, env: { FAKE_CODEX_MODE: 'fail-summary' } });
  await backend.sendMessage('Why does my loop run forever? It never stops.');
  await backend.sendMessage('second');
  await backend.sendMessage('third');
  assert.equal(summaryCalls().length, 1);
  const third = calls()[2].prompt;
  assert.ok(third.includes(`${SUMMARY_HEADER}\n- Student: Why does my loop run forever? Tutor: FAKE-REPLY-1`), third);
  assert.ok(!third.includes('It never stops'), 'only the first sentence is kept');
});

test('held code is pinned and older full-code turns go compact, so dropping a turn never loses the code', async (t) => {
  const { backend, calls } = setup(t, { backend: { maxHistoryTurns: 1 } });
  const ctx = { problemId: 'two-sum', title: 'Two Sum', slug: 'two-sum', description: 'Given nums and a target...' };
  await backend.sendMessage('FULL-CODE-TURN def f(): pass', { problemContext: ctx, compactText: 'COMPACT-FIRST' });
  const held = { code: 'def f():\n    return 42', language: 'python3' };
  await backend.sendMessage('DIFF-TURN-2', { problemContext: ctx, currentCode: held, compactText: 'COMPACT-SECOND' });
  const second = calls()[1].prompt;
  assert.match(second, /The student's current code \(python3\), exactly as it is now/);
  assert.match(second, /return 42/);
  assert.match(second, /Student: COMPACT-FIRST/, 'the older full-code turn is sent compact');
  assert.ok(!second.includes('FULL-CODE-TURN'));
  assert.match(second, /Student: DIFF-TURN-2/, 'the current turn is sent whole');
  await backend.sendMessage('THIRD', { problemContext: ctx, currentCode: held });
  const third = calls()[2].prompt;
  assert.ok(!third.includes('COMPACT-FIRST'), 'the history cap dropped the first turn');
  assert.match(third, /return 42/, 'but the current code is still pinned');
  assert.match(third, /Given nums and a target/);
  backend.resetContext();
  await backend.sendMessage('after reset');
  assert.ok(!calls()[3].prompt.includes('return 42'), 'a reset drops the pinned code');
});

test('without a model flag configured, codex uses its own default', async (t) => {
  const { backend, calls } = setup(t, { model: null });
  await backend.sendMessage('hi');
  assert.ok(!calls()[0].args.includes('-m'));
});

test('a failed turn surfaces codex\'s own message', async (t) => {
  const { backend } = setup(t, { env: { FAKE_CODEX_MODE: 'fail' } });
  await assert.rejects(backend.sendMessage('hi'), /codex: You are not logged in/);
});

test('an exit with no reply points at "codex login" and includes the stderr tail', async (t) => {
  const { backend } = setup(t, { env: { FAKE_CODEX_MODE: 'silent' } });
  await assert.rejects(backend.sendMessage('hi'), /exited with code 1.*boom: not authenticated.*codex login/s);
});

test('a missing codex binary gives an install hint instead of a stack trace', async (t) => {
  const { backend } = setup(t, { backend: { command: '/nonexistent/codex-binary', commandArgs: [] } });
  await assert.rejects(backend.sendMessage('hi'), /Codex CLI was not found.*npm install -g @openai\/codex/s);
});

test('a hung codex is killed after the timeout', async (t) => {
  const { backend } = setup(t, { env: { FAKE_CODEX_MODE: 'hang' }, backend: { timeoutMs: 400 } });
  await assert.rejects(backend.sendMessage('hi'), /did not answer within/);
});

test('a failed turn does not poison the history', async (t) => {
  const { backend } = setup(t, { env: { FAKE_CODEX_MODE: 'fail' } });
  await assert.rejects(backend.sendMessage('lost question'));
  assert.deepEqual(backend.history, []);
});

test('checkCodexLogin reports the sign-in state and a missing binary', async (t) => {
  const { script, env } = setup(t);
  assert.equal((await checkCodexLogin({ command: process.execPath, commandArgs: [script], env })).ok, true);
  const no = await checkCodexLogin({ command: process.execPath, commandArgs: [script], env: { ...env, FAKE_CODEX_LOGIN: 'no' } });
  assert.equal(no.ok, false);
  assert.match(no.message, /Not logged in/);
  const missing = await checkCodexLogin({ command: '/nonexistent/codex-binary' });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /not found/);
});

test('the post-check guard re-ask carries the rejected reply and the rule, and only the shown text stays', async (t) => {
  const { backend, calls } = setup(t);
  await backend.sendMessage('Give me a hint.');
  const revised = await backend.reviseLastReply('Your reply above breaks the tutoring rules.');
  assert.equal(revised, 'FAKE-REPLY-2');
  const reask = calls()[1].prompt;
  assert.match(reask, /Student: Give me a hint\.\n\nTutor: FAKE-REPLY-1/);
  assert.match(reask, /Student: Your reply above breaks the tutoring rules\./);
  assert.equal(backend.history.length, 2, 'the re-ask is not kept');
  backend.replaceLastReply(revised);
  await backend.sendMessage('next');
  const next = calls()[2].prompt;
  assert.match(next, /Tutor: FAKE-REPLY-2/);
  assert.ok(!next.includes('FAKE-REPLY-1'));
  assert.ok(!next.includes('breaks the tutoring rules'));
});
