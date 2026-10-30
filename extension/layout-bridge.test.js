// The pure parts of layout-bridge.js: what the page may save never carries
// the Tutor tab. The real-library behavior is in e2e/layout.e2e.mjs.
const test = require("node:test");
const assert = require("node:assert/strict");
const { scrub, cleanLayout, wrapToJson, validPosition, bestTabset, TAB_ID, COMPONENT } = require("./layout-bridge.js");

const tutor = { type: "tab", id: TAB_ID, name: "Tutor", component: COMPONENT };
const tab = (id) => ({ type: "tab", id, name: id, component: id });

test("drops the Tutor tab and keeps the selected tab selected", () => {
  const json = { global: {}, borders: [], layout: { type: "row", children: [{ type: "tabset", selected: 3, children: [tab("a"), tutor, tab("b"), tab("c")] }] } };
  const out = scrub(json);
  assert.deepEqual(out.layout.children[0].children.map((t) => t.id), ["a", "b", "c"]);
  assert.equal(out.layout.children[0].selected, 2);
  // The input is not changed.
  assert.equal(json.layout.children[0].children.length, 4);
});

test("a selected Tutor tab hands the selection to the tab before it", () => {
  const out = scrub({ layout: { type: "row", children: [{ type: "tabset", selected: 2, children: [tab("a"), tab("b"), tutor] }] } });
  assert.equal(out.layout.children[0].selected, 1);
  const first = scrub({ layout: { type: "row", children: [{ type: "tabset", selected: 0, children: [tutor, tab("a")] }] } });
  assert.equal(first.layout.children[0].selected, 0);
});

test("a tabset holding only the Tutor tab, and a row left empty by it, are dropped", () => {
  const json = {
    layout: {
      type: "row",
      children: [
        { type: "tabset", children: [tab("a")] },
        { type: "row", children: [{ type: "tabset", maximized: true, children: [tutor] }] },
        { type: "tabset", children: [tutor] },
      ],
    },
  };
  const out = scrub(json);
  assert.equal(out.layout.children.length, 1);
  assert.equal(out.layout.children[0].children[0].id, "a");
  assert.ok(!JSON.stringify(out).includes(COMPONENT));
});

test("an empty tabset the page already had is kept, and the root row always stays", () => {
  const out = scrub({ layout: { type: "row", children: [{ type: "tabset", children: [] }] } });
  assert.equal(out.layout.children.length, 1);
  const onlyTutor = scrub({ layout: { type: "row", children: [{ type: "tabset", children: [tutor] }] } });
  assert.deepEqual(onlyTutor.layout.children, []);
});

test("borders and anything else nested are scrubbed too", () => {
  const out = scrub({ borders: [{ type: "border", location: "left", children: [tutor, tab("x")] }], layout: { type: "row", children: [] } });
  assert.deepEqual(out.borders[0].children.map((t) => t.id), ["x"]);
});

test("wrapToJson wraps one model instance and unwraps it exactly", () => {
  class Model {
    toJson() {
      return { layout: { type: "row", children: [{ type: "tabset", children: [tab("a"), tutor] }] } };
    }
  }
  const m = new Model();
  const other = new Model();
  const unwrap = wrapToJson(m);
  assert.ok(!JSON.stringify(m.toJson()).includes(COMPONENT));
  assert.ok(JSON.stringify(other.toJson()).includes(COMPONENT));
  unwrap();
  assert.equal(m.toJson, Model.prototype.toJson);
  assert.ok(!Object.prototype.hasOwnProperty.call(m, "toJson"));
});

test("validPosition keeps only the known shape, and only tab names", () => {
  assert.deepEqual(validPosition({ v: 1, mode: "tabset", anchors: ["Code"], after: "Code", index: 1, extra: "x" }), { v: 1, mode: "tabset", anchors: ["Code"], after: "Code", index: 1 });
  assert.deepEqual(validPosition({ v: 1, mode: "dock", anchors: ["Description"], side: "bottom", ratio: 0.6666 }), { v: 1, mode: "dock", anchors: ["Description"], side: "bottom", ratio: 0.667 });
  assert.deepEqual(validPosition({ v: 1, mode: "dock", anchors: ["Description"], side: "left", ratio: 5 }), { v: 1, mode: "dock", anchors: ["Description"], side: "left" });
  for (const bad of [null, "x", { v: 2, mode: "tabset", anchors: ["a"], index: 0 }, { v: 1, mode: "tabset", anchors: [], index: 0 }, { v: 1, mode: "tabset", anchors: ["a"], index: -1 }, { v: 1, mode: "dock", anchors: ["a"], side: "middle" }, { v: 1, mode: "tabset", anchors: [{}], index: 0 }, { v: 1, mode: "tabset", anchors: ["x".repeat(61)], index: 0 }, { v: 1, mode: "float", anchors: ["a"] }]) {
    assert.equal(validPosition(bad), null, JSON.stringify(bad));
  }
});

test("bestTabset picks the tabset sharing the most names, or none", () => {
  const sets = [{ node: 1, names: ["Description", "Editorial"] }, { node: 2, names: ["Code"] }, { node: 3, names: ["Testcase", "Test Result", "Editorial"] }];
  assert.equal(bestTabset(sets, ["Testcase", "Test Result"]).node, 3);
  assert.equal(bestTabset(sets, ["Description", "Solutions"]).node, 1);
  assert.equal(bestTabset(sets, ["Gone"]), null);
});

// The layout leetcode.com saved for Thomson's account (Number of Islands,
// 2026-10-29), ids as they were.
const REAL = '{"global":{"splitterSize":8,"tabEnableClose":false,"tabEnableRename":false,"tabDragSpeed":0.2,"tabSetMinWidth":36,"tabSetMinHeight":36},"borders":[],"layout":{"type":"row","id":"#aa8aa540-1b32-1ae5-8765-69e95a99bfb6","children":[{"type":"tabset","id":"#a0491d21-2d46-7bb6-04f3-d1d071636893","weight":53.00548066953044,"foldBeforeWeight":58.85350318471338,"children":[{"type":"tab","id":"#b2edd12a-66c1-0851-0cad-cde695beb97a","component":"description"},{"type":"tab","id":"#ced5dae5-b0de-a6a9-2d4a-cc161eccec28","component":"testcase"},{"type":"tab","id":"#0442db59-c52b-1789-323a-79f1d254f6d8","component":"result"},{"type":"tab","id":"#1c945284-6775-04bb-fe89-b79c32008321","component":"submissions"},{"type":"tab","id":"#5a22cbef-8c79-3d02-46eb-0be818939759","component":"editorial"},{"type":"tab","id":"#b2ed6c4b-32f2-b02a-7222-91fb84b83b20","component":"solutions"}],"active":true},{"type":"tabset","id":"#ead3119a-b7cb-b0de-0582-1ba54be17d61","weight":64.70152569989632,"foldBeforeWeight":58.85350318471338,"children":[{"type":"tab","id":"#1e10f397-6352-a125-b02d-7dc62be6d3b9","component":"code","enableRenderOnDemand":false}]}]}}';

// What flexlayout makes of REAL when the Tutor tab is split to the right of
// Code: Code keeps half its weight and the new tabset gets the other half.
function splitRight(codeWeight, tutorWeight, fold) {
  const json = JSON.parse(REAL);
  const row = json.layout;
  const code = row.children[1];
  code.weight = codeWeight;
  if (fold !== undefined) for (const ts of row.children) ts.foldBeforeWeight = fold;
  delete row.children[0].active;
  row.children.push({ type: "tabset", id: "#tutor-ts", weight: tutorWeight, children: [{ ...tutor }], active: true });
  return json;
}

test("a Tutor split leaves the saved layout byte for byte as LeetCode had it", () => {
  const memo = {};
  assert.equal(JSON.stringify(cleanLayout(JSON.parse(REAL), memo).json), REAL);
  const half = 64.70152569989632 / 2;
  // The split, then drags on the Tutor's own splitter (the fork rewrites
  // foldBeforeWeight on a drag), wide and narrow.
  for (const [code, tutorWeight, fold] of [[half, half, undefined], [10, 54.70152569989632, 27.78], [60, 4.70152569989632, 30.1]]) {
    const out = cleanLayout(splitRight(code, tutorWeight, fold), memo);
    assert.equal(out.proven, true);
    assert.equal(JSON.stringify(out.json), REAL);
  }
});

test("a native drag while the Tutor is split is kept, with the Tutor's space given to its neighbor", () => {
  const memo = {};
  cleanLayout(JSON.parse(REAL), memo);
  const json = splitRight(20, 20);
  json.layout.children[0].weight = 80;
  const out = cleanLayout(json, memo);
  assert.equal(out.proven, true);
  const row = out.json.layout.children;
  assert.equal(row.length, 2);
  assert.deepEqual([row[0].weight, row[1].weight], [80, 40]);
  assert.ok(!JSON.stringify(out.json).includes(COMPONENT));
});

test("the Tutor dragged back into a tabset: the split's leftover weights are not saved, and memo asks for a restore", () => {
  const memo = {};
  cleanLayout(JSON.parse(REAL), memo);
  cleanLayout(splitRight(30, 34.70152569989632), memo);
  // flexlayout deletes the emptied tabset and leaves Code its split weight.
  const back = JSON.parse(REAL);
  back.layout.children[1].weight = 30;
  back.layout.children[0].children.splice(1, 0, { ...tutor });
  const out = cleanLayout(back, memo);
  assert.equal(JSON.stringify(out.json), REAL);
  assert.equal(memo.restore, true);
  // Once the Model has its weights back, nothing is pending.
  const fixed = JSON.parse(REAL);
  fixed.layout.children[0].children.splice(1, 0, { ...tutor });
  assert.equal(JSON.stringify(cleanLayout(fixed, memo).json), REAL);
  assert.equal(memo.restore, false);
});

test("a split taken out of a nested row hands the row's weight to the tabset left in it", () => {
  const memo = {};
  const before = { global: {}, borders: [], layout: { type: "row", id: "root", children: [{ type: "tabset", id: "a", weight: 40, children: [tab("a")] }, { type: "tabset", id: "b", weight: 60, children: [tab("b")] }] } };
  cleanLayout(before, memo);
  const split = { global: {}, borders: [], layout: { type: "row", id: "root", children: [{ type: "tabset", id: "a", weight: 40, children: [tab("a")] }, { type: "row", id: "new", weight: 60, children: [{ type: "tabset", id: "b", weight: 70, children: [tab("b")] }, { type: "tabset", id: "t", weight: 30, children: [{ ...tutor }] }] }] } };
  assert.equal(JSON.stringify(cleanLayout(split, memo).json), JSON.stringify(before));
});

test("a shape that cannot be proven saves the last clean layout and is reported", () => {
  const memo = {};
  const before = { global: {}, borders: [], layout: { type: "row", id: "root", children: [{ type: "tabset", id: "a", weight: 100, children: [tab("a")] }] } };
  cleanLayout(before, memo);
  const lonely = { global: {}, borders: [], layout: { type: "row", id: "root", children: [{ type: "row", id: "r", weight: 100, children: [{ type: "tabset", id: "t", weight: 50, children: [{ ...tutor }] }] }, { type: "tabset", id: "a", weight: 100, children: [tab("b")] }] } };
  const out = cleanLayout(lonely, memo);
  assert.equal(out.proven, false);
  assert.match(out.reason, /no sibling/);
  assert.equal(JSON.stringify(out.json), JSON.stringify(before));
  assert.equal(memo.unsafe, out.reason);
});
