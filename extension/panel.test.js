// Unit tests for panel.js's pure logic: the SSE parser, the transcript
// reducer, and the markdown parser. The DOM side (incremental rendering, the
// header row, pane choice) is covered by e2e/panel-render.e2e.mjs in a real
// headless Chromium, and by the live check against the real page (see
// README.md, "Tutor tab on LeetCode").
//
// Run with: node --test panel.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseSseBlock,
  createSseParser,
  createState,
  applyEvent,
  streamLost,
  RESTARTED,
  itemsFor,
  visibleItems,
  firstChangedBlock,
  parseInline,
  parseBlocks,
  problemSlugFromPath,
  requestEditorSnapshot,
} = require("./panel.js");

test("parseSseBlock reads data lines and ignores comments and junk", () => {
  assert.deepEqual(parseSseBlock('id: 3\ndata: {"a":1}'), { a: 1 });
  assert.equal(parseSseBlock(": ping"), null);
  assert.equal(parseSseBlock("data: {nope"), null);
});

test("createSseParser handles events split across chunks and several per chunk", () => {
  const seen = [];
  const push = createSseParser((e) => seen.push(e));
  push('data: {"n":1}\n\ndata: {"n"');
  push(':2}\n\n: ping\n\ndata: {"n":3}\n\n');
  assert.deepEqual(seen.map((e) => e.n), [1, 2, 3]);
});

test("problemSlugFromPath", () => {
  assert.equal(problemSlugFromPath("/problems/two-sum/description/"), "two-sum");
  assert.equal(problemSlugFromPath("/problemset/"), null);
});

test("a model change waits until the current reply finishes before changing the header", () => {
  const state = createState();
  applyEvent(state, { type: "config", provider: "local", label: "Old model", model: "old" });
  assert.equal(state.displayConfig?.model, "old");
  applyEvent(state, { type: "turn-start", problemSlug: "two-sum", turnId: "old-turn" });
  applyEvent(state, { type: "config", provider: "local", label: "New model", model: "new" });
  assert.equal(state.displayConfig?.model, "old");
  applyEvent(state, { type: "turn-end", problemSlug: "two-sum", turnId: "old-turn", text: "done" });
  assert.equal(state.displayConfig?.model, "new");
});

test("a turn streams in, then turn-end replaces the text with the authoritative version", () => {
  const state = createState();
  applyEvent(state, { type: "turn-start", turnId: "t1", problemSlug: "two-sum", seq: 1 });
  assert.equal(applyEvent(state, { type: "chunk", turnId: "t1", text: "Hel", seq: 2 }), "two-sum");
  applyEvent(state, { type: "chunk", turnId: "t1", text: "lo", seq: 3 });
  const [turn] = itemsFor(state, "two-sum");
  assert.deepEqual([turn.text, turn.pending], ["Hello", true]);
  applyEvent(state, { type: "turn-end", turnId: "t1", problemSlug: "two-sum", text: "Hello!", seq: 4 });
  assert.deepEqual([turn.text, turn.pending, turn.error], ["Hello!", false, null]);
});

test("a turn-end with an error keeps what streamed and records the error", () => {
  const state = createState();
  applyEvent(state, { type: "turn-start", turnId: "t1", problemSlug: "p", seq: 1 });
  applyEvent(state, { type: "chunk", turnId: "t1", text: "partial", seq: 2 });
  applyEvent(state, { type: "turn-end", turnId: "t1", problemSlug: "p", error: "backend down", seq: 3 });
  const [turn] = itemsFor(state, "p");
  assert.deepEqual([turn.text, turn.error, turn.pending], ["partial", "backend down", false]);
});

test("a turn-end for a turn whose start was never seen still produces a finished turn", () => {
  const state = createState();
  applyEvent(state, { type: "turn-end", turnId: "late", problemSlug: "p", text: "done", seq: 9 });
  const [turn] = itemsFor(state, "p");
  assert.deepEqual([turn.text, turn.pending], ["done", false]);
});

test("transcripts are kept per problem and replayed events are ignored", () => {
  const state = createState();
  applyEvent(state, { type: "user", problemSlug: "a", text: "hi", seq: 1 });
  applyEvent(state, { type: "user", problemSlug: "b", text: "yo", seq: 2 });
  applyEvent(state, { type: "user", problemSlug: "a", text: "hi", seq: 1 }); // replay
  assert.equal(itemsFor(state, "a").length, 1);
  assert.equal(itemsFor(state, "b").length, 1);
  assert.equal(state.lastSeq, 2);
});

test("captures and notices become transcript items; status only updates the flag", () => {
  const state = createState();
  applyEvent(state, { type: "capture", problemSlug: "a", trigger: "submit", attemptSeq: 3, problemTitle: "A", seq: 1 });
  applyEvent(state, { type: "notice", problemSlug: "a", text: "fresh session", seq: 2 });
  assert.equal(applyEvent(state, { type: "status", companionOnline: true }), null);
  assert.equal(state.companionOnline, true);
  assert.deepEqual(
    itemsFor(state, "a").map((i) => i.kind),
    ["capture", "notice"]
  );
  assert.equal(state.companionBusy, false);
});

test("a switch notice is held back until something follows it, so it never dangles at the end", () => {
  const state = createState();
  applyEvent(state, { type: "user", problemSlug: "a", text: "hi", seq: 1 });
  // A Run on another problem resets the tutor and shows nothing else.
  applyEvent(state, { type: "notice", problemSlug: "a", text: "fresh session", switch: true, seq: 2 });
  assert.deepEqual(visibleItems(itemsFor(state, "a")), []);
  applyEvent(state, { type: "user", problemSlug: "a", text: "next", seq: 3 });
  assert.deepEqual(visibleItems(itemsFor(state, "a")).map((i) => i.kind), ["notice", "user"]);
  // Any other notice shows at once.
  applyEvent(state, { type: "notice", problemSlug: "a", text: "plain", seq: 4 });
  assert.equal(visibleItems(itemsFor(state, "a")).at(-1).text, "plain");
});

test("a switch notice drops every transcript, so the notice comes first and the old chat is gone", () => {
  const state = createState();
  applyEvent(state, { type: "user", problemSlug: "two-sum", text: "old", seq: 1 });
  applyEvent(state, { type: "turn-start", problemSlug: "two-sum", turnId: "t1", seq: 2 });
  applyEvent(state, { type: "turn-end", problemSlug: "two-sum", turnId: "t1", text: "old reply", seq: 3 });
  applyEvent(state, { type: "user", problemSlug: "valid-parentheses", text: "older", seq: 4 });
  // Back on two-sum after valid-parentheses was active.
  // Every panel redraws, whatever problem it is on.
  assert.equal(applyEvent(state, { type: "notice", problemSlug: "two-sum", text: "fresh", switch: true, seq: 5 }), RESTARTED);
  assert.equal(state.activeProblem, "two-sum");
  applyEvent(state, { type: "user", problemSlug: "two-sum", text: "new", seq: 6 });
  assert.deepEqual(itemsFor(state, "two-sum").map((i) => i.text), ["fresh", "new"]);
  assert.equal(itemsFor(state, "valid-parentheses").length, 0);
  // The old turn id is forgotten too: a late chunk for it changes nothing.
  assert.equal(applyEvent(state, { type: "chunk", turnId: "t1", text: "late", seq: 7 }), null);
});

test("the active problem follows switch notices, and chat on another problem without one", () => {
  const state = createState();
  assert.equal(state.activeProblem, null);
  applyEvent(state, { type: "user", problemSlug: "a", text: "hi", seq: 1 });
  assert.equal(state.activeProblem, null, "only a switch says which problem is active");
  applyEvent(state, { type: "notice", problemSlug: "b", text: "fresh", switch: true, seq: 2 });
  assert.equal(state.activeProblem, "b");
  // Auto-clear turned off: a message on another problem resets nothing.
  applyEvent(state, { type: "user", problemSlug: "c", text: "yo", seq: 3 });
  assert.equal(state.activeProblem, "c");
  applyEvent(state, { type: "notice", problemSlug: "c", text: "plain", seq: 4 });
  assert.equal(state.activeProblem, "c");
});

test("a Run shows no chip, even one an older companion still publishes", () => {
  const state = createState();
  applyEvent(state, { type: "capture", problemSlug: "a", trigger: "run", attemptSeq: 1, note: "Kept for your next message", seq: 1 });
  assert.equal(itemsFor(state, "a").length, 0);
  assert.equal(state.lastSeq, 1, "the event still counts for the replay position");
  applyEvent(state, { type: "capture", problemSlug: "a", trigger: "submit", attemptSeq: 2, note: "x", seq: 2 });
  assert.deepEqual(itemsFor(state, "a").map((i) => [i.trigger, i.attemptSeq, i.note]), [["submit", 2, undefined]]);
});

test("the status event's busy flag counts only while the companion is online", () => {
  const state = createState();
  applyEvent(state, { type: "status", companionOnline: true, busy: true });
  assert.equal(state.companionBusy, true);
  applyEvent(state, { type: "status", companionOnline: true, busy: false });
  assert.equal(state.companionBusy, false);
  applyEvent(state, { type: "status", companionOnline: false, busy: true });
  assert.equal(state.companionBusy, false);
  // An older relay sends no busy flag at all.
  applyEvent(state, { type: "status", companionOnline: true });
  assert.equal(state.companionBusy, false);
});

test("a transcript is capped so a long session cannot grow without bound", () => {
  const state = createState();
  for (let i = 1; i <= 400; i += 1) applyEvent(state, { type: "user", problemSlug: "a", text: String(i), seq: i });
  const items = itemsFor(state, "a");
  assert.equal(items.length, 300);
  assert.equal(items[items.length - 1].text, "400");
});

test("inline markdown: code, bold, italic, links, and snake_case left alone", () => {
  assert.deepEqual(parseInline("use `dict` here"), [
    { t: "text", v: "use " },
    { t: "code", v: "dict" },
    { t: "text", v: " here" },
  ]);
  assert.deepEqual(parseInline("a **b** c"), [
    { t: "text", v: "a " },
    { t: "strong", c: [{ t: "text", v: "b" }] },
    { t: "text", v: " c" },
  ]);
  assert.equal(parseInline("*hi*")[0].t, "em");
  assert.deepEqual(parseInline("my_var_name"), [{ t: "text", v: "my_var_name" }]);
  assert.equal(parseInline("2 * 3 * 4")[0].t, "text");
});

test("raw LaTeX from a small model becomes plain text", () => {
  const plain = (t) => parseInline(t).map((n) => (n.t === "code" ? `<${n.v}>` : n.v)).join("");
  // What gpt-oss:20b sent live: \[ \] would otherwise turn into bare brackets.
  assert.equal(plain("\\[ \\frac{n(n-1)}{2} = O(n^2). \\]"), "n(n-1)/2 = O(n\u00b2).");
  assert.equal(plain("\\( \\Theta(n) \\) and \\(\\Omega(n \\log n)\\)"), "\u0398(n) and \u03a9(n log n)");
  assert.equal(plain("so \\( a \\cdot b \\le c \\) holds"), "so a \u00b7 b \u2264 c holds");
  assert.equal(plain("time $O(n \\log n)$ here"), "time O(n log n) here");
  assert.equal(plain("$$\\frac{a+b}{2} \\times 3$$"), "(a+b)/2 \u00d7 3");
  assert.equal(plain("\\(i \\ne j\\), \\(x \\ge 0\\)"), "i \u2260 j, x \u2265 0");
  assert.equal(plain("\\(\\sqrt{n}\\) and \\(\\sqrt{n+1}\\)"), "\u221an and \u221a(n+1)");
  assert.equal(plain("x^{2}, 2^10, 2^{n-1} and \\(2^n\\)"), "x\u00b2, 2\u00b9\u2070, 2\u207f\u207b\u00b9 and 2\u207f");
  assert.equal(plain("\\(\\text{steps} = n \\cdot m\\)"), "steps = n \u00b7 m");
  // Bare commands outside delimiters too.
  assert.equal(plain("about \\frac{n}{2} pairs"), "about n/2 pairs");
});

test("plain math leaves code, money, escapes and prose alone", () => {
  const plain = (t) => parseInline(t).map((n) => (n.t === "code" ? `<${n.v}>` : n.v)).join("");
  assert.equal(plain("use `\\frac{a}{b}` and `$x$` and `n^2`"), "use <\\frac{a}{b}> and <$x$> and <n^2>");
  assert.equal(plain("it costs $5 and $10"), "it costs $5 and $10");
  assert.equal(plain("$HOME and $PATH"), "$HOME and $PATH");
  assert.equal(plain("\\[not a link\\]"), "[not a link]");
  assert.equal(plain("a^b is XOR, {a: 1} is a dict"), "a^b is XOR, {a: 1} is a dict");
  assert.equal(plain("an unmatched \\( stays"), "an unmatched ( stays");
  assert.equal(plain("\\foo is unknown"), "\\foo is unknown");
  // A fenced block is never parsed inline.
  const blocks = parseBlocks("```\n\\frac{a}{b} $x$\n```");
  assert.equal(blocks[0].t, "code");
  assert.equal(blocks[0].v, "\\frac{a}{b} $x$");
});

test("plain math stays linear on unmatched delimiters", () => {
  for (const input of ["\\(".repeat(100_000), "$a ".repeat(100_000), "\\frac{".repeat(50_000), "^{".repeat(100_000)]) {
    const started = Date.now();
    parseInline(input);
    assert.ok(Date.now() - started < 2000, `slow on ${input.slice(0, 8)}`);
  }
});

test("links render only for http(s); anything else stays inert text", () => {
  assert.equal(parseInline("[x](https://leetcode.com)")[0].t, "link");
  assert.deepEqual(parseInline("[x](javascript:alert(1))"), [{ t: "text", v: "[x](javascript:alert(1))" }]);
  assert.deepEqual(parseInline('<img src=x onerror="alert(1)">'), [{ t: "text", v: '<img src=x onerror="alert(1)">' }]);
});

test("link edge cases parse the same as the [label](http(s)://url) rule always did", () => {
  const link = (label, href) => ({ t: "link", href, c: [{ t: "text", v: label }] });
  assert.deepEqual(parseInline("see [docs](https://x.y/z)."), [{ t: "text", v: "see " }, link("docs", "https://x.y/z"), { t: "text", v: "." }]);
  assert.deepEqual(parseInline("[[a](http://x)"), [link("[a", "http://x")]);
  assert.deepEqual(parseInline("[a](http://x(y))"), [link("a", "http://x(y"), { t: "text", v: ")" }]);
  for (const inert of ["[a](http://)", "[](http://x)", "[a](http://x y)", "[a] (http://x)", "[a](ftp://x)"]) {
    assert.deepEqual(parseInline(inert), [{ t: "text", v: inert }], inert);
  }
});

// A reply is re-parsed on every streamed chunk, so a quadratic rule turns a
// long reply into a frozen tab. These inputs took seconds (or overflowed the
// stack) with the old parser; linear parsing does each in a few milliseconds,
// so the bound is loose enough to never flake on a slow machine.
test("inline parsing stays linear on pathological brackets, URLs and nested emphasis", () => {
  const inputs = {
    brackets: "[".repeat(200_000),
    unclosedUrls: `[a](http://${"x".repeat(10)}`.repeat(20_000),
    bracketsThenLongUrl: `${"[".repeat(100_000)}](http://${"x".repeat(100_000)}`,
    nestedEmphasis: "*a **".repeat(40_000),
  };
  for (const [name, text] of Object.entries(inputs)) {
    const started = process.hrtime.bigint();
    const nodes = parseInline(text);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1000, `${name}: ${ms.toFixed(0)} ms`);
    // Nothing is lost: every character is still in the output somewhere.
    const flat = JSON.stringify(nodes);
    assert.ok(flat.length >= text.length, name);
  }
});

test("block markdown: paragraphs, lists, headings, quotes, rules", () => {
  const blocks = parseBlocks("# Title\n\nFirst line\nsecond line\n\n- a\n- b\n  more\n\n1. x\n2. y\n\n> quoted\n\n---");
  assert.deepEqual(
    blocks.map((b) => b.t),
    ["heading", "paragraph", "list", "list", "quote", "hr"]
  );
  assert.equal(blocks[1].c[0].v, "First line second line");
  assert.equal(blocks[2].ordered, false);
  assert.equal(blocks[2].items[1].c[0].v, "b more");
  assert.equal(blocks[3].ordered, true);
});

test("nested lists nest: sub-bullets do not become numbered steps of the parent", () => {
  const [list] = parseBlocks("1. a\n   - b\n   - c\n2. d");
  assert.equal(list.t, "list");
  assert.equal(list.ordered, true);
  assert.deepEqual(list.items.map((i) => i.c[0].v), ["a", "d"]);
  const [sub] = list.items[0].sub;
  assert.equal(sub.ordered, false);
  assert.deepEqual(sub.items.map((i) => i.c[0].v), ["b", "c"]);
  assert.equal(list.items[1].sub.length, 0);
});

test("a numbered sub-list inside bullets stays numbered, and a marker change at one level starts a new list", () => {
  const [bullets] = parseBlocks("- a\n  1. x\n  2. y\n- b");
  assert.equal(bullets.ordered, false);
  assert.equal(bullets.items[0].sub[0].ordered, true);
  const split = parseBlocks("- a\n- b\n1. c\n2. d");
  assert.deepEqual(split.map((b) => [b.t, b.ordered]), [["list", false], ["list", true]]);
});

test("a numbered list keeps the number it starts at", () => {
  const [list] = parseBlocks("3. c\n4. d");
  assert.equal(list.start, 3);
  assert.equal(parseBlocks("- a")[0].start, 1);
});

test("tables parse into a header and padded rows", () => {
  const [table] = parseBlocks("| Name | Cost |\n| --- | :-: |\n| a | O(n) |\n| b |");
  assert.equal(table.t, "table");
  assert.deepEqual(table.header.map((c) => c[0].v), ["Name", "Cost"]);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0][1][0].v, "O(n)");
  assert.deepEqual(table.rows[1][1], []); // missing cell is padded, not undefined
  assert.equal(parseBlocks("a | b\nplain text")[0].t, "paragraph"); // a pipe alone is not a table
});

test("dunder identifiers are literal text, but ordinary double-underscore emphasis still works", () => {
  assert.deepEqual(parseInline("use __init__ here"), [{ t: "text", v: "use __init__ here" }]);
  assert.equal(parseInline("__very important__")[0].t, "strong");
  assert.equal(parseInline("**init**")[0].t, "strong");
});

test("fenced code keeps its text verbatim, and an unclosed fence (mid-stream) still renders as code", () => {
  const closed = parseBlocks("```python\ndef f():\n    return 1\n```\nafter");
  assert.deepEqual([closed[0].t, closed[0].lang, closed[0].open, closed[1].t], ["code", "python", false, "paragraph"]);
  assert.equal(closed[0].v, "def f():\n    return 1");
  const open = parseBlocks("Here:\n```js\nlet x = 1");
  assert.deepEqual([open[0].t, open[1].t, open[1].open, open[1].v], ["paragraph", "code", true, "let x = 1"]);
});

test("fences: indentation, info strings, trailing spaces, tildes and longer runs", () => {
  // Indented under a list item: the fence ends the list instead of joining
  // the item's text, and the content loses the fence's own indentation.
  const listed = parseBlocks("1. Walk the tree:\n   ```\n       1\n      / \\\n     2   3\n   ```  \n2. Next");
  assert.deepEqual(listed.map((b) => b.t), ["list", "code", "list"]);
  assert.equal(listed[0].items[0].c[0].v, "Walk the tree:");
  assert.equal(listed[1].v, "    1\n   / \\\n  2   3");
  assert.equal(listed[1].open, false);
  assert.equal(listed[2].start, 2);
  // An info string after the language, and trailing spaces on both fences.
  const info = parseBlocks("```Python title=x   \nx = 1\n```   \nafter");
  assert.deepEqual([info[0].lang, info[0].v, info[0].open, info[1].t], ["python", "x = 1", false, "paragraph"]);
  // Tildes, and a closing run must be the same character and at least as long.
  const tildes = parseBlocks("~~~\na\n```\n~~~\nafter");
  assert.deepEqual([tildes[0].v, tildes[0].open, tildes[1].t], ["a\n```", false, "paragraph"]);
  const four = parseBlocks("````\n```\ninner\n```\n````");
  assert.deepEqual([four.length, four[0].v, four[0].open], [1, "```\ninner\n```", false]);
  // Triple backticks inside a line are inline code, not a fence.
  assert.equal(parseBlocks("use ```x``` here")[0].t, "paragraph");
  // A bare fence, a "text" fence and a tab-indented diagram keep every space.
  const bare = parseBlocks("```\n[1, 3, 5]\n ^     ^\n i     j\t|\n```");
  assert.deepEqual([bare[0].lang, bare[0].v], ["", "[1, 3, 5]\n ^     ^\n i     j\t|"]);
  assert.equal(parseBlocks("```text\na  b\n```")[0].lang, "text");
});

test("a streaming reply that ends inside a fence settles when the fence closes", () => {
  const mid = parseBlocks("Trace:\n\n```\ni=0  [2, 7]\n     ^");
  assert.deepEqual(mid.map((b) => [b.t, b.open]), [["paragraph", undefined], ["code", true]]);
  const done = parseBlocks("Trace:\n\n```\ni=0  [2, 7]\n     ^\n```\n\nSo **i** moves.");
  assert.deepEqual(done.map((b) => [b.t, b.open]), [["paragraph", undefined], ["code", false], ["paragraph", undefined]]);
  assert.equal(done[1].v, mid[1].v);
  assert.equal(done[2].c[1].t, "strong");
});

test("triple-asterisk runs are bold italic, not a stray star", () => {
  const [node] = parseInline("***both***");
  assert.equal(node.t, "strong");
  assert.equal(node.c[0].t, "em");
  assert.equal(node.c[0].c[0].v, "both");
  assert.equal(parseInline("a *** b")[0].t, "text");
});

test("a pipe inside a code span or escaped with a backslash does not split a table cell", () => {
  const [table] = parseBlocks("| Expr | Meaning |\n| --- | --- |\n| `x|y` | bitwise or |\n| a \\| b | escaped |");
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0][0][0].v, "x|y");
  assert.equal(table.rows[0][1][0].v, "bitwise or");
  assert.equal(table.rows[1][0][0].v, "a | b");
});

test("a relay restart (new epoch) resets lastSeq, interrupts pending turns and says so", () => {
  const state = createState();
  applyEvent(state, { type: "user", problemSlug: "a", text: "hi", seq: 1, epoch: "e1" });
  applyEvent(state, { type: "turn-start", turnId: "t1", problemSlug: "a", seq: 2, epoch: "e1" });
  applyEvent(state, { type: "chunk", turnId: "t1", text: "Thinking", seq: 3, epoch: "e1" });
  applyEvent(state, { type: "status", companionOnline: true, epoch: "e1" });
  assert.deepEqual([state.epoch, state.lastSeq], ["e1", 3]);
  const turn = itemsFor(state, "a")[1];
  const revBefore = turn.rev;

  // The new run's replay arrives before its status event, and its numbering
  // starts over at 1: it must not be mistaken for an old replay.
  assert.equal(applyEvent(state, { type: "user", problemSlug: "a", text: "again", seq: 1, epoch: "e2" }), RESTARTED);
  assert.deepEqual([state.epoch, state.lastSeq], ["e2", 1]);
  assert.deepEqual([turn.pending, turn.interrupted, turn.text], [false, true, "Thinking"]);
  assert.ok(turn.rev > revBefore, "the interrupted turn is re-rendered");
  assert.deepEqual(
    itemsFor(state, "a").map((i) => [i.kind, i.text]),
    [["user", "hi"], ["tutor", "Thinking"], ["notice", "Session restarted"], ["user", "again"]]
  );
  // Later events of the same run are ordinary.
  assert.equal(applyEvent(state, { type: "notice", problemSlug: "a", text: "x", seq: 2, epoch: "e2" }), "a");
  assert.equal(applyEvent(state, { type: "status", companionOnline: true, epoch: "e2" }), null);
});

test("the first epoch is only stored, and a status event alone can carry a restart", () => {
  const state = createState();
  applyEvent(state, { type: "status", companionOnline: false, epoch: "e1" });
  assert.equal(state.epoch, "e1");
  assert.equal(itemsFor(state, "a").length, 0);
  applyEvent(state, { type: "user", problemSlug: "a", text: "hi", seq: 5, epoch: "e1" });
  // A restarted relay with an empty buffer sends only its status.
  assert.equal(applyEvent(state, { type: "status", companionOnline: true, epoch: "e2" }), RESTARTED);
  assert.equal(state.lastSeq, 0);
  assert.equal(itemsFor(state, "a").at(-1).text, "Session restarted");
  // A second restart in a row does not stack a second notice.
  applyEvent(state, { type: "status", companionOnline: true, epoch: "e3" });
  assert.equal(itemsFor(state, "a").filter((i) => i.kind === "notice").length, 1);
});

test("a reply interrupted by a relay restart comes back to life if its companion keeps streaming", () => {
  const state = createState();
  applyEvent(state, { type: "turn-start", turnId: "t1", problemSlug: "a", seq: 1, epoch: "e1" });
  applyEvent(state, { type: "status", companionOnline: true, epoch: "e2" });
  const turn = itemsFor(state, "a")[0];
  assert.equal(turn.interrupted, true);
  applyEvent(state, { type: "chunk", turnId: "t1", text: "more", seq: 1, epoch: "e2" });
  assert.deepEqual([turn.interrupted, turn.pending], [false, true]);
  applyEvent(state, { type: "turn-end", turnId: "t1", problemSlug: "a", text: "done", seq: 2, epoch: "e2" });
  assert.deepEqual([turn.interrupted, turn.pending, turn.text], [false, false, "done"]);
});

test("a turn-end the relay sends for a companion that exited mid-reply marks the reply interrupted", () => {
  const state = createState();
  applyEvent(state, { type: "turn-start", turnId: "t1", problemSlug: "a", seq: 1, epoch: "e1" });
  applyEvent(state, { type: "chunk", turnId: "t1", text: "Half", seq: 2, epoch: "e1" });
  applyEvent(state, { type: "turn-start", turnId: "t2", problemSlug: "a", seq: 3, epoch: "e1" });
  const [cut, empty] = itemsFor(state, "a");
  assert.equal(applyEvent(state, { type: "turn-end", turnId: "t1", problemSlug: "a", text: "Half", interrupted: true, seq: 4, epoch: "e1" }), "a");
  applyEvent(state, { type: "turn-end", turnId: "t2", problemSlug: "a", text: "", interrupted: true, seq: 5, epoch: "e1" });
  assert.deepEqual([cut.pending, cut.interrupted, cut.text, cut.error], [false, true, "Half", null]);
  // Cut before its first chunk: no typing dots left, just the note.
  assert.deepEqual([empty.pending, empty.interrupted, empty.text], [false, true, ""]);
  // A tab that joins later and only sees the end gets the same result.
  const late = createState();
  applyEvent(late, { type: "turn-end", turnId: "t1", problemSlug: "a", text: "Half", interrupted: true, seq: 4, epoch: "e1" });
  assert.deepEqual([itemsFor(late, "a")[0].pending, itemsFor(late, "a")[0].interrupted], [false, true]);
});

test("the companion going offline interrupts replies still streaming, even from a relay that does not end them", () => {
  const state = createState();
  applyEvent(state, { type: "status", companionOnline: true, epoch: "e1" });
  applyEvent(state, { type: "turn-start", turnId: "t1", problemSlug: "a", seq: 1, epoch: "e1" });
  applyEvent(state, { type: "chunk", turnId: "t1", text: "Half", seq: 2, epoch: "e1" });
  applyEvent(state, { type: "turn-start", turnId: "t2", problemSlug: "b", seq: 3, epoch: "e1" });
  applyEvent(state, { type: "turn-start", turnId: "t3", problemSlug: "b", seq: 4, epoch: "e1" });
  applyEvent(state, { type: "turn-end", turnId: "t3", problemSlug: "b", text: "done", seq: 5, epoch: "e1" });
  const turn = itemsFor(state, "a")[0];
  const revBefore = turn.rev;
  // Every transcript can change, so the whole feed is redrawn.
  assert.equal(applyEvent(state, { type: "status", companionOnline: false, epoch: "e1" }), RESTARTED);
  assert.deepEqual([turn.pending, turn.interrupted, turn.text], [false, true, "Half"]);
  assert.ok(turn.rev > revBefore);
  assert.deepEqual(itemsFor(state, "b").map((i) => [i.pending, i.interrupted]), [[false, true], [false, false]]);
  // Unlike a relay restart, no "Session restarted" divider: the relay did not restart.
  assert.equal(itemsFor(state, "a").filter((i) => i.kind === "notice").length, 0);
  // Nothing pending: an offline status changes nothing.
  assert.equal(applyEvent(state, { type: "status", companionOnline: false, epoch: "e1" }), null);
  // A companion that comes back and keeps streaming the turn revives it.
  applyEvent(state, { type: "chunk", turnId: "t1", text: " more", seq: 6, epoch: "e1" });
  assert.deepEqual([turn.pending, turn.interrupted], [true, false]);
});

test("every change to a tutor item bumps its revision", () => {
  const state = createState();
  applyEvent(state, { type: "turn-start", turnId: "t1", problemSlug: "a", seq: 1 });
  const turn = itemsFor(state, "a")[0];
  const revs = [turn.rev];
  applyEvent(state, { type: "chunk", turnId: "t1", text: "a", seq: 2 });
  revs.push(turn.rev);
  applyEvent(state, { type: "turn-end", turnId: "t1", problemSlug: "a", text: "ab", seq: 3 });
  revs.push(turn.rev);
  assert.ok(revs[0] < revs[1] && revs[1] < revs[2], JSON.stringify(revs));
  // A replayed (already seen) event changes nothing.
  applyEvent(state, { type: "chunk", turnId: "t1", text: "a", seq: 2 });
  assert.equal(turn.rev, revs[2]);
});

test("the item cap also forgets the turn ids of dropped replies, and applies to late-joined turns", () => {
  const state = createState();
  let seq = 0;
  for (let i = 0; i < 200; i += 1) {
    applyEvent(state, { type: "turn-start", turnId: `t${i}`, problemSlug: "a", seq: (seq += 1) });
    applyEvent(state, { type: "turn-end", turnId: `t${i}`, problemSlug: "a", text: String(i), seq: (seq += 1) });
  }
  for (let i = 200; i < 400; i += 1) {
    // Turns whose start was trimmed from the relay's buffer: only the end.
    applyEvent(state, { type: "turn-end", turnId: `t${i}`, problemSlug: "a", text: String(i), seq: (seq += 1) });
  }
  const items = itemsFor(state, "a");
  assert.equal(items.length, 300);
  assert.equal(state.turnProblem.size, 300);
  assert.ok(!state.turnProblem.has("t0"));
  assert.ok(state.turnProblem.has("t399"));
  // A chunk for a dropped turn finds nothing instead of a stale entry.
  assert.equal(applyEvent(state, { type: "chunk", turnId: "t0", text: "x", seq: (seq += 1) }), null);
});

test("firstChangedBlock counts the unchanged leading blocks", () => {
  assert.equal(firstChangedBlock([], ["a"]), 0);
  assert.equal(firstChangedBlock(["a", "b"], ["a", "b", "c"]), 2);
  assert.equal(firstChangedBlock(["a", "b"], ["a", "B"]), 1);
  assert.equal(firstChangedBlock(["a", "b"], ["a"]), 1);
  // While a reply streams, only the growing last paragraph changes.
  const before = parseBlocks("First paragraph.\n\nSecond, still stre").map((b) => JSON.stringify(b));
  const after = parseBlocks("First paragraph.\n\nSecond, still streaming.").map((b) => JSON.stringify(b));
  assert.equal(firstChangedBlock(before, after), 1);
});

test("table alignment markers become per-column alignments", () => {
  const [table] = parseBlocks("| a | b | c | d |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |");
  assert.deepEqual(table.align, ["left", "center", "right", null]);
  const [short] = parseBlocks("| a | b |\n| --: |\n| 1 | 2 |");
  assert.deepEqual(short.align, ["right", null]);
});

test("~~strike~~ is deletion, a lone ~ or ~~ ~~ is text", () => {
  const [node] = parseInline("~~gone~~");
  assert.equal(node.t, "del");
  assert.equal(node.c[0].v, "gone");
  assert.deepEqual(parseInline("about ~5 and ~~ ~~"), [{ t: "text", v: "about ~5 and ~~ ~~" }]);
});

test("headings may be indented up to three spaces, and keep a # that is part of the text", () => {
  assert.deepEqual(
    parseBlocks("   ## Indented\n\n    #### four spaces is not a heading").map((b) => b.t),
    ["heading", "paragraph"]
  );
  const [csharp] = parseBlocks("## Using C#");
  assert.equal(csharp.c[0].v, "Using C#");
  const [closed] = parseBlocks("### Title ###");
  assert.equal(closed.c[0].v, "Title");
});

test("losing the relay stream interrupts open replies; the status after a reconnect revives the ones still open", () => {
  const state = createState();
  applyEvent(state, { type: "status", companionOnline: true, epoch: "e1", openTurns: [] });
  applyEvent(state, { type: "turn-start", turnId: "cut", problemSlug: "a", seq: 1, epoch: "e1" });
  applyEvent(state, { type: "chunk", turnId: "cut", text: "Half", seq: 2, epoch: "e1" });
  applyEvent(state, { type: "turn-start", turnId: "none", problemSlug: "a", seq: 3, epoch: "e1" });
  applyEvent(state, { type: "turn-start", turnId: "ended", problemSlug: "b", seq: 4, epoch: "e1" });
  applyEvent(state, { type: "turn-end", turnId: "ended", problemSlug: "b", text: "Gone", interrupted: true, seq: 5, epoch: "e1" });
  const [cut, none] = itemsFor(state, "a");
  const ended = itemsFor(state, "b")[0];
  // The relay can die with its companion and never send their end.
  assert.equal(streamLost(state), RESTARTED);
  assert.equal(state.companionOnline, null);
  assert.deepEqual([cut.pending, cut.interrupted, cut.text], [false, true, "Half"]);
  assert.deepEqual([none.pending, none.interrupted], [false, true]);
  assert.equal(streamLost(state), null, "nothing left to interrupt");
  // A blip: the same relay run is back and says which replies are still open.
  const revBefore = none.rev;
  assert.equal(applyEvent(state, { type: "status", companionOnline: true, epoch: "e1", openTurns: ["none", "ended", "unknown"] }), RESTARTED);
  assert.deepEqual([none.pending, none.interrupted], [true, false]);
  assert.ok(none.rev > revBefore);
  assert.deepEqual([cut.pending, cut.interrupted], [false, true], "not listed: stays interrupted");
  // A reply the relay itself ended as interrupted is final, whatever a status says.
  assert.deepEqual([ended.pending, ended.interrupted], [false, true]);
  // Nothing to revive: no redraw.
  assert.equal(applyEvent(state, { type: "status", companionOnline: true, epoch: "e1", openTurns: ["none"] }), null);
  // An offline status never revives anything.
  streamLost(state);
  applyEvent(state, { type: "status", companionOnline: false, epoch: "e1", openTurns: ["none"] });
  assert.deepEqual([none.pending, none.interrupted], [false, true]);
});

test("requestEditorSnapshot gets content.js's answer for its own request only, and gives up after the timeout", async () => {
  const events = new EventTarget();
  events.addEventListener("leetcode-capture:snapshot-request", (event) => {
    const { requestId } = JSON.parse(event.detail);
    // A stale answer and junk first; neither may be taken for this request.
    events.dispatchEvent(new CustomEvent("leetcode-capture:snapshot-response", { detail: JSON.stringify({ requestId: "old", snapshot: { code: "stale" } }) }));
    events.dispatchEvent(new CustomEvent("leetcode-capture:snapshot-response", { detail: "{not json" }));
    events.dispatchEvent(
      new CustomEvent("leetcode-capture:snapshot-response", { detail: JSON.stringify({ requestId, snapshot: { code: "live", language: "Python3" } }) })
    );
  });
  assert.deepEqual(await requestEditorSnapshot(events, 500), { code: "live", language: "Python3" });

  const silent = new EventTarget();
  const started = Date.now();
  assert.equal(await requestEditorSnapshot(silent, 100), null);
  assert.ok(Date.now() - started >= 90);

  const empty = new EventTarget();
  empty.addEventListener("leetcode-capture:snapshot-request", (event) => {
    const { requestId } = JSON.parse(event.detail);
    empty.dispatchEvent(new CustomEvent("leetcode-capture:snapshot-response", { detail: JSON.stringify({ requestId, snapshot: null }) }));
  });
  assert.equal(await requestEditorSnapshot(empty, 500), null);
});

test("buildMessageBody never makes a body past the relay's cap, and never truncates code", () => {
  const { buildMessageBody, MAX_MESSAGE_BYTES, MAX_SNAPSHOT_CODE_CHARS, MAX_SNAPSHOT_DESCRIPTION_CHARS } = require("./panel.js");
  assert.equal(MAX_MESSAGE_BYTES, 256 * 1024);
  assert.equal(MAX_SNAPSHOT_CODE_CHARS, 100_000);
  assert.equal(MAX_SNAPSHOT_DESCRIPTION_CHARS, 50_000);
  const bytes = (body) => Buffer.byteLength(body, "utf8");

  // No snapshot, or a normal one: sent as is.
  assert.deepEqual(buildMessageBody("hi", "two-sum", null), { body: JSON.stringify({ text: "hi", problemSlug: "two-sum" }), codeLeftOut: false });
  const small = { code: "x = 1\n", language: "Python3", problemTitle: "Two Sum", problemDescription: "Given..." };
  const normal = buildMessageBody("hi", "two-sum", small);
  assert.equal(normal.codeLeftOut, false);
  assert.deepEqual(JSON.parse(normal.body).snapshot, small);

  // Code past its cap: the whole snapshot is left out, never a cut copy.
  const long = buildMessageBody("hi", "two-sum", { ...small, code: "a".repeat(MAX_SNAPSHOT_CODE_CHARS + 1) });
  assert.equal(long.codeLeftOut, true);
  assert.deepEqual(JSON.parse(long.body), { text: "hi", problemSlug: "two-sum" });

  // Code at its cap is kept, and an over-cap description is dropped instead of the code.
  const atCap = "b".repeat(MAX_SNAPSHOT_CODE_CHARS);
  const descTooLong = buildMessageBody("hi", "two-sum", { ...small, code: atCap, problemDescription: "d".repeat(MAX_SNAPSHOT_DESCRIPTION_CHARS + 1) });
  assert.equal(descTooLong.codeLeftOut, false);
  assert.equal(JSON.parse(descTooLong.body).snapshot.code, atCap);
  assert.equal(JSON.parse(descTooLong.body).snapshot.problemDescription, undefined);

  // Within the character caps but past the byte cap once encoded (non-ASCII
  // and escaped characters): the description goes first, then the snapshot.
  const wide = "é中\u0001".repeat(30_000); // 90,000 chars, far more than 256 KB as JSON
  const tooWide = buildMessageBody("hi", "two-sum", { ...small, code: wide });
  assert.equal(tooWide.codeLeftOut, true);
  assert.ok(bytes(tooWide.body) <= MAX_MESSAGE_BYTES);
  assert.equal(JSON.parse(tooWide.body).snapshot, undefined);
  const codeFits = "中".repeat(70_000); // 210,000 bytes: fits alone, not with a long description
  const dropDesc = buildMessageBody("hi", "two-sum", { ...small, code: codeFits, problemDescription: "中".repeat(40_000) });
  assert.equal(dropDesc.codeLeftOut, false);
  assert.equal(JSON.parse(dropDesc.body).snapshot.code, codeFits);
  assert.equal(JSON.parse(dropDesc.body).snapshot.problemDescription, undefined);
  assert.ok(bytes(dropDesc.body) <= MAX_MESSAGE_BYTES);
});

test("a config event names the tutor's model in state and never touches a transcript", () => {
  const state = createState();
  assert.equal(state.config, null);
  const affected = applyEvent(state, { type: "config", provider: "local", label: "Local model", model: "gpt-oss:20b", epoch: "e1" });
  assert.equal(affected, null);
  assert.deepEqual(state.config, { provider: "local", label: "Local model", model: "gpt-oss:20b" });
  assert.equal(state.byProblem.size, 0);
  assert.equal(state.lastSeq, 0, "a config event has no sequence number to count");
  applyEvent(state, { type: "config", provider: "claude", label: "Claude subscription", model: null });
  assert.deepEqual(state.config, { provider: "claude", label: "Claude subscription", model: null });
  applyEvent(state, { type: "config", provider: "x" });
  assert.equal(state.config.label, "Claude subscription", "a config without a label is ignored");
});
