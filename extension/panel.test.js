// Unit tests for panel.js's pure logic: the SSE parser, the transcript
// reducer, and the markdown parser. The DOM integration is covered by the
// live end-to-end check against the real page (see README.md, "Tutor panel").
//
// Run with: node --test panel.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseSseBlock,
  createSseParser,
  createState,
  applyEvent,
  itemsFor,
  parseInline,
  parseBlocks,
  problemSlugFromPath,
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

test("links render only for http(s); anything else stays inert text", () => {
  assert.equal(parseInline("[x](https://leetcode.com)")[0].t, "link");
  assert.deepEqual(parseInline("[x](javascript:alert(1))"), [{ t: "text", v: "[x](javascript:alert(1))" }]);
  assert.deepEqual(parseInline('<img src=x onerror="alert(1)">'), [{ t: "text", v: '<img src=x onerror="alert(1)">' }]);
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
