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
// Protocol (detail is always a JSON string; see inject.js for why):
//   panel -> bridge  "lc-tutor:layout-command"  { cmd: "start" | "stop" }
//   bridge -> panel  "lc-tutor:layout-state"    { native, reason?, visible }
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
  // or last in the first tabset when there is no Description.
  function defaultSpot(m) {
    let description = null;
    let firstTabset = null;
    m.visitNodes((n) => {
      const type = call(n, "getType");
      if (type === "tab" && !isTutor(n) && !description && String(call(n, "getName") || "").trim().toLowerCase() === "description") description = n;
      if (type === "tabset" && !firstTabset) firstTabset = n;
    });
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

  if (underTest) {
    module.exports = { scrub: (json) => scrub(json, false), wrapToJson, TAB_ID, COMPONENT };
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

  function addTab(m) {
    const home = defaultSpot(m);
    if (!home) return false;
    for (const type of ADD_ACTIONS) {
      try {
        m.doAction(action(type, { json: { ...TAB_JSON }, toNode: home.tabset.getId(), location: "center", index: home.index, select: false }));
      } catch {
        // an older or newer action shape; try the next
      }
      if (findTab(m)) return true;
    }
    return false;
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

  function release() {
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
      const listener = () => schedule();
      m.addChangeListener(listener);
      unlisten = () => m.removeChangeListener(listener);
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

  function unmark(keepPane, keepButton) {
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
