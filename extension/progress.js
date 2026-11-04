// LeetCode Capture - the options page's Progress tab and its tab bar.
//
// A picture of the NeetCode 150 roadmap (shared/roadmap.js): one node per
// topic with its solved count, the prerequisite lines between them, and a
// side panel per topic with its prerequisites and problems. It changes no
// setting. Solved problems come from storage.local (`solvedProblems`, written
// by the background worker when LeetCode accepts a submission, see
// shared/solved.js); the status mark and the star in a topic's table ask the
// worker to change them, so every write goes through its one queue. Nothing
// here leaves the browser.
//
// All text is inserted with textContent / createElement, never innerHTML.

import { NEETCODE_150, nextOnRoadmap, problemUrl, progress } from './shared/roadmap.js';
import { SOLVED_KEY, STARRED_KEY, normalizeSolved, normalizeStarred } from './shared/solved.js';

const api = typeof browser !== 'undefined' ? browser : chrome;
const ROADMAP = NEETCODE_150;
const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

// Where each topic sits: x in columns (0 to 4, halves between), y in rows,
// like neetcode.io's roadmap read top to bottom.
const LAYOUT = {
  'arrays-hashing': [2, 0],
  'two-pointers': [1, 1],
  stack: [3, 1],
  'sliding-window': [0, 2],
  'binary-search': [1, 2],
  'linked-list': [2, 2],
  trees: [1.5, 3],
  tries: [0.5, 4],
  heap: [1.5, 4],
  backtracking: [2.5, 4],
  graphs: [2.5, 5],
  'dp-1d': [3.5, 5],
  intervals: [0, 6],
  greedy: [1, 6],
  'advanced-graphs': [2, 6],
  'dp-2d': [3, 6],
  'bit-manipulation': [4, 6],
  'math-geometry': [3.5, 7],
};
// Node labels where the full title does not fit (the side panel and the
// node's accessible name always use the full one); COMPACT_SHORT only for
// the smaller nodes.
const SHORT = { 'dp-1d': '1-D DP', 'dp-2d': '2-D DP' };
const COMPACT_SHORT = { heap: 'Heap / PQ' };

// Node and grid sizes: the full graph from WIDE.min pixels of room, a
// tighter one below that (which scrolls sideways inside its own box on a
// phone; the page itself never does).
const WIDE = { node: [176, 64], step: [200, 104], pad: 28 };
const COMPACT = { node: [148, 60], step: [164, 96], pad: 20 };
const graphWidth = (m) => 4 * m.step[0] + m.node[0] + 2 * m.pad;
const graphHeight = (m) => 7 * m.step[1] + m.node[1] + 2 * m.pad;

const LEVELS = ['Easy', 'Medium', 'Hard'];

let solved = {};
let starred = {};
let openTopic = null; // the topic whose side panel is open
let returnFocus = null; // what gets focus back when it closes
let metrics = null;
let built = false;
let notice = '';

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === false || value === null || value === undefined) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

function icon(paths, size = 16) {
  const node = svg('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' });
  for (const attrs of paths) {
    node.appendChild(svg('path', { stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...attrs }));
  }
  return node;
}

const ICONS = {
  check: () => icon([{ d: 'M4 8.5l2.6 2.6L12 5.6', 'stroke-width': 2 }], 12),
  close: () => icon([{ d: 'M4 4l8 8M12 4l-8 8' }]),
  external: () => icon([{ d: 'M9.5 3H13v3.5M13 3L7.5 8.5M11.5 9.5V13H3V4.5h3.5' }], 12),
  star: () => icon([{ d: 'M8 2.2l1.75 3.6 3.95.55-2.85 2.78.68 3.92L8 11.2l-3.53 1.85.68-3.92L2.3 6.35l3.95-.55z' }]),
};

function difficulty(level) {
  return h('span', { class: 'diff', 'data-level': level, text: level });
}

function percent(done, total) {
  return total ? Math.round((done / total) * 1000) / 10 : 0;
}

function bar(done, total, label) {
  const fill = h('span', { class: 'bar-fill' });
  fill.style.width = `${percent(done, total)}%`;
  return h('span', { class: 'bar', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done) }, fill);
}

function topicById(id) {
  return ROADMAP.topics.find((t) => t.id === id);
}

function solvedSet() {
  return new Set(Object.keys(solved));
}

function nextProblem() {
  return nextOnRoadmap(ROADMAP, solvedSet(), { count: 1 })[0] || null;
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---- the tab bar -----------------------------------------------------------

const TABS = ['settings', 'progress'];
const SUBTITLES = { settings: 'Tutor settings', progress: 'Your NeetCode 150 progress' };

function selectTab(name, { focus = false, push = true } = {}) {
  for (const tab of TABS) {
    const button = $(`tab-${tab}`);
    const on = tab === name;
    button.setAttribute('aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
    $(`panel-${tab}`).hidden = !on;
    if (on && focus) button.focus();
  }
  document.body.dataset.tab = name;
  $('page-sub').textContent = SUBTITLES[name];
  if (push) {
    const url = name === 'progress' ? '#progress' : `${location.pathname}${location.search}`;
    history.replaceState(null, '', url);
  }
  if (name === 'progress') {
    if (!built) build();
    else layoutGraph();
  } else if (openTopic) {
    closeDrawer({ restore: false });
  }
}

function wireTabs() {
  for (const tab of TABS) $(`tab-${tab}`).addEventListener('click', () => selectTab(tab));
  document.querySelector('.tabs').addEventListener('keydown', (event) => {
    const i = TABS.indexOf(document.body.dataset.tab);
    let next = null;
    if (event.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
    else if (event.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length];
    else if (event.key === 'Home') next = TABS[0];
    else if (event.key === 'End') next = TABS[TABS.length - 1];
    if (!next) return;
    event.preventDefault();
    selectTab(next, { focus: true });
  });
  window.addEventListener('hashchange', () => selectTab(location.hash === '#progress' ? 'progress' : 'settings', { push: false }));
  selectTab(location.hash === '#progress' ? 'progress' : 'settings', { push: false });
}

// ---- the tab's content -----------------------------------------------------

function build() {
  built = true;
  const panel = $('panel-progress');
  panel.textContent = '';
  panel.append(
    h('section', { class: 'card summary', id: 'summary', 'aria-labelledby': 'summary-heading' }),
    h(
      'section',
      { class: 'card roadmap', 'aria-labelledby': 'roadmap-heading' },
      h('h2', { class: 'sr-only', id: 'roadmap-heading', text: 'Topics' }),
      h('div', { class: 'canvas', id: 'canvas' }, h('div', { class: 'graph', id: 'graph', role: 'group', 'aria-label': `${ROADMAP.title} topics` }))
    ),
    h('p', { class: 'foot', text: 'Solved problems are kept in this browser only. A problem counts as solved when LeetCode accepts your submission with the extension installed; click a status mark in a topic to change it.' })
  );
  const backdrop = h('div', { class: 'backdrop', id: 'backdrop', hidden: true, onclick: () => closeDrawer() });
  const drawer = h('aside', { class: 'drawer', id: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'drawer-title', hidden: true });
  drawer.addEventListener('keydown', drawerKeys);
  document.body.append(backdrop, drawer);
  $('graph').addEventListener('keydown', graphKeys);
  new ResizeObserver(() => layoutGraph()).observe($('canvas'));
  render();
}

function render() {
  if (!built) return;
  renderSummary();
  renderGraph();
  if (openTopic) renderDrawer();
}

function renderSummary() {
  const box = $('summary');
  const all = progress(ROADMAP, solvedSet());
  const counts = Object.fromEntries(LEVELS.map((l) => [l, { done: 0, total: 0 }]));
  for (const topic of ROADMAP.topics) {
    for (const p of topic.problems) {
      counts[p.difficulty].total += 1;
      if (solved[p.slug]) counts[p.difficulty].done += 1;
    }
  }
  const next = nextProblem();
  box.textContent = '';
  box.append(
    h(
      'div',
      { class: 'summary-head' },
      h('div', {}, h('h2', { id: 'summary-heading', text: ROADMAP.title }), h('p', { class: 'help', text: 'The roadmap of 150 problems by topic. Start at the top; each line leads to a topic that builds on the one above it.' })),
      h('p', { class: 'total' }, h('span', { class: 'total-done', text: String(all.solved) }), h('span', { class: 'total-of', text: ` / ${all.total} solved` }))
    ),
    bar(all.solved, all.total, `${ROADMAP.title} solved`),
    h(
      'div',
      { class: 'summary-foot' },
      h(
        'ul',
        { class: 'levels', 'aria-label': 'Solved by difficulty' },
        ...LEVELS.map((l) => h('li', {}, difficulty(l), h('span', { class: 'level-count', text: `${counts[l].done} / ${counts[l].total}` })))
      ),
      next
        ? h(
            'p',
            { class: 'next-up' },
            h('span', { class: 'next-label', text: 'Next up' }),
            h('a', { href: problemUrl(next.slug), target: '_blank', rel: 'noopener noreferrer', text: next.title }),
            difficulty(next.difficulty),
            h('span', { class: 'next-in', text: 'in' }),
            h('button', { type: 'button', class: 'linkbtn', onclick: (e) => openDrawer(next.topic, e.currentTarget), text: topicById(next.topic).title })
          )
        : h('p', { class: 'next-up done', text: `You have solved every problem on ${ROADMAP.title}.` })
    ),
  );
  if (notice) box.appendChild(h('p', { class: 'result', 'data-kind': 'error', role: 'alert', text: notice }));
}

// The node buttons, in reading order (row, then column) so Tab walks the
// graph top to bottom.
function renderGraph() {
  const graph = $('graph');
  const all = progress(ROADMAP, solvedSet());
  const next = nextProblem();
  const order = [...ROADMAP.topics].sort((a, b) => LAYOUT[a.id][1] - LAYOUT[b.id][1] || LAYOUT[a.id][0] - LAYOUT[b.id][0]);
  const existing = new Map([...graph.querySelectorAll('.node')].map((n) => [n.dataset.topic, n]));
  if (!graph.querySelector('svg.edges')) graph.appendChild(svg('svg', { class: 'edges', 'aria-hidden': 'true', focusable: 'false' }));
  for (const topic of order) {
    const stats = all.topics.find((t) => t.id === topic.id);
    let node = existing.get(topic.id);
    if (!node) {
      node = h(
        'button',
        { type: 'button', class: 'node', 'data-topic': topic.id, onclick: (e) => openDrawer(topic.id, e.currentTarget) },
        h('span', { class: 'node-title', text: SHORT[topic.id] || topic.title }),
        h('span', { class: 'node-meter' }, h('span', { class: 'node-bar' }, h('span', { class: 'node-fill' })), h('span', { class: 'node-count' })),
        h('span', { class: 'node-badge', text: 'Next', 'aria-hidden': 'true' })
      );
      graph.appendChild(node);
    }
    node.querySelector('.node-fill').style.width = `${percent(stats.solved, stats.total)}%`;
    node.querySelector('.node-count').textContent = `${stats.solved} / ${stats.total}`;
    const isNext = Boolean(next && next.topic === topic.id);
    node.toggleAttribute('data-next', isNext);
    node.toggleAttribute('data-complete', stats.complete);
    node.toggleAttribute('data-started', stats.solved > 0);
    node.setAttribute(
      'aria-label',
      `${topic.title}, ${stats.solved} of ${stats.total} solved${stats.complete ? ', complete' : ''}${isNext ? ', recommended next' : ''}`
    );
  }
  layoutGraph();
}

function layoutGraph() {
  const canvas = $('canvas');
  const graph = $('graph');
  if (!canvas || !graph || canvas.clientWidth === 0) return;
  const m = canvas.clientWidth >= graphWidth(WIDE) ? WIDE : COMPACT;
  const changed = metrics !== m;
  metrics = m;
  graph.dataset.size = m === WIDE ? 'wide' : 'compact';
  graph.style.width = `${graphWidth(m)}px`;
  graph.style.height = `${graphHeight(m)}px`;
  const [w, hgt] = m.node;
  const at = (id) => ({ x: m.pad + LAYOUT[id][0] * m.step[0], y: m.pad + LAYOUT[id][1] * m.step[1] });
  for (const node of graph.querySelectorAll('.node')) {
    const id = node.dataset.topic;
    const label = (m === COMPACT && COMPACT_SHORT[id]) || SHORT[id] || topicById(id).title;
    const title = node.querySelector('.node-title');
    if (title.textContent !== label) title.textContent = label;
    const p = at(id);
    node.style.left = `${p.x}px`;
    node.style.top = `${p.y}px`;
    node.style.width = `${w}px`;
    node.style.height = `${hgt}px`;
  }
  // Each line leaves its topic's bottom edge at the middle and comes into
  // the next one's top edge at the middle, as a smooth S-curve (a line that
  // skips a row passes through that row's empty columns).
  const edges = graph.querySelector('svg.edges');
  edges.setAttribute('width', graphWidth(m));
  edges.setAttribute('height', graphHeight(m));
  edges.setAttribute('viewBox', `0 0 ${graphWidth(m)} ${graphHeight(m)}`);
  edges.textContent = '';
  const started = new Set(progress(ROADMAP, solvedSet()).topics.filter((t) => t.solved > 0).map((t) => t.id));
  for (const [from, to] of ROADMAP.edges) {
    const a = at(from);
    const b = at(to);
    const x1 = a.x + w / 2;
    const y1 = a.y + hgt;
    const x2 = b.x + w / 2;
    const y2 = b.y;
    const bend = (y2 - y1) / 2;
    const d = `M${x1} ${y1} C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`;
    edges.appendChild(svg('path', { d, class: started.has(from) ? 'edge lit' : 'edge', 'data-from': from, 'data-to': to }));
  }
  if (changed) {
    // Narrow screens scroll the graph sideways: start with the topic to
    // work on next in view.
    const next = graph.querySelector('.node[data-next]') || graph.querySelector('.node');
    if (next && graphWidth(m) > canvas.clientWidth) {
      canvas.scrollLeft = Math.max(0, next.offsetLeft + w / 2 - canvas.clientWidth / 2);
    }
  }
}

// Arrow keys move between topics: to the nearest node in that direction.
function graphKeys(event) {
  const dirs = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  const dir = dirs[event.key];
  const from = event.target.closest && event.target.closest('.node');
  if (!dir || !from) return;
  const [fx, fy] = LAYOUT[from.dataset.topic];
  let best = null;
  let bestScore = Infinity;
  for (const [id, [x, y]] of Object.entries(LAYOUT)) {
    const dx = x - fx;
    const dy = y - fy;
    const along = dx * dir[0] + dy * dir[1];
    if (along <= 0) continue;
    const across = Math.abs(dx * dir[1]) + Math.abs(dy * dir[0]);
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  if (!best) return;
  event.preventDefault();
  $('graph').querySelector(`.node[data-topic="${best}"]`).focus();
}

// ---- the side panel --------------------------------------------------------

function openDrawer(topicId, opener) {
  openTopic = topicId;
  returnFocus = opener || document.activeElement;
  renderDrawer();
  $('drawer').hidden = false;
  $('backdrop').hidden = false;
  if (!document.documentElement.classList.contains('drawer-open')) {
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.documentElement.classList.add('drawer-open');
    document.body.style.paddingRight = scrollbar > 0 ? `${scrollbar}px` : '';
  }
  $('drawer-title').focus();
}

function closeDrawer({ restore = true } = {}) {
  if (!openTopic) return;
  openTopic = null;
  $('drawer').hidden = true;
  $('backdrop').hidden = true;
  document.documentElement.classList.remove('drawer-open');
  document.body.style.paddingRight = '';
  if (restore && returnFocus && returnFocus.isConnected) returnFocus.focus();
  returnFocus = null;
}

function drawerKeys(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDrawer();
    return;
  }
  if (event.key !== 'Tab') return;
  // Focus stays in the side panel while it is open.
  const focusable = [...$('drawer').querySelectorAll('a[href], button:not(:disabled), [tabindex="0"]')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === $('drawer-title'))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// The title links to the problem on leetcode.com in a new tab; the last word
// and the little arrow never wrap apart.
function problemLink(p) {
  const cut = p.title.lastIndexOf(' ');
  return h(
    'a',
    { href: problemUrl(p.slug), target: '_blank', rel: 'noopener noreferrer' },
    cut > 0 ? p.title.slice(0, cut + 1) : null,
    h('span', { class: 'nowrap' }, cut > 0 ? p.title.slice(cut + 1) : p.title, ICONS.external())
  );
}

function renderDrawer() {
  const drawer = $('drawer');
  const topic = topicById(openTopic);
  const stats = progress(ROADMAP, solvedSet()).topics.find((t) => t.id === topic.id);
  const next = nextProblem();
  // Keep focus on the same control across a redraw (a mark, a star).
  const active = document.activeElement;
  const keep = active && drawer.contains(active) ? { slug: active.dataset.slug, role: active.dataset.role, topic: active.dataset.prereq, title: active.id === 'drawer-title' } : null;
  const prereqs = ROADMAP.edges.filter(([, to]) => to === topic.id).map(([from]) => topicById(from));
  const all = progress(ROADMAP, solvedSet()).topics;

  drawer.textContent = '';
  const head = h(
    'div',
    { class: 'drawer-head' },
    h('h2', { id: 'drawer-title', tabindex: '-1' }, topic.title, h('span', { class: 'drawer-count', text: ` (${stats.solved} / ${stats.total})` })),
    h('button', { type: 'button', class: 'iconbtn close', 'aria-label': 'Close', title: 'Close', onclick: () => closeDrawer() }, ICONS.close())
  );
  const body = h('div', { class: 'drawer-body' });
  body.appendChild(bar(stats.solved, stats.total, `${topic.title} solved`));
  body.appendChild(h('h3', { text: 'Prerequisites' }));
  body.appendChild(
    prereqs.length
      ? h(
          'div',
          { class: 'prereqs' },
          ...prereqs.map((p) => {
            const s = all.find((t) => t.id === p.id);
            return h(
              'button',
              { type: 'button', class: 'prereq', 'data-prereq': p.id, onclick: () => switchTopic(p.id) },
              h('span', { class: 'prereq-title', text: p.title }),
              h('span', { class: 'prereq-count', text: `${s.solved} / ${s.total}` })
            );
          })
        )
      : h('p', { class: 'hint', text: 'None. This is where the roadmap starts.' })
  );
  const rows = topic.problems.map((p) => {
    const record = solved[p.slug];
    const isNext = Boolean(next && next.slug === p.slug);
    const when = record ? formatDate(record.at) : null;
    const tip = record ? (record.manual ? 'Marked solved by hand. Click to unmark.' : `Accepted${when ? ` on ${when}` : ''}. Click to unmark.`) : 'Click to mark solved.';
    return h(
      'tr',
      { 'data-slug': p.slug, 'data-solved': record ? '' : null, 'data-next': isNext ? '' : null },
      h(
        'td',
        { class: 'col-status' },
        h('button', { type: 'button', class: 'mark', 'data-slug': p.slug, 'data-role': 'mark', 'aria-pressed': String(Boolean(record)), 'aria-label': `${p.title} solved`, title: tip, onclick: () => toggleSolved(p.slug) }, ICONS.check())
      ),
      h(
        'td',
        { class: 'col-star' },
        h('button', { type: 'button', class: 'star', 'data-slug': p.slug, 'data-role': 'star', 'aria-pressed': String(Boolean(starred[p.slug])), 'aria-label': `Star ${p.title}`, title: starred[p.slug] ? 'Unstar' : 'Star to come back to it', onclick: () => toggleStar(p.slug) }, ICONS.star())
      ),
      h(
        'td',
        { class: 'col-title' },
        problemLink(p),
        isNext ? h('span', { class: 'next-pill', text: 'Next' }) : null
      ),
      h('td', { class: 'col-diff' }, difficulty(p.difficulty))
    );
  });
  body.appendChild(
    h(
      'table',
      { class: 'problems' },
      h('caption', { class: 'sr-only', text: `${topic.title} problems` }),
      h(
        'thead',
        {},
        h('tr', {}, h('th', { scope: 'col', class: 'col-status', text: 'Status' }), h('th', { scope: 'col', class: 'col-star', text: 'Star' }), h('th', { scope: 'col', class: 'col-title', text: 'Problem' }), h('th', { scope: 'col', class: 'col-diff', text: 'Difficulty' }))
      ),
      h('tbody', {}, ...rows)
    )
  );
  drawer.append(head, body);

  if (keep) {
    let target = null;
    if (keep.title) target = $('drawer-title');
    else if (keep.slug && keep.role) target = drawer.querySelector(`[data-role="${keep.role}"][data-slug="${keep.slug}"]`);
    else if (keep.topic) target = drawer.querySelector(`[data-prereq="${keep.topic}"]`);
    if (target) target.focus();
  }
}

function switchTopic(id) {
  openTopic = id;
  renderDrawer();
  $('drawer-title').focus();
  $('drawer').scrollTop = 0;
}

// ---- changes ---------------------------------------------------------------

async function ask(message) {
  try {
    const answer = await api.runtime.sendMessage(message);
    return Boolean(answer && answer.ok === true);
  } catch {
    return false;
  }
}

// The screen changes at once; the worker's write then comes back through
// storage.onChanged. If it fails, the old state comes back with a note.
async function toggleSolved(slug) {
  const before = solved;
  const on = !solved[slug];
  solved = { ...solved };
  if (on) solved[slug] = { at: new Date().toISOString(), count: 0, manual: true };
  else delete solved[slug];
  notice = '';
  render();
  if (!(await ask({ type: 'lc-tutor:solved-set', slug, solved: on }))) {
    solved = before;
    notice = 'The extension did not save that change. Reload the page and try again.';
    render();
  }
}

async function toggleStar(slug) {
  const before = starred;
  const on = !starred[slug];
  starred = { ...starred };
  if (on) starred[slug] = true;
  else delete starred[slug];
  notice = '';
  render();
  if (!(await ask({ type: 'lc-tutor:star-set', slug, starred: on }))) {
    starred = before;
    notice = 'The extension did not save that change. Reload the page and try again.';
    render();
  }
}

async function load() {
  try {
    const stored = await api.storage.local.get([SOLVED_KEY, STARRED_KEY]);
    solved = normalizeSolved(stored[SOLVED_KEY]);
    starred = normalizeStarred(stored[STARRED_KEY]);
  } catch {
    solved = {};
    starred = {};
  }
  render();
}

api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (SOLVED_KEY in changes) solved = normalizeSolved(changes[SOLVED_KEY].newValue);
  if (STARRED_KEY in changes) starred = normalizeStarred(changes[STARRED_KEY].newValue);
  if (SOLVED_KEY in changes || STARRED_KEY in changes) render();
});

wireTabs();
load();
