// LeetCode Capture - page-world layout bridge.
//
// Makes the Tutor tab a real tab of LeetCode's own flexlayout-react layout,
// so it moves, splits, maximizes, hides and shows exactly like Description or
// Submissions. Injected by panel.js as a real <script> tag (the same way
// content.js injects inject.js, for the same Firefox reasons) because the
// layout's Model object only exists in the page's MAIN world.
//
// What it does:
//   - finds the page's flexlayout Model through React's internals: from a
//     `.flexlayout__layout` element up its fiber chain to the first props
//     object (or class instance) carrying a `model` with doAction/toJson;
//   - adds a tab { component: "lc-tutor", id: "lc-tutor-tab" } to the tabset
//     holding Description with a plain action object (the action's name
//     changed between library versions, so both are tried);
//   - wraps that Model instance's toJson so the tab never reaches anything
//     the page saves: LeetCode stores the layout in the account and loads it
//     on devices where this extension may not be installed. An emptied
//     tabset the tab leaves behind is dropped and selection indexes are kept
//     right;
//   - marks the tab's pane and button with data-lc-tutor-pane and
//     data-lc-tutor-button so panel.js (isolated world) can mount into the
//     pane, and reports state over a CustomEvent;
//   - follows a replaced Model (a "Default layout" reset, a new problem) by
//     adding the tab again, and removes the tab on pagehide.
// Anything it cannot find or verify reports { native: false } and panel.js
// falls back to its injected tab.
//
// Where the tab was last moved to is remembered on this device only (the
// page's own save must never hold it): the bridge describes the spot by the
// names of the native tabs around it, never by node ids, reports it after
// each move by the student, and panel.js keeps it in the extension's own
// storage and hands it back with "start". Restoring puts the tab there on
// every add (a page load, a reset), and falls back to the default spot when
// the anchors are gone or the add fails.
//
// Protocol (detail is always a JSON string; see inject.js for why):
//   panel -> bridge  "lc-tutor:layout-command"   { cmd: "start", position? } | { cmd: "stop" }
//   bridge -> panel  "lc-tutor:layout-state"     { native, reason?, visible }
//   bridge -> panel  "lc-tutor:layout-position"  { position }
(() => {
  // Loaded by layout-bridge.test.js under Node for the pure parts.
  const underTest = typeof window === "undefined" && typeof module === "object" && module.exports;
  if (!underTest && window.__lcTutorLayoutBridge) return;
  if (!underTest) window.__lcTutorLayoutBridge = true;

  const TAB_ID = "lc-tutor-tab";
  const COMPONENT = "lc-tutor";
  const PANE_ATTR = "data-lc-tutor-pane";
  const BUTTON_ATTR = "data-lc-tutor-button";
  const CLONE_ATTR = "data-lc-tutor-tab";
  // "FlexLayout_AddTab" from 0.10 on, "FlexLayout_AddNode" before.
  const ADD_ACTIONS = ["FlexLayout_AddTab", "FlexLayout_AddNode"];
  const DELETE_ACTION = "FlexLayout_DeleteTab";
  const UPDATE_ATTRIBUTES_ACTION = "FlexLayout_UpdateNodeAttributes";
  const SIDES = ["left", "right", "top", "bottom"];
  // A burst of actions (a drag ends in several) is one move.
  const POSITION_DEBOUNCE_MS = 300;
  // How long the tab's pane may take to appear after it was added.
  const PANE_TIMEOUT_MS = 2000;

  const TAB_JSON = {
    type: "tab",
    id: TAB_ID,
    name: "Tutor",
    component: COMPONENT,
    // Like LeetCode's own tabs: it cannot be closed or renamed, but can be
    // dragged anywhere a native tab can.
    enableClose: false,
    enableRename: false,
    enableDrag: true,
    // A popped-out or floating window is another document the panel cannot
    // follow into.
    enablePopout: false,
    enablePopoutIcon: false,
    enableFloat: false,
    enableFloatIcon: false,
  };

  let started = false;
  let failed = null; // a reason once native mode has given up for good
  let model = null; // the Model the tab lives in and whose toJson is wrapped
  let unwrap = null; // undoes the toJson wrapper
  let unlisten = null;
  let addedAt = 0; // when the tab was added and its pane not seen yet
  let lastReport = "";
  let scheduled = false;
  // Counts the pane and button elements seen, so a pane React re-created
  // (same state otherwise) still reaches the panel.
  let generation = 0;
  let lastPane = null;
  let lastButton = null;

  function isModel(m) {
    return (
      !!m &&
      typeof m === "object" &&
      typeof m.doAction === "function" &&
      typeof m.toJson === "function" &&
      typeof m.getNodeById === "function" &&
      typeof m.visitNodes === "function"
    );
  }

  function fiberOf(el) {
    for (const key of Object.keys(el)) {
      if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) return el[key];
    }
    return null;
  }

  // The nearest props object (function component, forwardRef or hooks) or
  // class instance up the fiber chain that holds a flexlayout Model.
  function modelFrom(layoutEl) {
    let fiber = fiberOf(layoutEl);
    for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (props && isModel(props.model)) return props.model;
      const instance = fiber.stateNode;
      if (instance && instance.props && isModel(instance.props.model)) return instance.props.model;
    }
    return null;
  }

  function mainLayout() {
    // A floating or sub layout nests inside the main one; the outermost is
    // the page's own.
    return [...document.querySelectorAll(".flexlayout__layout")].find((el) => !el.parentElement || !el.parentElement.closest(".flexlayout__layout")) || null;
  }

  function call(node, method) {
    return node && typeof node[method] === "function" ? node[method]() : undefined;
  }

  function isTutor(node) {
    return call(node, "getId") === TAB_ID || call(node, "getComponent") === COMPONENT;
  }

  function findTab(m) {
    const byId = m.getNodeById(TAB_ID);
    if (byId) return byId;
    let found = null;
    m.visitNodes((n) => {
      if (!found && call(n, "getType") === "tab" && isTutor(n)) found = n;
    });
    return found;
  }

  // Where the tab goes by default: right after Description in its tabset,
  // or last in the first tabset when there is no Description. LeetCode's
  // tabs have no names (getName() is the library's "[Unnamed Tab]"), so the
  // component comes first and the name is only a fallback.
  function defaultSpot(m) {
    let byComponent = null;
    let byName = null;
    let firstTabset = null;
    m.visitNodes((n) => {
      const type = call(n, "getType");
      if (type === "tab" && !isTutor(n)) {
        if (!byComponent && String(call(n, "getComponent") || "").trim().toLowerCase() === "description") byComponent = n;
        if (!byName && tabName(n).toLowerCase() === "description") byName = n;
      }
      if (type === "tabset" && !firstTabset) firstTabset = n;
    });
    const description = byComponent || byName;
    const parent = description ? call(description, "getParent") : null;
    if (parent && call(parent, "getType") === "tabset") {
      const children = call(parent, "getChildren") || [];
      return { tabset: parent, index: children.indexOf(description) + 1 };
    }
    return firstTabset ? { tabset: firstTabset, index: -1 } : null;
  }

  // ---- keeping the tab out of the saved layout -------------------------

  const DROP = {};
  function scrub(json, isRoot) {
    if (Array.isArray(json)) return json.map((x) => scrub(x, false)).filter((x) => x !== DROP);
    if (!json || typeof json !== "object") return json;
    if (json.type === "tab" && (json.id === TAB_ID || json.component === COMPONENT)) return DROP;
    const out = {};
    for (const key of Object.keys(json)) {
      out[key] = key === "layout" ? scrub(json[key], true) : scrub(json[key], false);
      if (out[key] === DROP) delete out[key];
    }
    if (Array.isArray(json.children) && json.children.length && !out.children.length && !isRoot && (json.type === "tabset" || json.type === "row")) return DROP;
    if (json.type === "tabset" && Array.isArray(json.children) && typeof json.selected === "number") {
      const removedAt = json.children.map((c, i) => (c && c.type === "tab" && (c.id === TAB_ID || c.component === COMPONENT) ? i : -1)).filter((i) => i >= 0);
      if (removedAt.length) {
        // Where the selected tab is once the Tutor tab is gone; when the
        // Tutor tab itself was selected, the tab before it.
        const shift = removedAt.filter((i) => i < json.selected).length;
        let selected = json.selected - shift;
        if (removedAt.includes(json.selected)) selected -= 1;
        out.selected = Math.min(Math.max(0, selected), out.children.length - 1);
      }
    }
    return out;
  }

  // ---- where the tab is, by the tabs around it --------------------------
  //
  // Each native tab is named by tabKey (its component, else its name).
  // { v: 1, mode: "tabset", anchors: [keys of the native tabs in its
  //   tabset], after: the native tab right before it or null, index: how
  //   many native tabs come before it }
  // { v: 1, mode: "dock", anchors: [keys in the tabset beside it], side:
  //   where it sits against that tabset, ratio?: its share of the two }

  function cleanName(name) {
    return typeof name === "string" ? name.trim().slice(0, 60) : "";
  }

  // The library's name for a tab without one.
  const UNNAMED = "[Unnamed Tab]";

  // A tab's own name, or "" when it has none.
  function tabName(node) {
    const name = cleanName(call(node, "getName"));
    return name === UNNAMED ? "" : name;
  }

  // What names a native tab in a remembered spot: its component (all a
  // tab has on leetcode.com), else its name.
  function tabKey(node) {
    return cleanName(call(node, "getComponent")) || tabName(node);
  }

  // Whether `anchor` names this tab, by component or (a spot saved by an
  // older version) by name.
  function tabMatches(node, anchor) {
    return !!anchor && (cleanName(call(node, "getComponent")) === anchor || tabName(node) === anchor);
  }

  function validPosition(p) {
    if (!p || typeof p !== "object" || p.v !== 1) return null;
    if (!Array.isArray(p.anchors) || !p.anchors.length || p.anchors.length > 20) return null;
    if (!p.anchors.every((a) => typeof a === "string" && a.length > 0 && a.length <= 60)) return null;
    const anchors = p.anchors.slice();
    if (p.mode === "tabset") {
      const after = p.after === null || p.after === undefined ? null : p.after;
      if (after !== null && (typeof after !== "string" || after.length > 60)) return null;
      if (!Number.isInteger(p.index) || p.index < 0 || p.index > 50) return null;
      return { v: 1, mode: "tabset", anchors, after, index: p.index };
    }
    if (p.mode === "dock") {
      if (!SIDES.includes(p.side)) return null;
      const out = { v: 1, mode: "dock", anchors, side: p.side };
      if (typeof p.ratio === "number" && p.ratio > 0.02 && p.ratio < 0.98) out.ratio = Math.round(p.ratio * 1000) / 1000;
      return out;
    }
    return null;
  }

  // The tabset (among `tabsets`, each { node, names }) that shares the most
  // tab names with `anchors`.
  function bestTabset(tabsets, anchors) {
    let best = null;
    let bestScore = 0;
    for (const t of tabsets) {
      const score = t.names.filter((n) => anchors.includes(n)).length;
      if (score > bestScore) {
        best = t;
        bestScore = score;
      }
    }
    return best;
  }

  if (underTest) {
    module.exports = { scrub: (json) => scrub(json, false), wrapToJson, validPosition, bestTabset, TAB_ID, COMPONENT };
    return;
  }

  function wrapToJson(m) {
    const own = Object.prototype.hasOwnProperty.call(m, "toJson");
    const original = m.toJson;
    const wrapped = function toJson(...args) {
      return scrub(original.apply(this, args), false);
    };
    m.toJson = wrapped;
    return () => {
      if (m.toJson !== wrapped) return;
      if (own) m.toJson = original;
      else delete m.toJson;
    };
  }

  // ---- adding and removing the tab --------------------------------------

  // The library's own Action objects are not reachable from here, so this
  // builds one with the same shape: listeners call isAdjusting() on every
  // action (0.11 throws inside doAction on a bare { type, data }, after the
  // change, so the layout never redraws).
  function action(type, data) {
    return {
      type,
      data,
      // Tells the move listener this change is the bridge's own.
      lcTutorBridge: true,
      adjusting: false,
      userData: undefined,
      setAdjusting(value) {
        this.adjusting = value;
        return this;
      },
      setUserData(value) {
        this.userData = value;
        return this;
      },
      isAdjusting() {
        return this.adjusting;
      },
      toJSON() {
        return { type: this.type, data: this.data };
      },
    };
  }

  function tryAdd(m, tabset, location, index) {
    for (const type of ADD_ACTIONS) {
      try {
        m.doAction(action(type, { json: { ...TAB_JSON }, toNode: tabset.getId(), location, index, select: false }));
      } catch {
        // an older or newer action shape; try the next
      }
      if (findTab(m)) return true;
    }
    return false;
  }

  // The remembered spot if this layout still has it, else the default one.
  function addTab(m) {
    try {
      if (position && addAt(m, position)) return true;
    } catch {
      // a spot this layout cannot take; the default one below
    }
    if (findTab(m)) return true;
    const home = defaultSpot(m);
    return !!home && tryAdd(m, home.tabset, "center", home.index);
  }

  function removeTab(m) {
    const node = m && findTab(m);
    if (!node) return;
    try {
      m.doAction(action(DELETE_ACTION, { node: node.getId() }));
    } catch {
      // the model is being torn down
    }
  }

  function nativeTabs(tabset) {
    return (call(tabset, "getChildren") || []).filter((n) => call(n, "getType") === "tab" && !isTutor(n));
  }

  // The keys a spot is stored with.
  function nativeNames(tabset) {
    return nativeTabs(tabset).map(tabKey).filter(Boolean);
  }

  // Everything an anchor may match: keys, and names for older saved spots.
  function allTabsets(m) {
    const out = [];
    m.visitNodes((n) => {
      if (call(n, "getType") !== "tabset") return;
      const names = new Set(nativeNames(n));
      for (const tab of nativeTabs(n)) if (tabName(tab)) names.add(tabName(tab));
      out.push({ node: n, names: [...names] });
    });
    return out;
  }

  function rectOf(node) {
    const r = call(node, "getRect");
    return r && typeof r.x === "number" && typeof r.width === "number" ? r : null;
  }

  // The tabset beside `tabset` in its row. A tabset directly next to it is
  // the faithful anchor: docking against it on that side puts the tab back
  // into the same row. Only when both neighbors are rows is the nearest
  // tabset inside one used.
  function neighborTabset(tabset) {
    const row = call(tabset, "getParent");
    const siblings = (row && call(row, "getChildren")) || [];
    const i = siblings.indexOf(tabset);
    const usable = (n) => n && call(n, "getType") === "tabset" && nativeNames(n).length;
    for (const n of [siblings[i - 1], siblings[i + 1]]) if (usable(n)) return n;
    let next = siblings[i + 1];
    let fromStart = true;
    if (!next) {
      next = siblings[i - 1];
      fromStart = false;
    }
    for (let depth = 0; next && call(next, "getType") === "row" && depth < 10; depth++) {
      const kids = call(next, "getChildren") || [];
      next = fromStart ? kids[0] : kids[kids.length - 1];
    }
    return next && call(next, "getType") === "tabset" ? next : null;
  }

  function describe(m) {
    const node = findTab(m);
    const tabset = node && call(node, "getParent");
    if (!tabset || call(tabset, "getType") !== "tabset") return null;
    const children = call(tabset, "getChildren") || [];
    const natives = children.filter((n) => !isTutor(n));
    if (natives.length) {
      const before = children.slice(0, children.indexOf(node)).filter((n) => !isTutor(n));
      return validPosition({
        v: 1,
        mode: "tabset",
        anchors: nativeNames(tabset),
        after: before.length ? tabKey(before[before.length - 1]) || null : null,
        index: before.length,
      });
    }
    const anchor = neighborTabset(tabset);
    if (!anchor || !nativeNames(anchor).length) return null;
    const a = rectOf(anchor);
    const t = rectOf(tabset);
    let side = null;
    if (a && t && a.width && t.width) {
      const dx = t.x + t.width / 2 - (a.x + a.width / 2);
      const dy = t.y + t.height / 2 - (a.y + a.height / 2);
      side = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "top" : "bottom";
    }
    if (!side) return null;
    const out = { v: 1, mode: "dock", anchors: nativeNames(anchor), side };
    const wt = call(tabset, "getWeight");
    const wa = call(anchor, "getWeight");
    if (call(anchor, "getParent") === call(tabset, "getParent") && typeof wt === "number" && typeof wa === "number" && wt + wa > 0) out.ratio = wt / (wt + wa);
    return validPosition(out);
  }

  // Puts the tab where `position` says; false when that spot does not exist
  // in this layout or the add did not take.
  function addAt(m, position) {
    const p = validPosition(position);
    if (!p) return false;
    const target = bestTabset(allTabsets(m), p.anchors);
    if (!target) return false;
    let location = "center";
    let index = -1;
    if (p.mode === "tabset") {
      const children = call(target.node, "getChildren") || [];
      const natives = children.filter((n) => !isTutor(n));
      const after = p.after === null ? -1 : natives.findIndex((n) => tabMatches(n, p.after));
      if (p.after === null) index = 0;
      else if (after >= 0) index = children.indexOf(natives[after]) + 1;
      else index = Math.min(p.index, children.length);
    } else {
      location = p.side;
    }
    if (!tryAdd(m, target.node, location, index)) return false;
    if (p.mode === "dock" && p.ratio) {
      const tabset = call(findTab(m), "getParent");
      const wt = call(tabset, "getWeight");
      const wa = call(target.node, "getWeight");
      if (tabset && call(tabset, "getParent") === call(target.node, "getParent") && typeof wt === "number" && typeof wa === "number") {
        const sum = wt + wa;
        try {
          m.doAction(action(UPDATE_ATTRIBUTES_ACTION, { node: tabset.getId(), json: { weight: sum * p.ratio } }));
          m.doAction(action(UPDATE_ATTRIBUTES_ACTION, { node: target.node.getId(), json: { weight: sum * (1 - p.ratio) } }));
        } catch {
          // the split stays even
        }
      }
    }
    return true;
  }

  // ---- reporting moves -------------------------------------------------

  let position = null; // the last spot known (from storage or a move)
  let positionTimer = 0;

  function onModelAction(act) {
    schedule();
    // The bridge's own adds and restores are not the student moving it.
    if (act && act.lcTutorBridge) return;
    clearTimeout(positionTimer);
    positionTimer = setTimeout(notePosition, POSITION_DEBOUNCE_MS);
  }

  function notePosition() {
    if (!model || failed) return;
    let now = null;
    try {
      now = describe(model);
    } catch {
      return;
    }
    if (!now || JSON.stringify(now) === JSON.stringify(position)) return;
    position = now;
    document.dispatchEvent(new CustomEvent("lc-tutor:layout-position", { detail: JSON.stringify({ position: now }) }));
  }

  function release() {
    clearTimeout(positionTimer);
    if (unlisten) unlisten();
    unlisten = null;
    if (unwrap) unwrap();
    unwrap = null;
    model = null;
  }

  function adopt(m) {
    release();
    model = m;
    unwrap = wrapToJson(m);
    if (typeof m.addChangeListener === "function" && typeof m.removeChangeListener === "function") {
      const listener = (act) => onModelAction(act);
      m.addChangeListener(listener);
      unlisten = () => m.removeChangeListener(listener);
    } else {
      // Older versions: watch the instance's doAction instead.
      const own = Object.prototype.hasOwnProperty.call(m, "doAction");
      const original = m.doAction;
      const wrapped = function doAction(act, ...rest) {
        const out = original.call(this, act, ...rest);
        try {
          onModelAction(act);
        } catch {
          // never break the page's own action
        }
        return out;
      };
      m.doAction = wrapped;
      unlisten = () => {
        if (m.doAction !== wrapped) return;
        if (own) m.doAction = original;
        else delete m.doAction;
      };
    }
  }

  function giveUp(reason) {
    failed = reason;
    if (model) removeTab(model);
    release();
    unmark();
    report({ native: false, reason });
  }

  // ---- the tab's DOM -----------------------------------------------------

  // The button's label. The tab's JSON has the name "Tutor", but a page
  // whose onRenderTab draws labels by component (leetcode.com does) draws
  // nothing for one it does not know. An empty button gets the text here,
  // and an observer on it puts the text back after React re-renders it.
  const LABEL_ATTR = "data-lc-tutor-label";
  let labelled = null;
  let labelObserver = null;

  function applyLabel() {
    const button = labelled;
    if (!button || !button.isConnected) return;
    const own = button.querySelector(`[${LABEL_ATTR}]`);
    const others = button.textContent.replace(own ? own.textContent : "", "").trim();
    if (others) {
      // The page drew a label of its own.
      if (own) own.remove();
      return;
    }
    if (own && own.textContent === "Tutor") return;
    if (own) own.remove();
    const span = document.createElement("span");
    span.setAttribute(LABEL_ATTR, "");
    span.textContent = "Tutor";
    (button.querySelector(".flexlayout__tab_button_content") || button).appendChild(span);
  }

  function labelButton(button) {
    if (button === labelled) {
      applyLabel();
      return;
    }
    unlabel();
    labelled = button;
    applyLabel();
    labelObserver = new MutationObserver(applyLabel);
    labelObserver.observe(button, { childList: true, subtree: true, characterData: true });
  }

  function unlabel() {
    if (labelObserver) labelObserver.disconnect();
    labelObserver = null;
    labelled = null;
  }

  function unmark(keepPane, keepButton) {
    if (labelled && labelled !== keepButton) unlabel();
    for (const el of document.querySelectorAll(`[${PANE_ATTR}]`)) if (el !== keepPane) el.removeAttribute(PANE_ATTR);
    for (const el of document.querySelectorAll(`[${BUTTON_ATTR}]`)) if (el !== keepButton) el.removeAttribute(BUTTON_ATTR);
  }

  function byPath(root, selector, path) {
    return [...root.querySelectorAll(selector)].find((el) => el.getAttribute("data-layout-path") === path) || null;
  }

  // flexlayout gives a tab's pane the node's path ("/ts0/t4") and its button
  // the same path with "tb" ("/ts0/tb4").
  function domFor(node, layoutEl) {
    const path = call(node, "getPath");
    if (typeof path !== "string") return { pane: null, button: null };
    const buttonPath = path.replace(/\/t(\d+)$/, "/tb$1");
    return {
      pane: byPath(layoutEl, ".flexlayout__tab", path),
      button: byPath(layoutEl, ".flexlayout__tab_button", buttonPath),
    };
  }

  function isShown(node, pane) {
    const v = call(node, "isVisible");
    if (typeof v === "boolean") return v && !!pane && pane.getBoundingClientRect().width > 0;
    return !!pane && getComputedStyle(pane).display !== "none" && pane.getBoundingClientRect().width > 0;
  }

  function report(state) {
    const text = JSON.stringify(state);
    if (text === lastReport) return;
    lastReport = text;
    document.dispatchEvent(new CustomEvent("lc-tutor:layout-state", { detail: text }));
  }

  // ---- the loop ----------------------------------------------------------

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      sync();
    }, 0);
  }

  function sync() {
    if (!started || failed) return;
    const layoutEl = mainLayout();
    if (!layoutEl) {
      // No layout yet (still loading) or none any more (left the problem).
      unmark();
      report({ native: model ? true : null, present: false, visible: false });
      return;
    }
    const m = modelFrom(layoutEl);
    if (!m) {
      giveUp("no-model");
      return;
    }
    if (m !== model) {
      adopt(m);
      addedAt = 0;
    }
    let node = findTab(m);
    if (!node) {
      if (!addTab(m)) {
        giveUp("add-failed");
        return;
      }
      node = findTab(m);
      addedAt = Date.now();
    }
    const { pane, button } = domFor(node, layoutEl);
    unmark(pane, button);
    // flexlayout renders a tab's pane only once the tab is first shown
    // (render on demand), so a button without a pane is normal; a shown tab
    // without one, or no button at all, is a layout this cannot work with.
    const visible = call(node, "isVisible");
    const missing = !button ? "no-button" : !pane && visible !== false ? "no-pane" : null;
    if (missing) {
      if (!addedAt) addedAt = Date.now();
      if (Date.now() - addedAt > PANE_TIMEOUT_MS) {
        giveUp(missing);
        return;
      }
      setTimeout(schedule, 100);
      report({ native: true, present: false, visible: false });
      return;
    }
    addedAt = 0;
    if (pane !== lastPane || button !== lastButton) {
      lastPane = pane;
      lastButton = button;
      generation += 1;
    }
    if (pane && !pane.hasAttribute(PANE_ATTR)) pane.setAttribute(PANE_ATTR, "");
    if (!button.hasAttribute(BUTTON_ATTR)) button.setAttribute(BUTTON_ATTR, "");
    if (!button.hasAttribute(CLONE_ATTR)) button.setAttribute(CLONE_ATTR, "");
    labelButton(button);
    report({ native: true, present: true, visible: !!pane && isShown(node, pane), generation });
  }

  let observers = [];
  function start() {
    if (started) return;
    started = true;
    lastReport = "";
    const tree = new MutationObserver(schedule);
    tree.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "data-layout-path"] });
    observers = [tree];
    window.addEventListener("resize", schedule);
    sync();
  }

  function stop() {
    if (!started) return;
    started = false;
    for (const o of observers) o.disconnect();
    observers = [];
    window.removeEventListener("resize", schedule);
    if (model) removeTab(model);
    release();
    unmark();
  }

  document.addEventListener("lc-tutor:layout-command", (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.detail === "string" ? event.detail : "");
    } catch {
      return;
    }
    if (msg && msg.cmd === "start") {
      if (!started) position = validPosition(msg.position);
      if (failed) report({ native: false, reason: failed });
      else start();
    } else if (msg && msg.cmd === "stop") {
      stop();
    }
  });

  // Leaving the page (or going into the back-forward cache): take the tab
  // out, so nothing the page saves on the way out can carry it, and put it
  // back if the page is shown again.
  window.addEventListener("pagehide", () => {
    if (!started) return;
    stop();
    window.__lcTutorLayoutResume = true;
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && window.__lcTutorLayoutResume) {
      window.__lcTutorLayoutResume = false;
      start();
    }
  });

  report({ ready: true });
})();
