// A stand-in for a leetcode.com problem page built with the REAL
// flexlayout-react (the version in package.json; LeetCode's own version is
// not known and may differ), for extension/e2e/layout.e2e.mjs. Bundled with
// React by build.mjs; nothing here is packaged with the extension.
//
// What it copies from LeetCode: the tab names and arrangement (Description,
// Editorial, Solutions and Submissions on the left, Code above Testcase and
// Test Result on the right), tab labels rendered twice (a bold copy and a
// hidden regular-weight copy), the description's analytics hook, an app that
// saves model.toJson() on every model change (LeetCode stores the layout in
// the account), a "Default layout" reset that replaces the Model, and a
// factory that renders nothing for a component it does not know.
//
// Two variants, picked by the page URL. The default one names every tab.
// `?leetcode` copies what the real page was found to do instead: its tabs
// have no names (getName() returns the library's "[Unnamed Tab]" and the
// JSON has no `name`), so a tab is known only by its component; its
// onRenderTab draws labels and icons by component and, for a component it
// does not know, its i18n key ("Tabs.LcTutor") with no icon; and it runs an older fork with no
// addChangeListener on the Model (only a single `_setChangeListener` hook),
// and whose nodes have no getPath().
// Like the fork, every tabset in its JSON also carries `foldBeforeWeight`,
// which a splitter drag rewrites (the real page's values: 58.85 on both
// tabsets, 27.78 after a drag).
//
// Test hooks on window.__fx: model(), saved (every JSON the app saved),
// reset(), remount() (a new <Layout> over the same model, so React rebuilds
// the whole layout DOM) and rerender() (same <Layout>, new props).
import React, { useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { Layout, Model, Actions, DockLocation } from 'flexlayout-react';

const DEFAULT_LAYOUT = {
  global: { tabEnableClose: false, tabEnableRename: false, tabSetEnableMaximize: true, splitterSize: 8 },
  borders: [],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        id: 'ts-left',
        weight: 50,
        children: [
          { type: 'tab', id: 'description', name: 'Description', component: 'description' },
          { type: 'tab', id: 'editorial', name: 'Editorial', component: 'editorial' },
          { type: 'tab', id: 'solutions', name: 'Solutions', component: 'solutions' },
          { type: 'tab', id: 'submissions', name: 'Submissions', component: 'submissions' },
        ],
      },
      {
        type: 'row',
        weight: 50,
        children: [
          { type: 'tabset', id: 'ts-code', weight: 60, children: [{ type: 'tab', id: 'code', name: 'Code', component: 'code' }] },
          {
            type: 'tabset',
            id: 'ts-test',
            weight: 40,
            children: [
              { type: 'tab', id: 'testcase', name: 'Testcase', component: 'testcase' },
              { type: 'tab', id: 'result', name: 'Test Result', component: 'result' },
            ],
          },
        ],
      },
    ],
  },
};

const LEETCODE = new URLSearchParams(location.search).has('leetcode');

const LABELS = {
  description: 'Description',
  editorial: 'Editorial',
  solutions: 'Solutions',
  submissions: 'Submissions',
  code: 'Code',
  testcase: 'Testcase',
  result: 'Test Result',
};
const KNOWN = new Set(Object.keys(LABELS));

function unnamed(json) {
  if (Array.isArray(json)) return json.map(unnamed);
  if (!json || typeof json !== 'object') return json;
  const out = {};
  for (const [key, value] of Object.entries(json)) if (!(key === 'name' && json.type === 'tab')) out[key] = unnamed(value);
  return out;
}
const START_LAYOUT = LEETCODE ? unnamed(DEFAULT_LAYOUT) : DEFAULT_LAYOUT;

// The older fork's Model: no addChangeListener or removeChangeListener for
// anyone outside the library. This library's own Layout still needs them,
// so they stay visible to code in this bundle and are hidden from every
// other script (the bridge is loaded from its own file).
function newModel() {
  const m = Model.fromJson(START_LAYOUT);
  if (!LEETCODE) return m;
  for (const method of ['addChangeListener', 'removeChangeListener']) {
    const real = m[method];
    Object.defineProperty(m, method, {
      configurable: true,
      get() {
        return /layout-bridge\.js/.test(new Error().stack || '') ? undefined : real;
      },
    });
  }
  // The fork's nodes have no getPath(); the library's own code here still
  // needs it, so it is hidden from the bridge only.
  const hidePath = (proto) => {
    for (let o = proto; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      const real = Object.getOwnPropertyDescriptor(o, 'getPath');
      if (!real || typeof real.value !== 'function') continue;
      Object.defineProperty(o, 'getPath', {
        configurable: true,
        get() {
          return /layout-bridge\.js/.test(new Error().stack || '') ? undefined : real.value;
        },
      });
    }
  };
  if (!newModel.pathHidden) {
    newModel.pathHidden = true;
    m.visitNodes((n) => hidePath(Object.getPrototypeOf(n)));
  }
  // The fork's foldBeforeWeight: in the JSON right after `weight`, set for
  // every tabset in a row by a splitter drag there, and by an update.
  const fold = new Map();
  m.visitNodes((n) => {
    if (n.getType() === 'tabset') fold.set(n.getId(), 58.85350318471338);
  });
  m.toJson = function toJson() {
    const json = Model.prototype.toJson.call(this);
    const walk = (n) => {
      if (!n || typeof n !== 'object') return n;
      if (Array.isArray(n.children)) n.children = n.children.map(walk);
      if (n.type !== 'tabset' || !fold.has(n.id)) return n;
      const out = {};
      for (const [key, value] of Object.entries(n)) {
        out[key] = value;
        if (key === 'weight') out.foldBeforeWeight = fold.get(n.id);
      }
      return out;
    };
    json.layout = walk(json.layout);
    return json;
  };
  m.doAction = function doAction(action) {
    const out = Model.prototype.doAction.call(this, action);
    const data = action && action.data;
    if (action.type === Actions.ADJUST_WEIGHTS && !(action.isAdjusting && action.isAdjusting())) {
      const row = this.getNodeById(data.nodeId);
      for (const c of row ? row.getChildren() : []) if (c.getType() === 'tabset') fold.set(c.getId(), c.getWeight());
    }
    if (action.type === Actions.UPDATE_NODE_ATTRIBUTES && data.json && typeof data.json.foldBeforeWeight === 'number') fold.set(data.node, data.json.foldBeforeWeight);
    return out;
  };
  // The fork's own hook: one listener at a time.
  let single = null;
  m._setChangeListener = (fn) => {
    if (single) Model.prototype.removeChangeListener.call(m, single);
    single = fn || null;
    if (single) Model.prototype.addChangeListener.call(m, single);
  };
  return m;
}

function factory(node) {
  const component = node.getComponent();
  if (component === 'description') {
    return (
      <div className="pane" id="pane-desc">
        <div data-track-load="description_content">
          <p>Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.</p>
          <button id="desc-button">focusable description control</button>
        </div>
      </div>
    );
  }
  if (component === 'code') {
    return (
      <div className="pane" id="pane-code">
        class Solution: <button id="editor-button">focusable editor control</button>
      </div>
    );
  }
  if (component === 'submissions') {
    return (
      <div className="pane" id="pane-subs">
        <div className="border-b"><span className="row-label">Status</span></div>
      </div>
    );
  }
  if (KNOWN.has(component)) return <div className="pane" id={`pane-${component}`}>{LABELS[component]} content</div>;
  // A component this app does not know (the Tutor tab is one): nothing.
  return null;
}

function onRenderTab(node, values) {
  if (LEETCODE) {
    // A lookup by component, as on leetcode.com: for one it does not know
    // it draws the i18n key itself ("Tabs.LcTutor" for "lc-tutor") and no
    // icon.
    const component = node.getComponent() || '';
    const label = LABELS[component] || `Tabs.${component.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())}`;
    values.content = (
      <div className="label">
        <div>{label}</div>
        <div className="ghost">{label}</div>
      </div>
    );
    if (LABELS[component]) values.leading = <svg width="1em" height="1em" viewBox="0 0 24 24" className="tab-icon"><path fill="currentColor" d="M4 4h16v16H4z" /></svg>;
    return;
  }
  const name = node.getName();
  values.content = (
    <div className="label">
      <div>{name}</div>
      <div className="ghost">{name}</div>
    </div>
  );
  if (KNOWN.has(node.getComponent())) {
    values.leading = (
      <svg width="1em" height="1em" viewBox="0 0 24 24" className="tab-icon">
        <path fill="currentColor" d="M4 4h16v16H4z" />
      </svg>
    );
  }
}

const saved = [];

function App() {
  const [model, setModel] = useState(newModel);
  const [layoutKey, setLayoutKey] = useState(0);
  const [, setTick] = useState(0);
  const onModelChange = useCallback((m) => {
    saved.push(JSON.stringify(m.toJson()));
  }, []);
  window.__fx = {
    model: () => model,
    saved,
    Actions,
    DockLocation,
    variant: LEETCODE ? 'leetcode' : 'named',
    reset: () => setModel(newModel()),
    remount: () => setLayoutKey((k) => k + 1),
    rerender: () => setTick((t) => t + 1),
  };
  return (
    <div className="app">
      <div className="nav">
        <button id="default-layout" onClick={() => setModel(newModel())}>Default layout</button>
      </div>
      <div className="main">
        <Layout key={layoutKey} model={model} factory={factory} onRenderTab={onRenderTab} onModelChange={onModelChange} realtimeResize />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
