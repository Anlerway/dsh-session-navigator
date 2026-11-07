/**
 * What one `sessions-changed` push costs the panel.
 *
 * The Host grades its own news — structural, content, cosmetic — and this is the
 * Client's half of that contract: `liveAnswer(payload)` says whether to reload at
 * all and whether the reload may walk the logs. Getting it wrong is quiet in both
 * directions: too eager and every finished turn becomes a filesystem walk (the
 * panel audibly hitches while a conversation runs), too lazy and a renamed
 * session keeps its old title until something else reloads.
 *
 * The old wire format has to keep working: before the split, "only the running
 * set moved" was said with `refresh: false` and no `cosmetic` field at all, and a
 * client that reads that as "reload without the walk" is right.
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
const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8").replace(
  "    exports.apply = apply;",
  "    exports.__test = { liveAnswer };\n    exports.apply = apply;",
);
new Function("window", "document", "navigator", "fetch", source)(
  globalThis.window,
  globalThis.document,
  { clipboard: { writeText: async () => {} } },
  globalThis.fetch,
);
if (!mod) throw new Error("the module factory did not run");
const { liveAnswer } = mod.__test;

test("a cosmetic push is already applied, so nothing is read", () => {
  assert.deepEqual(liveAnswer({ reason: "running", refresh: false, cosmetic: true }), { reload: false, refresh: false });
  // The grade wins even if some other field in the same batch says otherwise:
  // a batch is cosmetic only when every event inside it was.
  assert.deepEqual(liveAnswer({ reason: "title", refresh: true, cosmetic: true }), { reload: false, refresh: false });
});

test("an old Host says cosmetic with refresh: false alone", () => {
  assert.deepEqual(liveAnswer({ reason: "running", refresh: false }), { reload: false, refresh: false });
});

test("content news reloads, but does not buy the walk", () => {
  assert.deepEqual(liveAnswer({ reason: "turn", refresh: false, cosmetic: false }), { reload: true, refresh: false });
});

test("a structural push walks the logs", () => {
  assert.deepEqual(liveAnswer({ reason: "session", refresh: true, cosmetic: false }), { reload: true, refresh: true });
  assert.deepEqual(liveAnswer({ reason: "session", refresh: true }), { reload: true, refresh: true }, "old Host, structural");
});

test("no payload reloads nothing", () => {
  assert.deepEqual(liveAnswer(null), { reload: false, refresh: false });
  assert.deepEqual(liveAnswer(undefined), { reload: false, refresh: false });
});
