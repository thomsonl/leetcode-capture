// The pure parts of layout-bridge.js: what the page may save never carries
// the Tutor tab. The real-library behavior is in e2e/layout.e2e.mjs.
const test = require("node:test");
const assert = require("node:assert/strict");
const { scrub, wrapToJson, TAB_ID, COMPONENT } = require("./layout-bridge.js");

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
