/**
 * The list rows are memoised, so the comparator is the contract.
 *
 * A row is ~29 elements and the panel rerenders on every committed keystroke,
 * every checkbox, every menu and every tab switch; `test/render-smoke.mjs` can
 * never catch a stale row because it renders each component once. The risk is
 * one-sided and silent: a comparator that answers "same" when something moved
 * leaves the old name, the old selection or the old drag badge on screen, and
 * nothing throws. Answering "different" too often only costs a repaint.
 *
 * These tests pin both directions for every dimension the row actually draws.
 * The list hands rows fresh objects on each render (a drag set from
 * `splitDragIds`, a rename object from the editor state, callback wrappers that
 * close over the session id), so "same facts, new objects" must compare equal —
 * otherwise the memo never hits and the whole exercise is dead weight.
 */
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const React = {
  Component: class {
    constructor(props) {
      this.props = props;
      this.state = {};
    }
    setState() {}
  },
  Fragment: Symbol("Fragment"),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  createPortal: (node) => node,
  memo: (type) => type,
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (compute) => compute(),
  useCallback: (fn) => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

const store = new Map();
globalThis.window = {
  __ModuleLoader__: { load: ({ factory }) => { mod = factory(requireShim); } },
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
  innerWidth: 1280,
  innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
};
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, appendChild() {}, style: {} }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  getElementById: () => null,
  createTextNode: () => ({}),
};
globalThis.fetch = async () => ({ json: async () => ({ ok: true, result: {} }), status: 200 });

let mod = null;
const requireShim = (name) => {
  if (name === "react") return React;
  throw new Error("unexpected require: " + name);
};
// Same trick as render-smoke: the export line is appended to a copy, so the
// production module keeps its private surface.
const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8").replace(
  "    exports.apply = apply;",
  "    exports.__test = { sameRowProps };\n    exports.apply = apply;",
);
new Function("window", "document", "navigator", "fetch", source)(
  globalThis.window,
  globalThis.document,
  { clipboard: { writeText: async () => {} } },
  globalThis.fetch,
);
if (!mod) throw new Error("the module factory did not run");
const { sameRowProps } = mod.__test;

const session = (extra = {}) => ({ id: "s-1", title: "整理报表", status: "idle", ...extra });
/** The one object the list holds for this session; a reload replaces it. */
const S = session();

/**
 * One row's props, built the way `rowsOf` builds them: the function props are
 * new every render, and so are the objects around the facts.
 */
const props = (extra = {}) => {
  return {
    session: S,
    selected: false,
    checked: false,
    now: 1_700_000_000_000,
    depth: 0,
    childCount: 0,
    collapsed: false,
    onSelect: () => {},
    onCheck: () => {},
    onToggleChildren: () => {},
    onBeginRename: () => {},
    onRowContextMenu: () => {},
    onOpenSession: () => {},
    rename: null,
    clipboard: { mode: null, ids: [] },
    dragSet: { ids: [], sessions: [], nodes: [] },
    contentHit: null,
    ...extra,
  };
};

/** The same facts as `props()`, rebuilt from scratch — what the next render hands it. */
const again = (extra = {}) => {
  const base = props(extra);
  const fresh = (fn) => (typeof fn === "function" ? () => {} : fn);
  return {
    ...base,
    onSelect: fresh(base.onSelect),
    onCheck: fresh(base.onCheck),
    onToggleChildren: fresh(base.onToggleChildren),
    onBeginRename: fresh(base.onBeginRename),
    onRowContextMenu: fresh(base.onRowContextMenu),
    onOpenSession: fresh(base.onOpenSession),
    clipboard: { ...base.clipboard, ids: [...(base.clipboard.ids ?? [])] },
    dragSet: {
      ids: [...(base.dragSet.ids ?? [])],
      sessions: [...(base.dragSet.sessions ?? [])],
      nodes: [...(base.dragSet.nodes ?? [])],
    },
  };
};

test("fresh objects over the same facts are the same row", () => {
  assert.equal(sameRowProps(props(), again()), true);
});

test("a reload hands over a new session object and must repaint", () => {
  const a = props();
  assert.equal(sameRowProps(a, again({ session: { ...a.session } })), false, "same id, new object: its facts may have moved");
});

test("selection, check and the clock each repaint their row", () => {
  const a = props();
  assert.equal(sameRowProps(a, again({ selected: true })), false);
  assert.equal(sameRowProps(a, again({ checked: true })), false);
  assert.equal(sameRowProps(a, again({ now: a.now + 1000 })), false);
  assert.equal(sameRowProps(a, again({ depth: 1 })), false);
  assert.equal(sameRowProps(a, again({ childCount: 2 })), false);
  assert.equal(sameRowProps(a, again({ collapsed: true })), false);
});

test("the row being renamed follows the typing", () => {
  const typing = (value) => ({ kind: "session", id: "s-1", surface: "row", value });
  const a = props({ rename: typing("整") });
  assert.equal(sameRowProps(a, again({ rename: typing("整") })), true, "same text, new object");
  assert.equal(sameRowProps(a, again({ rename: typing("整理") })), false);
  assert.equal(sameRowProps(a, again({ rename: null })), false);
  assert.equal(
    sameRowProps(a, again({ rename: { ...typing("整"), surface: "tree" } })),
    false,
    "the editor commits through the rename it was handed",
  );
});

test("a cut mark repaints only the rows it marks", () => {
  const a = props({ clipboard: { mode: "cut", ids: ["s-1"] } });
  assert.equal(sameRowProps(a, again({ clipboard: { mode: "cut", ids: ["s-1"] } })), true);
  assert.equal(sameRowProps(a, again({ clipboard: { mode: "cut", ids: [] } })), false, "this row is no longer cut");
  const other = props({ clipboard: { mode: "cut", ids: ["s-2"] } });
  assert.equal(sameRowProps(other, again({ clipboard: { mode: "cut", ids: ["s-2"] } })), true);
  assert.equal(sameRowProps(props({ clipboard: { mode: "copy", ids: ["s-1"] } }), again({ clipboard: { mode: "copy", ids: ["s-1"] } })), true, "copy does not draw on the row");
});

test("a drag set repaints when the ids, sessions or nodes change", () => {
  const dragging = { ids: ["s-1", "s-2"], sessions: ["s-1"], nodes: [] };
  const a = props({ dragSet: dragging });
  assert.equal(sameRowProps(a, again({ dragSet: { ...dragging } })), true);
  assert.equal(sameRowProps(a, again({ dragSet: { ...dragging, ids: ["s-1"] } })), false);
  assert.equal(sameRowProps(a, again({ dragSet: { ...dragging, sessions: [] } })), false, "a session dragged with its children changes the badge");
  assert.equal(sameRowProps(a, again({ dragSet: { ...dragging, nodes: ["d-1"] } })), false);
});

test("a search hit repaints when its count or snippet moves", () => {
  const hit = { count: 2, snippet: "整理报表…" };
  const a = props({ contentHit: hit });
  assert.equal(sameRowProps(a, again({ contentHit: { ...hit } })), true);
  assert.equal(sameRowProps(a, again({ contentHit: { ...hit, count: 3 } })), false);
  assert.equal(sameRowProps(a, again({ contentHit: { ...hit, snippet: "别的…" } })), false);
  assert.equal(sameRowProps(a, again({ contentHit: null })), false);
});

test("callbacks are compared by presence, not identity", () => {
  const before = props();
  const after = again();
  assert.notEqual(before.onSelect, after.onSelect, "the fixtures really do hand over new functions");
  assert.equal(sameRowProps(before, after), true);
  assert.equal(sameRowProps(before, again({ onRowContextMenu: null })), false, "a read-only list draws no menu button");
  assert.equal(sameRowProps(before, again({ onBeginRename: null })), false);
});
