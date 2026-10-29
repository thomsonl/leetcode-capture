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

const KNOWN = new Set(['description', 'editorial', 'solutions', 'submissions', 'code', 'testcase', 'result']);

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
  if (KNOWN.has(component)) return <div className="pane" id={`pane-${component}`}>{node.getName()} content</div>;
  // A component this app does not know (the Tutor tab is one): nothing.
  return null;
}

function onRenderTab(node, values) {
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
  const [model, setModel] = useState(() => Model.fromJson(DEFAULT_LAYOUT));
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
    reset: () => setModel(Model.fromJson(DEFAULT_LAYOUT)),
    remount: () => setLayoutKey((k) => k + 1),
    rerender: () => setTick((t) => t + 1),
  };
  return (
    <div className="app">
      <div className="nav">
        <button id="default-layout" onClick={() => setModel(Model.fromJson(DEFAULT_LAYOUT))}>Default layout</button>
      </div>
      <div className="main">
        <Layout key={layoutKey} model={model} factory={factory} onRenderTab={onRenderTab} onModelChange={onModelChange} realtimeResize />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
