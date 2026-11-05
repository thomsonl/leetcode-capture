// Unit tests for extension/shared/reply-guard.js, the post-check guard for
// the tutor's prompt rules. Run with `npm test` in extension/.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMessage,
  repairProse,
  namedTechniques,
  unnamedTechniques,
  isCodeBlock,
  splitUnits,
  checkHeld,
  turnPolicy,
  salvage,
  reaskPrompt,
  createReplyGuard,
  guardedSend,
  FALLBACK_TEXT,
  FIRST_HINT_MAX_CHARS,
} from './shared/reply-guard.js';

const EM = '\u2014';
const EN = '\u2013';
const islandCode = `def count_islands(grid):
    seen = set()
    def visit(r, c):
        if (r, c) in seen or grid[r][c] != '1':
            return
        seen.add((r, c))
        visit(r+1, c); visit(r-1, c); visit(r, c+1)
    count = 0
    for r in range(len(grid)):
        for c in range(len(grid[0])):
            if grid[r][c] == '1' and (r, c) not in seen:
                count += 1; visit(r, c)
    return count`;
const twoSum = `def two_sum(nums, target):
    for i in range(len(nums)):
        for j in range(i, len(nums)):
            if nums[i] + nums[j] == target: return [i, j]`;

// Splits text into pieces of `size` characters, like a stream.
function pieces(text, size = 3) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

// A backend double: streams `replies` in order (one per sendMessage or
// reviseLastReply call) and records history the way LocalBackend does.
function fakeBackend(replies, { revise = true, stream = true, honorStop = true } = {}) {
  const queue = [...replies];
  const backend = {
    history: [],
    sent: [],
    instructions: [],
    stopped: 0,
    async sendMessage(text, { onChunk, shouldStop } = {}) {
      backend.sent.push(text);
      let reply = queue.shift();
      if (reply instanceof Error) throw reply;
      if (stream && onChunk) {
        let soFar = '';
        for (const piece of pieces(reply)) {
          soFar += piece;
          onChunk(piece);
          if (honorStop && shouldStop && shouldStop(soFar)) {
            backend.stopped += 1;
            reply = soFar;
            break;
          }
        }
      }
      backend.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      return reply;
    },
    replaceLastReply(text) {
      backend.history[backend.history.length - 1].content = text;
    },
  };
  if (revise) {
    backend.reviseLastReply = async (instruction) => {
      backend.instructions.push(instruction);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    };
  }
  return backend;
}

async function run(backend, guard, { text, trigger = null, code = islandCode }) {
  const turn = guard.begin({ text, trigger, code });
  const seen = [];
  const shown = await guardedSend({ backend, text: text || 'capture', turn, onText: (piece) => seen.push(piece) });
  return { shown, seen, turn };
}

test('classifyMessage tells the turn kinds apart', () => {
  assert.equal(classifyMessage('Give me a hint.').kind, 'hint');
  assert.equal(classifyMessage('Another hint, please.', { hintsGiven: 1 }).hintNumber, 2);
  assert.equal(classifyMessage("I'm stuck.").kind, 'stuck');
  assert.equal(classifyMessage("I'm stuck, why does seen matter?").kind, 'chat');
  assert.equal(classifyMessage('Is there a better way?').kind, 'alternatives');
  assert.equal(classifyMessage('What other methods can solve this?').kind, 'alternatives');
  assert.equal(classifyMessage('Is there a better way? Show me the code.').kind, 'answer');
  assert.equal(classifyMessage('Give me the full solution with code.').kind, 'answer');
  assert.equal(classifyMessage('I insist on the complete answer and code.').kind, 'answer');
  assert.equal(classifyMessage('How do I fix this?').kind, 'answer');
  assert.equal(classifyMessage('Can my code use the same element twice?').kind, 'chat');
  assert.equal(classifyMessage('What is my time complexity?').kind, 'chat');
  assert.equal(classifyMessage('anything', { trigger: 'submit' }).kind, 'submit');
});

test('repairProse fixes dashes, emoji and arrows outside inline code', () => {
  assert.equal(repairProse(`It works ${EM} mostly.`), 'It works, mostly.');
  assert.equal(repairProse(`word${EM}word`), 'word, word');
  assert.equal(repairProse(`the case ${EN} a single island`), 'the case, a single island');
  assert.equal(repairProse(`n ${EN} 1`), `n ${EN} 1`);
  assert.equal(repairProse('Nice work \u{1F389} here'), 'Nice work here');
  assert.equal(repairProse('a \u2192 b'), 'a -> b');
  assert.equal(repairProse(`keep \`a ${EM} b\` as is ${EM} fine`), `keep \`a ${EM} b\` as is, fine`);
  assert.equal(repairProse(`done ${EM}.`), 'done.');
});

test('a technique counts as named from the words, the code or its signals', () => {
  const fromCode = namedTechniques({ code: islandCode });
  assert.ok(fromCode.has('dfs'), 'a self-calling function names DFS');
  assert.ok(fromCode.has('hash-set'), 'set() names a hash set');
  assert.ok(!fromCode.has('bfs'));
  assert.deepEqual(unnamedTechniques('Try a breadth\u2011first search.', fromCode), ['breadth-first']);
  assert.deepEqual(unnamedTechniques('Your depth-first search recurses.', fromCode), []);
  assert.ok(namedTechniques({ prose: 'Could BFS work here?' }).has('bfs'));
  assert.ok(namedTechniques({ code: 'seen = {}\n' }).has('hash-map'));
});

test('isCodeBlock tells code from example inputs and diagrams', () => {
  assert.equal(isCodeBlock('python', 'nums = [1, 0, 2]'), false);
  assert.equal(isCodeBlock('python', "grid = [['1'] * 300 for _ in range(300)]"), false);
  assert.equal(isCodeBlock('python', twoSum), true);
  assert.equal(isCodeBlock('', '+---+---+\n| 1 | 0 |\n+---+---+'), false);
  assert.equal(isCodeBlock('', 'for (int i = 0; i < n; i++) {\n  x += i;\n}'), true);
});

test('splitUnits keeps every character and finds fences and sentences', () => {
  const text = 'First one. Second one?\n\n```python\nx = 1\n```\nAfter: done.';
  const units = splitUnits(text);
  assert.equal(units.map((u) => u.text).join(''), text);
  assert.deepEqual(units.map((u) => u.type), ['prose', 'prose', 'prose', 'fence', 'prose']);
  assert.equal(units[3].info, 'python');
  assert.equal(units[3].body, 'x = 1');
});

test('checkHeld flags each first-hint rule', () => {
  const policy = turnPolicy({ kind: 'hint', hintNumber: 1 });
  const context = { named: namedTechniques({ code: twoSum }), code: twoSum };
  const rules = (text) => checkHeld(text, policy, context).map((v) => v.rule);
  assert.deepEqual(rules('What does your inner loop compare on each pass?'), []);
  assert.deepEqual(rules('Which data could a dictionary look up as you scan?'), ['technique']);
  assert.deepEqual(rules('Could this run in O(n) time?'), ['complexity']);
  assert.deepEqual(rules('What happens if no two numbers add up to the target?'), ['edge-case']);
  assert.deepEqual(rules('Look:\n```\nfor j in range(i + 1, n):\n    pass\n```'), ['fence']);
  assert.ok(rules('x'.repeat(FIRST_HINT_MAX_CHARS + 1)).includes('length'));
});

test('a stuck reply must ask what they tried', () => {
  const policy = turnPolicy({ kind: 'stuck' });
  const context = { named: namedTechniques({ code: islandCode }), code: islandCode };
  assert.deepEqual(checkHeld('What have you tried so far, and which step is unclear?', policy, context), []);
  const rules = checkHeld('What neighbor does your visit function miss?', policy, context).map((v) => v.rule);
  assert.deepEqual(rules, ['question']);
});

test('salvage keeps only the safe sentences of a held reply', () => {
  const policy = turnPolicy({ kind: 'hint', hintNumber: 1 });
  const context = { named: namedTechniques({ code: twoSum }), code: twoSum };
  assert.equal(
    salvage('What does your inner loop repeat? A hash map would make that constant time.', policy, context),
    'What does your inner loop repeat?'
  );
  assert.equal(salvage('Use a hash map.', policy, context), '');
});

test('reaskPrompt names the broken rules and the shape wanted', () => {
  const prompt = reaskPrompt([{ rule: 'technique', detail: 'hash map' }, { rule: 'length' }], turnPolicy({ kind: 'hint', hintNumber: 1 }));
  assert.match(prompt, /names a method or data structure the student has not mentioned \("hash map"\)/);
  assert.match(prompt, /It is too long\./);
  assert.match(prompt, /one short question/);
  assert.doesNotMatch(prompt, /\u2014/);
});

test('a clean held hint is shown whole, once, with repairs', async () => {
  const backend = fakeBackend([`What does your visit function do ${EM} for each neighbor?`]);
  const { shown, seen } = await run(backend, createReplyGuard(), { text: 'Give me a hint.' });
  assert.equal(shown, 'What does your visit function do, for each neighbor?');
  assert.deepEqual(seen, [shown], 'a held reply arrives as one piece');
  assert.equal(backend.history.at(-1).content, shown, 'history holds the repaired text');
});

test('a leaking first hint is re-asked once and the leak is never shown or kept', async () => {
  const leak = 'Use a breadth-first search with a queue so each cell is visited once in O(n) time.';
  const clean = 'Which neighbors does your visit function call for each cell?';
  const backend = fakeBackend([leak, clean]);
  const { shown, seen } = await run(backend, createReplyGuard(), { text: 'Give me a hint.' });
  assert.equal(shown, clean);
  assert.deepEqual(seen, [clean]);
  assert.equal(backend.instructions.length, 1);
  assert.match(backend.instructions[0], /breadth-first/);
  assert.ok(!JSON.stringify(backend.history).includes('breadth-first'), 'the rejected reply left history');
  assert.ok(!JSON.stringify(backend.history).includes('breaks the tutoring rules'), 'the re-ask is not kept');
});

test('a re-ask that fails too falls back to what is safe, then to the fallback text', async () => {
  const backend = fakeBackend(['Use a queue for BFS.', 'Try BFS instead.']);
  const { shown } = await run(backend, createReplyGuard(), { text: 'Give me a hint.' });
  assert.equal(shown, FALLBACK_TEXT.hint);
  assert.equal(backend.history.at(-1).content, FALLBACK_TEXT.hint);

  const second = fakeBackend(['Use BFS. What does seen hold after one call?', new Error('model down')]);
  const result = await run(second, createReplyGuard(), { text: 'Give me a hint.' });
  assert.equal(result.shown, 'What does seen hold after one call?');
});

test('a backend without reviseLastReply gets the salvage, never a loop', async () => {
  const backend = fakeBackend(['Try BFS. What does seen hold?'], { revise: false });
  const { shown } = await run(backend, createReplyGuard(), { text: 'Give me a hint.' });
  assert.equal(shown, 'What does seen hold?');
  assert.equal(backend.sent.length, 1);
});

test('a runaway held reply is stopped early', async () => {
  const long = `Here is the idea.\n\n\`\`\`python\n${islandCode}\n\`\`\`\n${'More words. '.repeat(100)}`;
  const backend = fakeBackend([long, 'What does seen hold after one call to visit?']);
  const { shown } = await run(backend, createReplyGuard(), { text: 'Give me a hint.' });
  assert.equal(backend.stopped, 1);
  assert.equal(shown, 'What does seen hold after one call to visit?');
});

test('a chat reply streams sentence by sentence and drops an unrequested fix', async () => {
  const reply = [
    'Yes. Your inner loop starts at `j = i`, so the pair (i, i) is checked.',
    '',
    'To fix this, start the inner loop at `i + 1`:',
    '',
    '```python',
    'for i in range(len(nums)):',
    '    for j in range(i + 1, len(nums)):',
    '        if nums[i] + nums[j] == target: return [i, j]',
    '```',
    '',
    'This way j is always larger than i.',
  ].join('\n');
  const backend = fakeBackend([reply]);
  const { shown, seen } = await run(backend, createReplyGuard(), { text: 'Can my code use the same element twice?', code: twoSum });
  assert.equal(seen.join(''), shown, 'the result is exactly what streamed');
  assert.ok(seen.length >= 2, 'it streamed in more than one piece');
  assert.match(shown, /^Yes\. Your inner loop starts at `j = i`/);
  assert.doesNotMatch(shown, /To fix|range\(i \+ 1|This way/);
  assert.equal(backend.history.at(-1).content, shown);
  // Never any text that a later piece takes back: every piece is a prefix
  // extension of the result.
  let prefix = '';
  for (const piece of seen) {
    prefix += piece;
    assert.ok(shown.startsWith(prefix));
  }
});

test('the same reply streams to the same text whatever the chunk size', async () => {
  const reply = `No. A 300 by 300 grid recurses 90,000 deep ${EM} past Python's limit.\n\n\`\`\`python\ngrid = [['1'] * 300 for _ in range(300)]\n\`\`\`\nAn iterative version with a queue would avoid it. Either way, recursion is the issue.`;
  const results = new Set();
  for (const size of [1, 2, 5, 13, 1000]) {
    const queue = [reply];
    const backend = {
      async sendMessage(_text, { onChunk }) {
        const value = queue.shift();
        for (const piece of pieces(value, size)) onChunk(piece);
        return value;
      },
    };
    const turn = createReplyGuard().begin({ text: 'Will a 300 by 300 all-land grid work?', code: islandCode });
    results.add(await guardedSend({ backend, text: 'q', turn }));
  }
  assert.equal(results.size, 1);
  const [shown] = results;
  assert.match(shown, /past Python's limit\./);
  assert.match(shown, /grid = \[\['1'\] \* 300/, 'an example input block stays');
  assert.doesNotMatch(shown, /iterative|queue|Either way/);
  assert.doesNotMatch(shown, /\u2014/);
});

test('a Submit review drops a verdict guess and a volunteered method', async () => {
  const reply = 'Your code checks every pair. It is correct and would be accepted. A hash map would bring this down to O(n). Readability is good.';
  const backend = fakeBackend([reply]);
  const { shown } = await run(backend, createReplyGuard(), { text: null, trigger: 'submit', code: twoSum });
  assert.equal(shown, 'Your code checks every pair. Readability is good.');
});

test('an answer turn streams word by word with repairs only, code untouched', async () => {
  const reply = `Here ${EM} the full code:\n\n\`\`\`python\nx = 1  # a ${EM} b\n\n\nprint(x)\n\`\`\`\nDone.`;
  const backend = fakeBackend([reply]);
  const { shown, seen } = await run(backend, createReplyGuard(), { text: 'Give me the full solution with code.' });
  assert.equal(shown, `Here, the full code:\n\n\`\`\`python\nx = 1  # a ${EM} b\n\n\nprint(x)\n\`\`\`\nDone.`);
  assert.ok(seen.length > 4, 'it streamed in small pieces');
});

test('a streamed reply with nothing left is re-asked before anything shows', async () => {
  const backend = fakeBackend(['```python\nfor i in range(n):\n    pass\n```', 'The idea is to remember what you have seen while you scan once.']);
  const { shown, seen } = await run(backend, createReplyGuard(), { text: 'Is there a better way?', code: twoSum });
  assert.equal(shown, 'The idea is to remember what you have seen while you scan once.');
  assert.deepEqual(seen, [shown]);
});

test('the guard counts hints and remembers what was shown', async () => {
  const guard = createReplyGuard();
  const backend = fakeBackend(['What does visit check first?', 'Which direction does visit never try?']);
  await run(backend, guard, { text: 'Give me a hint.' });
  assert.equal(guard.hintsGiven, 1);
  const second = guard.begin({ text: 'Another hint, please.', code: islandCode });
  assert.equal(second.policy.hintNumber, 2);
  guard.reset();
  assert.equal(guard.hintsGiven, 0);
  // A method the tutor already showed is no longer volunteering.
  const shownGuard = createReplyGuard();
  await run(fakeBackend(['Other methods: BFS with a queue explores layer by layer.']), shownGuard, { text: 'What other methods can solve this?' });
  assert.ok(shownGuard.begin({ text: 'ok', code: islandCode }).context.named.has('bfs'));
});

test('a cut-off error carries only what may be shown', async () => {
  const cut = Object.assign(new Error('cut off'), { cutOff: true, partialReply: 'Try BFS. What does seen hold?' });
  const backend = { async sendMessage() { throw cut; } };
  const turn = createReplyGuard().begin({ text: 'Give me a hint.', code: islandCode });
  const seen = [];
  await assert.rejects(guardedSend({ backend, text: 'q', turn, onText: (p) => seen.push(p) }), (err) => {
    assert.equal(err.partialReply, 'What does seen hold?');
    return true;
  });
  assert.deepEqual(seen, ['What does seen hold?']);
});

test('no turn means the old unguarded call', async () => {
  const seen = [];
  const backend = { async sendMessage(_t, { onChunk }) { onChunk(`a ${EM} b`); return `a ${EM} b`; } };
  assert.equal(await guardedSend({ backend, text: 'q', turn: null, onText: (p) => seen.push(p) }), `a ${EM} b`);
  assert.deepEqual(seen, [`a ${EM} b`]);
});

test('a hard-wrapped sentence is checked and dropped whole, never cut in half', async () => {
  const reply = 'No. Your DFS goes as deep as the island is big, so the\ncall stack passes the limit. A BFS with a queue would\navoid that by working level by level.\n\n- First point.\n- Second point\n';
  for (const size of [1, 4, 1000]) {
    const backend = { async sendMessage(_t, { onChunk }) { for (const p of pieces(reply, size)) onChunk(p); return reply; } };
    const turn = createReplyGuard().begin({ text: 'Will a big grid work?', code: islandCode });
    const shown = await guardedSend({ backend, text: 'q', turn });
    assert.equal(shown, 'No. Your DFS goes as deep as the island is big, so the\ncall stack passes the limit. \n\n- First point.\n- Second point\n');
  }
});

test('arrows in a trace block become ASCII, but never in code or a box diagram', async () => {
  const reply = 'Trace:\n\n```\npos = 0 \u2192 pos = 2\n```\n\n```\n\u250C\u2500\u2500\u2510 \u2192 \u250C\u2500\u2500\u2510\n```\n';
  const backend = { async sendMessage(_t, { onChunk }) { onChunk(reply); return reply; } };
  const shown = await guardedSend({ backend, text: 'q', turn: createReplyGuard().begin({ text: 'Trace my code on [2, 0].', code: islandCode }) });
  assert.match(shown, /pos = 0 -> pos = 2/);
  assert.match(shown, /\u2510 \u2192 \u250C/);
});
