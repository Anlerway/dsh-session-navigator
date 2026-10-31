/**
 * Render smoke test for lib/client.js.
 *
 * The plugin has no build step and no bundler, so nothing type-checks it and
 * `node --check` only proves it parses. This harness closes the next gap: it
 * loads the real client bundle against a stub React (hooks return their initial
 * values, effects do not run) and invokes the components once, so a rename that
 * forgot a binding, or a prop that is read but never passed, throws here instead
 * of in the DSH renderer.
 *
 * It is deliberately not a DOM test: there is no jsdom in this repository and
 * adding one would break the zero-dependency rule. What it can prove is that
 * every component's render body evaluates against realistic data.
 */
import { readFileSync } from "node:fs";
import { decorateTree } from "../lib/domain/tree-rules.js";

// A minimal class base, because PanelBoundary is the one class component in the
// bundle (an error boundary has no hook equivalent).
class StubComponent {
  constructor(props) {
    this.props = props;
    this.state = {};
  }
  setState(patch) {
    this.state = { ...this.state, ...(typeof patch === "function" ? patch(this.state) : patch) };
  }
}

// How many hooks the component being called has used so far.
//
// React requires that number to be identical on every render of the same
// component, and breaking it is a crash ("Rendered more hooks than during the
// previous render"), not a wrong pixel. DetailPane had exactly that: a hook sat
// below its empty-state return, so selecting the first row threw. The stub
// counts the calls and `render` compares them across renders of one component.
let hookCalls = 0;

const React = {
  Component: StubComponent,
  Fragment: Symbol("Fragment"),
  // React puts children in props.children as well as passing them positionally;
  // PanelBoundary renders `this.props.children`, so the stub must match.
  createElement: (type, props, ...children) => {
    const merged = { ...(props ?? {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type, props: merged, children };
  },
  createPortal: (node) => node,
  useRef: (initial) => {
    hookCalls += 1;
    return { current: initial };
  },
  useState: (initial) => {
    hookCalls += 1;
    return [typeof initial === "function" ? initial() : initial, () => {}];
  },
  useEffect: () => {
    hookCalls += 1;
  },
  useMemo: (compute) => {
    hookCalls += 1;
    return compute();
  },
  useCallback: (fn) => {
    hookCalls += 1;
    return fn;
  },
  useSyncExternalStore: (_subscribe, getSnapshot) => {
    hookCalls += 1;
    return getSnapshot();
  },
};

const store = new Map();
globalThis.window = {
  __ModuleLoader__: { load: ({ factory }) => { mod = factory(requireShim); } },
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  },
  innerWidth: 1280,
  innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
};
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, style: {} }),
  head: { appendChild: () => {} },
  body: { appendChild: () => {} },
  getElementById: () => null,
  createTextNode: () => ({}),
};
const navigatorShim = { clipboard: { writeText: async () => {} } };
// Every request the module makes is recorded, so a test can prove that a
// question asks nothing of the host until it is answered.
const fetchCalls = [];
// The bundle closes over this function (the factory is called with it), so a
// test that wants a different answer sets `summaryRecord` and re-reads the
// store rather than swapping globalThis.fetch, which the bundle never looks at.
let summaryRecord = null;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
  const path = String(url);
  if (path.includes("/summaries") && summaryRecord) {
    return {
      status: 200,
      json: async () => ({
        ok: true,
        result: { sessions: { [summaryRecord.id]: summaryRecord.entry }, spend: {} },
      }),
    };
  }
  if (path.includes("/summarize/state")) {
    return { status: 200, json: async () => ({ ok: true, result: { running: false } }) };
  }
  return { json: async () => ({ ok: true, result: {} }), status: 200 };
};

let mod = null;
const requireShim = (name) => {
  if (name === "react") return React;
  // The plugin used to probe @deepseek-ai/dsh-client-ui-primitives for Modal /
  // RiskConfirmation. It no longer does: the panel and every dialog are drawn by
  // the plugin itself, so a host without that package behaves identically. The
  // shim still refuses it, which pins exactly that: requiring it would throw and
  // fail the whole run.
  throw new Error("unexpected require: " + name);
};

// The components are module-private. Instead of widening the production export
// surface just for a test, the harness appends its own export line to a copy of
// the bundle and compiles that.
const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8")
  .replace(
    "    exports.apply = apply;",
    [
      "    exports.__test = { Trow, SessionRow, ContainerRow, TreePane, ListPane, DetailPane, FilterDialog, SearchScopeDialog, CommandMenu, DialogHost, frameSizeOf, PanelBoundary, iconOfNode, nodeLabel, headerActionsFor, hdrIcon, dialogStore, askConfirm, DialogChannel, DialogHost, SessionHeaderActions, SessionMenuItems, splitDragIds, draggedSessionIds, draggedNodeIds, summaryStore, statusOf, withDshStatus, pendingKindOf };",
      "    exports.apply = apply;",
    ].join("\n"),
  );

new Function("window", "document", "navigator", "fetch", source)(
  globalThis.window, globalThis.document, navigatorShim, globalThis.fetch,
);
if (!mod) throw new Error("the module factory did not run");

/** Hook calls per component, to catch a hook that a branch can skip. */
const hookCounts = new WeakMap();

/** Walk an element tree, calling every function component once. */
function render(element) {
  if (element === null || element === undefined || element === false || element === true) return null;
  if (Array.isArray(element)) return element.map(render);
  if (typeof element !== "object") return element;
  // Children are passed as trailing arguments, exactly as React does: a
  // component that destructures `props` alone still receives its nested
  // elements through createElement's rest parameter.
  if (typeof element.type === "function") {
    // A class component is constructed and rendered; a function component is
    // called. PanelBoundary is the only class in the bundle.
    if (element.type.prototype && typeof element.type.prototype.render === "function") {
      const instance = new element.type(element.props ?? {});
      instance.props = element.props ?? {};
      return render(instance.render());
    }
    // The hooks below belong to this call alone: a component rendered inside it
    // is only *called* by the recursion at the end, which counts its own.
    const outer = hookCalls;
    hookCalls = 0;
    let out;
    try {
      out = element.type(element.props, ...(element.children ?? []));
    } finally {
      const count = hookCalls;
      hookCalls = outer;
      const seen = hookCounts.get(element.type);
      if (seen === undefined) hookCounts.set(element.type, count);
      else if (seen !== count) {
        const name = element.type.name || "an unnamed component";
        throw new Error(
          name + " used " + count + " hooks here but " + seen + " the first time it was rendered: " +
          "a hook that a branch can skip is a crash in React, not a slow render",
        );
      }
    }
    return render(out);
  }
  // Host elements keep their props: the assertions below read data-mode and the
  // class names off them, and dropping props would make them vacuously pass.
  return { type: element.type, props: element.props, children: (element.children ?? []).flatMap(render) };
}

/** Collect every host element whose className matches, depth-first. */
function findAll(element, match, out = []) {
  if (!element || typeof element !== "object") return out;
  if (Array.isArray(element)) {
    for (const child of element) findAll(child, match, out);
    return out;
  }
  const cls = typeof element.props?.className === "string" ? element.props.className : "";
  if (cls && match(cls)) out.push(element);
  for (const child of element.children ?? []) findAll(child, match, out);
  return out;
}

/** Flatten the text under an element, for assertions about labels. */
function textOf(element) {
  if (element === null || element === undefined || element === false || element === true) return "";
  if (typeof element === "string" || typeof element === "number") return String(element);
  if (Array.isArray(element)) return element.map(textOf).join(" ");
  return (element.children ?? []).map(textOf).join(" ");
}

/** The first host element carrying one of the given class names. */
function hasClass(name) {
  return (cls) => cls.split(" ").includes(name);
}

const registered = [];
const ctx = {
  effect: () => {},
  locale: { register: () => {}, bind: () => (key) => key },
  slots: {
    inject: (name, fn) => registered.push([name, fn()]),
    register: (meta, component) => ({ name: meta.name, component }),
  },
};
mod.apply(ctx);
console.log("slots:", registered.map(([name]) => name).join(", "));

const footer = registered.find(([name]) => name === "sidebar.footer.action")[1];
console.log("footer render ok:", Boolean(render({ type: footer.component, props: { wide: true, t: (k) => k } })));

// Open the panel and render it. Every identifier the shell body touches is read
// on this path, so a missing binding fails loudly.
mod.panelStore.set(true);
const panelTree = render({ type: footer.component, props: { wide: true, t: (k) => k } });
console.log("panel render ok:", Boolean(panelTree));

// ── surface mode ────────────────────────────────────────────────────────────
// Two modes only: 浮窗 and 独立窗口. The old "let DSH's Modal host the panel"
// axis is gone, and with it the data-hosted attribute that marked it.
const { Trow, SessionRow, ContainerRow, TreePane, ListPane, DetailPane, FilterDialog, SearchScopeDialog, CommandMenu, DialogHost, frameSizeOf, PanelBoundary, draggedSessionIds, draggedNodeIds, summaryStore } = mod.__test;

const shellNode = findAll(panelTree, hasClass("se-shell"))[0] ?? null;
if (!shellNode) throw new Error("the panel must render a .se-shell");
if ("data-hosted" in (shellNode.props ?? {})) throw new Error("data-hosted must be gone: the native presenter axis was removed");
if ("data-mode" in (shellNode.props ?? {})) throw new Error("data-mode must be gone: there is one surface, not two");
if (findAll(panelTree, hasClass("se-native-frame")).length > 0) throw new Error("no native frame may be rendered");
console.log("panel surface: single floating card");

const settings = registered.find(([name]) => name === "settings.section")[1];
console.log("settings render ok:", Boolean(render({ type: settings.component, props: {} })));

// ── components with data ────────────────────────────────────────────────────
// A render with boot.data === null only exercises the loading branch, so the
// row components are called directly with realistic props.
const session = {
  id: "session-1",
  title: "示例会话",
  displayTitle: "示例会话",
  workspaceId: "ws-1",
  workspaceTitle: "project",
  cwd: "C:\\work",
  activityAt: Date.now() - 60_000,
  createdAt: Date.now() - 3_600_000,
  sizeBytes: 2048,
  tags: ["release"],
  note: "note",
  archived: false,
  pinned: true,
  running: false,
  isSubagent: false,
  isSeeded: false,
  formatVersion: 4,
  trashed: false,
  stats: { turns: 3, steps: 5, llmMs: 1200, ttftMs: 300, toolMs: 200 },
  tokenUsage: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  contextPressure: { pressureTokens: 100, surfaceTokens: 200, contextWindow: 1000 },
};

const noop = () => {};
const rename = { value: "示例会话", onChange: noop, onCommit: noop, onCancel: noop };

console.log("Trow ok:", Boolean(render({
  type: Trow,
  props: { scope: "d-1", icon: "folder", label: "文件夹", count: 2, active: true, onSelect: noop, rename, onBeginRename: noop },
})));
console.log("Trow (no rename) ok:", Boolean(render({
  type: Trow,
  props: { scope: "f-root", icon: "folder", label: "根目录", count: 2, active: false, onSelect: noop, hasKids: true, expanded: true, onToggle: noop, onBeginRename: noop },
})));
console.log("SessionRow ok:", Boolean(render({
  type: SessionRow,
  props: { session, selected: true, now: Date.now(), onSelect: noop, checked: false, onCheck: noop, onBeginRename: noop, rename },
})));
console.log("SessionRow (trashed) ok:", Boolean(render({
  type: SessionRow,
  props: { session: { ...session, trashed: true }, selected: false, now: Date.now(), onSelect: noop, checked: false, onCheck: noop, onBeginRename: noop },
})));

// The status badge is DSH's ladder, not a private one (ui-workspace
// rows/Rows.tsx:344 `sessionStatuses`): a pending interaction outranks live
// activity, live activity outranks the unread-completion reminder, and 空闲 is
// what is left. Two states used to be invented here and are gone — 已中断 came
// from the log tail ending inside a turn, 异常 from `formatVersion !== 4` — so
// the sweep at the end of this block fails if either comes back.
const { statusOf, withDshStatus, pendingKindOf } = mod.__test;
const statusRows = withDshStatus(
  [
    { ...session, id: "s-idle" },
    { ...session, id: "s-live", running: true },
    { ...session, id: "s-approval", running: true },
    { ...session, id: "s-plan" },
    { ...session, id: "s-ask" },
    { ...session, id: "s-done" },
    { ...session, id: "s-parent" },
    { ...session, id: "s-kid-1", isSubagent: true, parentSession: "s-parent", running: true },
    { ...session, id: "s-kid-2", isSubagent: true, parentSession: "s-parent", running: true },
  ],
  new Map([
    // Pending outranks running: DSH asks the user to act before reporting
    // activity, and the same session is often both.
    ["s-approval", { running: true, pendingInteraction: { kind: "approval" }, completionUnread: false }],
    ["s-plan", { running: false, pendingInteraction: "plan-review", completionUnread: false }],
    // A question outranks the unread reminder, not the other way round.
    ["s-ask", { running: false, pendingInteraction: { kind: "question" }, completionUnread: true }],
    ["s-done", { running: false, pendingInteraction: null, completionUnread: true }],
    // A kind DSH does not name is not a label: the row keeps its ordinary state.
    ["s-idle", { running: false, pendingInteraction: { kind: "approval-v2" }, completionUnread: false }],
  ]),
);
const statusById = new Map(statusRows.map((row) => [row.id, statusOf(row)]));
const expectStatus = (id, text, cls) => {
  const got = statusById.get(id);
  if (!got) throw new Error(`no row ${id}`);
  if (got.text !== text) throw new Error(`${id}: expected "${text}", got "${got.text}"`);
  if (got.cls !== cls) throw new Error(`${id}: expected dot "${cls}", got "${got.cls}"`);
};
expectStatus("s-idle", "空闲", "");
expectStatus("s-live", "进行中", "run");
expectStatus("s-approval", "等待审批", "warn");
expectStatus("s-plan", "计划待审", "warn");
expectStatus("s-ask", "等待回答", "warn");
expectStatus("s-done", "已完成", "done");
// Two running children, both rows the panel already holds: the count is folded
// from `isSubagent` + `parentSession`, exactly as DSH counts its projection.
expectStatus("s-parent", "2 个子智能体运行中", "run");
expectStatus("s-kid-1", "进行中", "run");
// 回收站 stays: it is not a claim about liveness, it is this plugin's own bin,
// and those payloads are absent from DSH's list entirely.
if (statusOf({ ...session, trashed: true }).text !== "已删除") throw new Error("a trashed row must say 已删除, not a liveness state");
// The panel reports no state DSH does not report.
for (const row of [...statusRows, { ...session, trashed: true }]) {
  const { text } = statusOf(row);
  if (text.includes("已中断") || text.includes("异常")) throw new Error(`invented status: "${text}"`);
  if (text === "运行中") throw new Error("DSH calls the running state 进行中");
}
// The kind parser is a whitelist, so an unknown shape is never a label.
if (pendingKindOf({ kind: "approval" }) !== "approval" || pendingKindOf("question") !== "question") throw new Error("pendingKindOf must read both the string and the object shape");
if (pendingKindOf({ kind: "approval-v2" }) !== null || pendingKindOf(null) !== null || pendingKindOf(undefined) !== null) throw new Error("pendingKindOf must refuse kinds DSH does not name");
// And the label reaches the row's own DOM, not only the helper's return value.
const approvalRow = render({
  type: SessionRow,
  props: {
    session: statusRows.find((row) => row.id === "s-approval"),
    selected: false,
    now: Date.now(),
    onSelect: noop,
    checked: false,
    onCheck: noop,
    onBeginRename: noop,
  },
});
if (!textOf(approvalRow).includes("等待审批")) throw new Error("the row must draw the pending label");
if (findAll(approvalRow, hasClass("dot")).some((node) => String(node.props?.className).includes("int"))) throw new Error("the invented 已中断 dot class is gone");
// 运行 is blue, 完成 is green — the two colours swapped on purpose, because a
// running row is the one the user is waiting on, not the one that is finished.
const dotRule = (name) => {
  const hit = new RegExp("\\.se-shell \\.dot\\." + name + "\\{background:(#[0-9a-f]{6})").exec(source);
  return hit ? hit[1] : null;
};
if (dotRule("run") !== "#5b8def") throw new Error(`a running row must be blue, got ${dotRule("run")}`);
if (dotRule("done") !== "#3ecf8e") throw new Error(`a completed row must be green, got ${dotRule("done")}`);
if (dotRule("warn") !== "#e0a44a") throw new Error(`a waiting row must stay amber, got ${dotRule("warn")}`);
console.log("SessionRow status ladder ok: 空闲 / 进行中 / 等待审批 / 计划待审 / 等待回答 / 已完成 / 子智能体运行中");

// ── 子智能体 rows (P32) ─────────────────────────────────────────────────────
// A child row is not a session the user can act on: it has no checkbox, no
// rename pencil and no drag handle, and it says so with a bound glyph and a 子
// tag. The parent row, in turn, carries the count and the twist that opens it.
const childRow = render({
  type: SessionRow,
  props: {
    session: { ...session, id: "child-1", isSubagent: true, parentSession: "session-1", delegationDepth: 1 },
    selected: false,
    now: Date.now(),
    onSelect: noop,
    checked: false,
    onCheck: noop,
    depth: 1,
    onBeginRename: noop,
  },
});
const childClasses = findAll(childRow, hasClass("bound-row"));
if (childClasses.length !== 1) throw new Error("a subagent row must carry .bound-row");
if (findAll(childRow, hasClass("chk")).length !== 0) throw new Error("a subagent row must not render a checkbox");
if (findAll(childRow, hasClass("chk-bound")).length !== 1) throw new Error("a subagent row must show the bound glyph instead");
if (findAll(childRow, hasClass("nm-editbtn")).length !== 0) throw new Error("a subagent row must not offer a rename pencil");
if (childRow.props.draggable !== false) throw new Error("a subagent row must not be draggable");
if (!textOf(childRow).includes("子")) throw new Error("a subagent row must carry the 子 tag");

const parentRow = render({
  type: SessionRow,
  props: {
    session,
    selected: false,
    now: Date.now(),
    onSelect: noop,
    checked: false,
    onCheck: noop,
    childCount: 2,
    collapsed: true,
    onToggleChildren: noop,
    onBeginRename: noop,
  },
});
if (findAll(parentRow, hasClass("twist")).length !== 1) throw new Error("a parent of subagents must render the twist");
if (!textOf(parentRow).includes("2 子")) throw new Error("a parent must show how many subagents it holds");
console.log("SessionRow (subagent binding) ok: bound glyph, 子 tag, parent count");

const workspaceNode = { id: "w-ws-1", workspaceId: "ws-1", name: "project", path: "C:\\work", type: "workspace", kind: "workspace" };
const folderNode = { id: "d-1", type: "folder", name: "文件夹", fixed: false, kind: "folder", parent: "f-root", order: 3 };
const specialNode = { id: "f-favorites", type: "folder", name: "收藏", fixed: true, kind: "favorites", parent: "f-root", order: 3 };

console.log("ContainerRow (workspace) ok:", Boolean(render({
  type: ContainerRow,
  props: { node: workspaceNode, count: 1, selected: false, onOpen: noop, checked: false, onCheck: noop, onSelect: noop, onBeginRename: noop, rename },
})));
console.log("ContainerRow (folder) ok:", Boolean(render({
  type: ContainerRow,
  props: { node: folderNode, count: 0, selected: false, onOpen: noop, checked: false, onCheck: noop, onSelect: noop, onBeginRename: noop, rename },
})));

// A 特殊文件夹 may not be renamed, may not be deleted, and must not even offer a
// checkbox: it is a view over the session set, not the user's object.
const specialRow = render({ type: ContainerRow, props: { node: specialNode, count: 3, selected: false, onOpen: noop, checked: false, onCheck: noop, onSelect: noop, onBeginRename: noop } });
if (findAll(specialRow, hasClass("chk")).length !== 0) throw new Error("a 特殊文件夹 must not render a checkbox");
if (findAll(specialRow, hasClass("nm-editbtn")).length !== 0) throw new Error("a 特殊文件夹 must not render a rename pencil");
if (!textOf(specialRow).includes("特殊文件夹")) throw new Error("a 特殊文件夹 must be labelled as such");
console.log("ContainerRow (special) ok:", Boolean(specialRow));

const tree = {
  nodes: {
    "f-root": { id: "f-root", type: "folder", name: "根目录", fixed: true, kind: "root", parent: null, order: 0 },
    "f-all": { id: "f-all", type: "folder", name: "所有会话", fixed: true, kind: "all", parent: "f-root", order: 1 },
    "f-trash": { id: "f-trash", type: "folder", name: "回收站", fixed: true, kind: "trash", parent: null, order: 1 },
    "f-ungrouped": { id: "f-ungrouped", type: "folder", name: "未分组", fixed: true, kind: "ungrouped", parent: "f-root", order: 1 },
    "f-todos": { id: "f-todos", type: "folder", name: "待办", fixed: true, kind: "todos", parent: "f-root", order: 2 },
    "f-favorites": { id: "f-favorites", type: "folder", name: "收藏", fixed: true, kind: "favorites", parent: "f-root", order: 3 },
    "w-ws-1": { id: "w-ws-1", type: "workspace", name: "project", workspaceId: "ws-1", kind: "workspace", parent: "f-root", order: 2 },
    "d-1": { id: "d-1", type: "folder", name: "文件夹", fixed: false, kind: "folder", parent: "f-root", order: 3 },
  },
  children: {
    "f-root": ["f-all", "w-ws-1", "d-1", "f-ungrouped", "f-todos", "f-favorites"],
    "f-trash": [], "f-all": [], "f-ungrouped": [], "f-todos": [], "f-favorites": [], "w-ws-1": [], "d-1": [],
  },
  counts: { "f-root": 1, "f-all": 1, "f-trash": 0, "f-ungrouped": 0, "f-todos": 0, "f-favorites": 0, "w-ws-1": 1, "d-1": 0 },
  roots: ["f-root", "f-trash"],
};
// The client holds no rule table: it reads the facts the host ships on every
// node (`accepts`, `hasWorkspace`, `scope`, `ref`). Decorating the fixture with
// the real host function is what keeps this harness honest — a fixture written
// by hand would drift from /bootstrap and prove nothing.
decorateTree(tree);
console.log("TreePane ok:", Boolean(render({
  type: TreePane,
  props: { tree, scope: "f-root", onSelect: noop, expanded: new Set(["f-root"]), onToggle: noop, width: 260, onMove: noop, rename, onBeginRename: noop },
})));

const listPaneWith = (props) => render({ type: ListPane, props: {
  sessions: [session], tree, scope: "f-root", selected: null, onSelect: noop, onCheck: noop,
  checked: new Set(), query: "", onQuery: noop, sortKey: "updated", sortDir: "desc", onSort: noop, showArchived: true, now: Date.now(),
  view: "details", onOpenWorkspace: noop, colWidths: { name: 260, tags: 116, note: 150, updated: 104, size: 74, status: 78 },
  onResizeColumn: noop, listRef: null, collapsed: new Set(), onToggleChildren: noop,
  rename: null, onBeginRename: noop, ...props,
} });
console.log("ListPane ok:", Boolean(listPaneWith({ selected: session.id })));

// ── a list that actually holds a subagent ───────────────────────────────────
// The P32 regression: `nestSessions` was rewritten to call a predicate while
// the list kept passing its Set, so *any* list containing a delegation threw
// "collapsed.has is not a function" — 所有会话 failed to render on real data.
// A list without children never reaches the call, which is why the fixture
// above stayed green. These two renders pin both states.
const parentSession = { ...session, id: "parent-1" };
const childSession = { ...session, id: "child-1", isSubagent: true, parentSession: "parent-1", delegationDepth: 1 };
const rowsWithIds = (element) =>
  findAll(element, (cls) => cls.split(" ").includes("row")).filter((row) =>
    ["parent-1", "child-1"].includes(row.props?.["data-id"]),
  );

const foldedList = listPaneWith({ sessions: [parentSession, childSession], collapsed: new Set(["parent-1"]) });
const foldedRows = rowsWithIds(foldedList);
if (foldedRows.length !== 1) throw new Error("a folded parent must be the only row, got " + foldedRows.length);
if (foldedRows[0].props["data-id"] !== "parent-1") throw new Error("the folded list must keep the parent row");

const openList = listPaneWith({ sessions: [parentSession, childSession], collapsed: new Set() });
const openRows = rowsWithIds(openList);
if (openRows.length !== 2) throw new Error("an open parent must list its child, got " + openRows.length);
const childRowInList = openRows.find((row) => row.props["data-id"] === "child-1");
if (!childRowInList) throw new Error("the child row must be listed under its parent");
if (!String(childRowInList.props.className).includes("sub-row")) throw new Error("the child row must be indented as a sub-row");
if (!String(childRowInList.props.className).includes("bound-row")) throw new Error("the child row must carry .bound-row");
console.log("ListPane (subagent rows) ok: folded 1 row, open 2 rows");

// ── the box that selects rows by dragging ───────────────────────────────────
// 框选 (m01168) paints into an element it finds through a ref, so the element
// has to be in the tree: without it the drag had nothing to resize.
const plainPane = listPaneWith({});
if (findAll(plainPane, hasClass("selrect")).length !== 1) throw new Error("the list must hold one .selrect");
const plainBody = findAll(plainPane, hasClass("listbody"))[0];
if (plainBody.props.onMouseDown) throw new Error("a list without onMarquee must not start a box");

const calls = [];
const dragPane = listPaneWith({ onMarquee: (...args) => calls.push(args) });
const dragBody = findAll(dragPane, hasClass("listbody"))[0];
if (typeof dragBody.props.onMouseDown !== "function") throw new Error("the list body must start a box");
const blankEvent = { target: { closest: () => null }, clientX: 12, clientY: 40, button: 0 };
dragBody.props.onMouseDown(blankEvent);
if (calls.length !== 1) throw new Error("a press on the blank body must hand over one drag, got " + calls.length);
const [event, pane, rect] = calls[0];
if (event !== blankEvent) throw new Error("the drag must receive the press it started from");
if (pane !== null && typeof pane !== "object") throw new Error("the drag must receive the pane element or null");
if (rect !== null && rect !== undefined && typeof rect !== "object") throw new Error("the drag must receive the box element or null");
console.log("ListPane (marquee) ok: .selrect present, blank press starts a box");

// ── containers in the list ──────────────────────────────────────────────────
// Three things are pinned here, all of which were invisible in the UI:
//   1. a user folder under the current scope must be *listed*, not only drawn
//      in the tree (新建文件夹 created something the user could not see);
//   2. workspaces and folders are *separate groups* — mixing them made a folder
//      look like a workspace with the wrong icon;
//   3. typing a folder's name in the search box must find it, from any depth.
const rootList = listPaneWith({});
const folderRows = findAll(rootList, hasClass("folderrow"));
if (folderRows.length !== 1) throw new Error("the folder under the root must be listed once, got " + folderRows.length);
if (!textOf(folderRows[0]).includes("文件夹")) throw new Error("a folder row must be labelled 文件夹");
const wsRows = findAll(rootList, hasClass("wsrow"));
if (wsRows.length !== 1) throw new Error("the workspace must still be listed, got " + wsRows.length);
if (textOf(wsRows[0]).includes("文件夹")) throw new Error("a workspace row must not be labelled 文件夹");
const specialRows = findAll(rootList, hasClass("specialrow"));
// 所有会话 / 未分组 / 收藏 / 待办 — and deliberately NOT 根目录: you are already in
// it. 所有会话 belongs here because 根目录 itself lists no session rows.
if (specialRows.length !== 4) throw new Error("根目录 must list the four 特殊文件夹, got " + specialRows.length);
if (findAll(rootList, hasClass("specialrow")).some((row) => textOf(row).includes("根目录"))) {
  throw new Error("根目录 must not list itself");
}

// The group captions are the user-visible answer to "分开".
const captions = findAll(rootList, hasClass("grp")).map((group) => textOf(group));
if (!captions.some((text) => text.includes("特殊文件夹"))) throw new Error("the special folders need their own group, got " + JSON.stringify(captions));
// Folders before workspaces: the user's own containers come first.
// A caption carries its count ("文件夹 1"), so match on the word and exclude
// the 特殊文件夹 band, which also contains it.
const folderAt = captions.findIndex((text) => text.includes("文件夹") && !text.includes("特殊"));
const workspaceAt = captions.findIndex((text) => text.includes("工作区"));
if (folderAt < 0) throw new Error("folders need their own group, got " + JSON.stringify(captions));
if (workspaceAt < 0) throw new Error("workspaces need their own group, got " + JSON.stringify(captions));
if (folderAt > workspaceAt) throw new Error("文件夹 must come before 工作区, got " + JSON.stringify(captions));
console.log("list containers ok:", folderRows.length, "folder,", wsRows.length, "workspace,", specialRows.length, "special");
console.log("groups:", captions.join(" | "));

// ── 所有会话 按工作区切分 ────────────────────────────────────────────────────
// 所有会话 is the whole library at once, and it used to be one flat 会话 band: every
// row repeated its workspace in the subtitle, and the pane never answered "where
// does this live" as a list. It is cut by workspace now, and the caption *is* the
// workspace name — the same string the tree draws for the same node.
const bandTree = {
  nodes: {
    "f-root": { id: "f-root", type: "folder", name: "根目录", fixed: true, kind: "root", parent: null, order: 0 },
    "f-all": { id: "f-all", type: "folder", name: "所有会话", fixed: true, kind: "all", parent: "f-root", order: 0 },
    "w-a": { id: "w-a", type: "workspace", name: "Alpha", workspaceId: "ws-a", kind: "workspace", parent: "f-root", order: 1 },
    "w-b": { id: "w-b", type: "workspace", name: "Beta", workspaceId: "ws-b", kind: "workspace", parent: "f-root", order: 2 },
  },
  children: { "f-root": ["f-all", "w-a", "w-b"], "f-all": [], "w-a": [], "w-b": [] },
  counts: { "f-root": 0, "f-all": 0, "w-a": 1, "w-b": 1 },
  roots: ["f-root"],
};
decorateTree(bandTree);
const bandSessions = [
  { ...session, id: "s-beta", pinned: false, workspaceId: "ws-b", workspaceTitle: "Beta", activityAt: 3 },
  { ...session, id: "s-alpha", pinned: false, workspaceId: "ws-a", workspaceTitle: "Alpha", activityAt: 2 },
  { ...session, id: "s-none", pinned: false, workspaceId: null, workspaceTitle: null, activityAt: 1 },
];
const allPane = listPaneWith({ sessions: bandSessions, tree: bandTree, scope: "f-all" });
const bandCaptions = findAll(allPane, hasClass("grp")).map((group) => textOf(group));
if (bandCaptions.length !== 3) throw new Error("所有会话 must draw one band per workspace, got " + JSON.stringify(bandCaptions));
// Tree order, not alphabetical order: Alpha and Beta are the 目录 order.
if (!bandCaptions[0].includes("Alpha")) throw new Error("the first band must be the first workspace, got " + JSON.stringify(bandCaptions));
if (!bandCaptions[1].includes("Beta")) throw new Error("the second band must be the second workspace, got " + JSON.stringify(bandCaptions));
if (!bandCaptions[2].includes("未分组")) throw new Error("a session with no workspace belongs to 未分组, got " + JSON.stringify(bandCaptions));
if (!bandCaptions[0].includes("1")) throw new Error("a band carries its own count, got " + JSON.stringify(bandCaptions));
// Every session row still exists exactly once, and under the right caption.
const bandRowIds = findAll(allPane, (cls) => cls.split(" ").includes("row"))
  .map((row) => row.props?.["data-id"])
  .filter((id) => ["s-alpha", "s-beta", "s-none"].includes(id));
if (bandRowIds.length !== 3) throw new Error("every session must be listed once, got " + JSON.stringify(bandRowIds));
// Standing inside a workspace — or answering a search — keeps one 会话 band: there
// the list is already about a place, and a caption per workspace would repeat one
// word down the pane.
const insidePane = listPaneWith({ sessions: bandSessions, tree: bandTree, scope: "w-a" });
const insideCaptions = findAll(insidePane, hasClass("grp")).map((group) => textOf(group));
if (!insideCaptions.some((text) => text.includes("会话")) || insideCaptions.some((text) => text.includes("Alpha"))) {
  throw new Error("a container scope must keep one 会话 band, got " + JSON.stringify(insideCaptions));
}
const searchPane = listPaneWith({ sessions: bandSessions, tree: bandTree, scope: "f-all", query: "示例" });
const searchCaptions = findAll(searchPane, hasClass("grp")).map((group) => textOf(group));
if (searchCaptions.some((text) => text.includes("Alpha"))) {
  throw new Error("a search result is not a place: it must stay one band, got " + JSON.stringify(searchCaptions));
}
console.log("所有会话 bands ok:", bandCaptions.join(" | "));

// ── 分组折叠 (m01948) ───────────────────────────────────────────────────────
// 所有会话 is one band per workspace now, which is only useful if a band can be
// put away: the caption row doubles as the button. Two things are pinned here —
// a folded band builds no rows (a "folded" band that still renders every row is
// not folded), and the fold is scoped, because 会话 exists in every folder and
// folding one folder's copy must not fold another's.
const foldKey = (scope, key) => scope + "\u0000" + key;
const rowsOfPane = (pane) =>
  findAll(pane, (cls) => cls.split(" ").includes("row"))
    .map((row) => row.props?.["data-id"])
    .filter((id) => ["s-alpha", "s-beta", "s-none"].includes(id));
const foldedPane = listPaneWith({
  sessions: bandSessions,
  tree: bandTree,
  scope: "f-all",
  foldedBands: new Set([foldKey("f-all", "ws:ws-a")]),
});
const alphaCaption = findAll(foldedPane, hasClass("grp")).find((node) => textOf(node).includes("Alpha"));
if (!alphaCaption) throw new Error("a folded band must keep its caption");
if (alphaCaption.props["aria-expanded"] !== "false") throw new Error("a folded caption must say it is folded");
const foldedRowIds = rowsOfPane(foldedPane);
if (foldedRowIds.includes("s-alpha")) throw new Error("a folded band must build no rows, got " + JSON.stringify(foldedRowIds));
if (!foldedRowIds.includes("s-beta") || !foldedRowIds.includes("s-none")) {
  throw new Error("the other bands must stay open, got " + JSON.stringify(foldedRowIds));
}
// The same 会话 band in two folders: folding it in 所有会话 leaves 根目录 open.
const otherScope = listPaneWith({ sessions: bandSessions, tree: bandTree, scope: "w-a", foldedBands: new Set([foldKey("f-all", "normal")]) });
if (!rowsOfPane(otherScope).includes("s-alpha")) {
  throw new Error("a fold in 所有会话 must not fold 会话 in another folder, got " + JSON.stringify(rowsOfPane(otherScope)));
}
const ownScope = listPaneWith({ sessions: bandSessions, tree: bandTree, scope: "w-a", foldedBands: new Set([foldKey("w-a", "normal")]) });
if (rowsOfPane(ownScope).length !== 0) {
  throw new Error("folding 会话 inside a folder must hide its rows, got " + JSON.stringify(rowsOfPane(ownScope)));
}
// A press on a caption asks the panel to fold *that* band, scope included.
const asked = [];
const clickPane = listPaneWith({ sessions: bandSessions, tree: bandTree, scope: "f-all", onToggleBand: (key) => asked.push(key) });
findAll(clickPane, hasClass("grp")).find((node) => textOf(node).includes("Beta")).props.onClick();
if (asked[0] !== foldKey("f-all", "ws:ws-b")) throw new Error("a caption must fold its own band, got " + JSON.stringify(asked));
console.log("分组折叠 ok:", "Alpha folded |", "Beta open |", "会话 scoped");

// ── 拖动要先选中 (m01385) ───────────────────────────────────────────────────
// Every row in the list used to be draggable, so pressing one and moving started
// a native drag and 框选 never saw the press. The gate is the pick: the row the
// user last clicked, or a ticked one, drags; every other row is surface for the
// box. The predicate the box asks has to be the same one, or the browser starts
// a drag the box cannot see.
const rowById = (pane, id) =>
  findAll(pane, (cls) => cls.split(" ").includes("row")).find((row) => row.props?.["data-id"] === id);
const unpickedRow = rowById(listPaneWith({}), session.id);
if (!unpickedRow) throw new Error("the list must draw the session row");
if (unpickedRow.props.draggable !== false) throw new Error("an unpicked session row must not drag");
const pickedRow = rowById(listPaneWith({ selected: session.id }), session.id);
if (pickedRow.props.draggable !== true) throw new Error("the picked session row must still drag");
const tickedRow = rowById(listPaneWith({ checked: new Set([session.id]) }), session.id);
if (tickedRow.props.draggable !== true) throw new Error("a ticked session row must still drag");
// A container row follows the same rule, so a folder or a workspace is picked
// before it can be moved by hand — otherwise pressing it would move it while
// the user was dragging a box across the list.
if (folderRows[0].props.draggable !== false) throw new Error("an unpicked folder row must not drag");
if (wsRows[0].props.draggable !== false) throw new Error("an unpicked workspace row must not drag");
console.log("ListPane (drag gate) ok: unpicked rows are surface, picked and ticked rows drag");

// ── a drag carries the whole check-set (m01540) ────────────────────────────
// The row under the pointer used to be the only thing that moved, so ticking
// four sessions and dragging one moved one. The pane splits the check-set into
// the sessions a workspace can take and the containers that move as nodes, and
// hands that split to whichever row starts the gesture.
const twin = { ...session, id: "twin-2" };
const dragEvent = (transfer = true) => {
  const store = new Map();
  return {
    dataTransfer: transfer
      ? {
          effectAllowed: "",
          setData: (type, value) => store.set(type, String(value)),
          getData: (type) => store.get(type) ?? "",
        }
      : null,
    preventDefault: noop,
  };
};
/** Start a drag on one row and hand back the event it received. */
const dragFrom = (found, label) => {
  if (!found) throw new Error("no row to start a drag on: " + label);
  const event = dragEvent();
  found.props.onDragStart(event);
  return event;
};
const pairList = listPaneWith({ sessions: [session, twin], checked: new Set([session.id, "twin-2"]) });
const pairEvent = dragFrom(rowById(pairList, session.id), session.id);
if (draggedSessionIds(pairEvent).length !== 2) {
  throw new Error("a ticked row must hand the whole check-set to the drop target, got " + draggedSessionIds(pairEvent).length);
}
if (draggedNodeIds().length !== 0) throw new Error("a session drag must carry no container");
// One tick is already a payload: a second one is not what enables the drag.
const soloEvent = dragFrom(rowById(listPaneWith({ checked: new Set([session.id]) }), session.id), session.id);
if (draggedSessionIds(soloEvent).length !== 1) throw new Error("a single tick must ride alone");
// A check-set can mix kinds — the folder rides as a node while the session
// rides as a session — because each drop target acts on the half it accepts.
const mixedList = listPaneWith({ sessions: [session, twin], checked: new Set([session.id, "d-1"]) });
const mixedEvent = dragFrom(rowById(mixedList, session.id), session.id);
if (draggedNodeIds().length !== 1 || draggedNodeIds()[0] !== "d-1") {
  throw new Error("a ticked folder must still ride a session drag, got " + JSON.stringify(draggedNodeIds()));
}
if (draggedSessionIds(mixedEvent).length !== 1) throw new Error("and the session half must not be swallowed by it");
// A container row under the pointer carries the set too, so a ticked session is
// not dropped when the user happens to press the folder instead.
const folderList = listPaneWith({ checked: new Set(["d-1"]) });
const folderEvent = dragFrom(findAll(folderList, hasClass("folderrow"))[0], "d-1");
if (draggedNodeIds().length !== 1 || draggedNodeIds()[0] !== "d-1") throw new Error("a folder row must drag itself");
if (draggedSessionIds(folderEvent).length !== 0) throw new Error("and it must not invent a session half");
// A browser may refuse reads during dragstart (Firefox answers "" for every
// type it did not set itself), so the module payload — not the DataTransfer —
// is the source of truth, and a drop handler that asks later gets the same set.
const bareRow = rowById(listPaneWith({ sessions: [session, twin], checked: new Set([session.id, "twin-2"]) }), session.id);
const bareEvent = { dataTransfer: { setData: noop, getData: () => "", effectAllowed: "" }, preventDefault: noop };
bareRow.props.onDragStart(bareEvent);
if (draggedSessionIds(bareEvent).length !== 2) throw new Error("a refused DataTransfer must not lose the set");
if (draggedSessionIds({}).length !== 2) throw new Error("a target that hands over no event still reads the payload");

console.log("ListPane (drag set) ok: the check-set rides the drag, split by kind");

// ── the pencil on a container row ──────────────────────────────────────────
// "文件夹、工作区点了重命名按钮却不出现输入框，会话的重命名是好的" — the row
// half of that report. Two halves have to agree, and the harness checks both,
// because a gate that refuses the editor is invisible until someone clicks:
//   1. the pencil hands the *row's* kind and id to the panel (a workspace is
//      addressed by its native id, a folder by its tree id);
//   2. when the panel hands a matching rename back, the row draws the input.
const clickPencil = (pane, rowClass, label) => {
  const row = findAll(pane, hasClass(rowClass))[0];
  if (!row) throw new Error(`no ${rowClass} row to click (${label})`);
  const pencil = findAll(row, hasClass("nm-editbtn"))[0];
  if (!pencil) throw new Error(`the ${rowClass} row has no rename pencil (${label})`);
  const event = { stopPropagation() {}, preventDefault() {}, key: "" };
  pencil.props.onClick(event);
};
const begun = [];
const renameSpy = listPaneWith({ onBeginRename: (kind, id) => begun.push([kind, id]) });
clickPencil(renameSpy, "folderrow", "folder");
clickPencil(renameSpy, "wsrow", "workspace");
if (begun.length !== 2) throw new Error("both pencils must report a rename, got " + JSON.stringify(begun));
if (begun[0][0] !== "folder" || begun[0][1] !== "d-1") {
  throw new Error("the folder pencil must ask for its own node id, got " + JSON.stringify(begun[0]));
}
if (begun[1][0] !== "workspace" || begun[1][1] !== "ws-1") {
  throw new Error("the workspace pencil must ask for the native workspace id, got " + JSON.stringify(begun[1]));
}
const renamingProps = (kind, id) => ({ kind, id, value: "x", onChange: noop, onCommit: noop, onCancel: noop });
for (const [cls, kind, id] of [["folderrow", "folder", "d-1"], ["wsrow", "workspace", "ws-1"]]) {
  const pane = listPaneWith({ rename: renamingProps(kind, id) });
  const row = findAll(pane, hasClass(cls))[0];
  if (findAll(row, hasClass("nm-edit")).length !== 1) {
    throw new Error(`a ${kind} row with a matching rename must draw the editor`);
  }
}
// An editor the row cannot address must not be drawn at all — that half-open
// state is what made the click look like a no-op.
const stale = findAll(findAll(listPaneWith({ rename: renamingProps("folder", "d-someone-else") }), hasClass("folderrow"))[0], hasClass("nm-edit"));
if (stale.length !== 0) throw new Error("a rename for another row must not paint an editor here");
console.log("container rename ok:", begun.map(([kind, id]) => `${kind}:${id}`).join(", "));

// Search: the folder lives at f-root, so a query from the same scope finds it.
const searched = listPaneWith({ query: "文件" });
if (findAll(searched, hasClass("folderrow")).length !== 1) {
  throw new Error("searching a folder name must find the folder");
}
// … and a query that matches nothing lists nothing.
const noHit = listPaneWith({ query: "zzz-no-such-thing" });
if (findAll(noHit, hasClass("folderrow")).length !== 0) {
  throw new Error("a non-matching query must not list the folder");
}
// The bin shows trashed sessions only: no containers to navigate out of.
const trashList = listPaneWith({ scope: "f-trash" });
if (findAll(trashList, hasClass("frow")).length !== 0) {
  throw new Error("the bin must not list containers");
}

// ── a session shortcut: membership, not a second row ───────────────────────
// 收藏 / 待办 are shortcut containers. A session shortcut is *the* way a
// session appears on those pages: one row, the session's own, and no extra
// pointer row beside it. Deleting that row takes the shortcut away and leaves
// the session file alone (that is the 移出 wording, asserted on the panel side).
const refTree = {
  ...tree,
  nodes: {
    ...tree.nodes,
    "s-1": {
      // The host ships `shortcutKind` (see domain/tree.js) and no label of its
      // own: the row's name is the target's, resolved at render time.
      id: "s-1", type: "shortcut", kind: "shortcut", name: "", fixed: false,
      parent: "f-favorites", order: 0, shortcutKind: "session", targetId: session.id,
    },
  },
  children: { ...tree.children, "f-favorites": ["s-1"] },
  counts: { ...tree.counts, "f-favorites": 1 },
};
decorateTree(refTree);
const refList = listPaneWith({
  tree: refTree,
  scope: "f-favorites",
  sessionsById: new Map([[session.id, { ...session, favorite: true }]]),
});
// The shortcut node must not be painted as a row of its own: the session row is
// the membership, and a second 快捷方式 row would say the same thing twice.
const shortcutRows = findAll(refList, hasClass("scrow"));
if (shortcutRows.length !== 0) {
  throw new Error("a session shortcut must not draw a row beside its session, got " + shortcutRows.length);
}
const refRows = findAll(refList, hasClass("row")).filter((node) => node.props?.["data-id"] === session.id);
if (refRows.length !== 1) {
  throw new Error("收藏 must list the favorited session exactly once, got " + refRows.length);
}
const refRow = refRows[0];
if (!textOf(refRow).includes(session.displayTitle)) {
  throw new Error("a favorited row must show the session's own title, got " + JSON.stringify(textOf(refRow)));
}
if (textOf(refRow).includes("失效")) throw new Error("a resolvable shortcut must not be called 失效的快捷方式");
// The glyph is the session's own: a favorited session is still a chat.
if (mod.__test.iconOfNode?.(refTree.nodes["s-1"], refTree) !== "chat") {
  throw new Error("a session shortcut must borrow the session icon, got " + mod.__test.iconOfNode?.(refTree.nodes["s-1"], refTree));
}
if (mod.__test.nodeLabel?.(refTree.nodes["s-1"], refTree, () => session) !== session.displayTitle) {
  throw new Error("a live shortcut must resolve to its target's title");
}
// The six fixed entries are a rail of buttons, not a branch: even with 收藏
// marked expanded the tree must not grow a subtree under it. The page (the list
// above) is how its contents are reached, never a chevron in the sidebar.
const refTreePane = render({
  type: TreePane,
  props: {
    tree: refTree, scope: "f-root", onSelect: noop, expanded: new Set(["f-root", "f-favorites"]),
    onToggle: noop, width: 260, onMove: noop, rename: null, onBeginRename: noop,
    sessionsById: new Map([[session.id, session]]),
  },
});
const railRow = findAll(refTreePane, hasClass("trow")).find((node) => textOf(node).includes("收藏")) ?? null;
if (!railRow) throw new Error("the rail must still draw 收藏");
const railCaret = findAll(railRow, hasClass("caret"))[0] ?? null;
if (!railCaret) throw new Error("every tree row keeps a caret slot");
if (!hasClass("hidden")(railCaret.props.className)) {
  throw new Error("a rail entry is a button: it must not offer a chevron");
}
if (findAll(refTreePane, hasClass("sc")).length !== 0) {
  throw new Error("a rail entry must not expand its contents into the tree");
}
console.log("reference row ok: one row per favorited session; the rail entry stays a button");

// ── 快速访问 is a strip of buttons; 置顶 is a ranking inside 目录 ────────────
// The two used to be one map: pinning a container hoisted it into the 快速访问
// band and out of 目录, so the feature read as "the folder moved". They are
// separate lists now (m03020), and this block pins both halves:
//   1. a bookmark draws a row above 目录, with a caret slot but no chevron and
//      no subtree — a button, not a branch;
//   2. a pin leaves the hierarchy alone and only sorts the row first among the
//      siblings it already has, still inside 目录.
const quickTree = {
  ...tree,
  quickAccessNodes: ["w-ws-1"],
  quickAccess: { "w-ws-1": 1 },
  pins: { "d-1": 5 },
};
const quickPane = render({
  type: TreePane,
  props: {
    tree: quickTree, scope: "f-root", onSelect: noop, expanded: new Set(["f-root"]),
    onToggle: noop, width: 260, onMove: noop, rename: null, onBeginRename: noop,
    pins: quickTree.pins, quickAccess: quickTree.quickAccessNodes, onNodeContextMenu: noop,
  },
});
// findAll's predicate receives a className string, not a node, so the node-level
// helpers below read the class off the node once and reuse the same test.
const flat = findAll(quickPane, () => true);
const clsOf = (node) => node.props?.className ?? "";
const scopeOf = (node) => node.props?.["data-scope"] ?? null;
const isCap = (node, text) => hasClass("tcap")(clsOf(node)) && textOf(node).includes(text);
const capQuick = flat.findIndex((node) => isCap(node, "快速访问"));
const capDir = flat.findIndex((node) => isCap(node, "目录"));
if (capQuick < 0) throw new Error("a bookmark must give the tree its 快速访问 caption");
if (!(capQuick < capDir)) throw new Error("快速访问 belongs above 目录");
const isRow = (node, scope) => hasClass("trow")(clsOf(node)) && scopeOf(node) === scope;
const quickRowIdx = flat.findIndex((node, index) => index < capDir && isRow(node, "w-ws-1"));
if (quickRowIdx < 0) throw new Error("the bookmarked workspace must draw a row in 快速访问");
const quickRow = flat[quickRowIdx];
const quickCaret = findAll(quickRow, hasClass("caret"))[0] ?? null;
if (!quickCaret || !hasClass("hidden")(quickCaret.props.className)) {
  throw new Error("a bookmark is a button: it must not offer a chevron");
}
if (findAll(quickRow, hasClass("sc")).length !== 0) {
  throw new Error("a bookmark must not expand into the tree");
}
// The pinned folder is the last child in the fixture and still leads the band.
const dirRowIdx = (scope) => flat.findIndex((node, index) => index > capDir && isRow(node, scope));
const pinnedIdx = dirRowIdx("d-1");
const wsIdx = dirRowIdx("w-ws-1");
if (pinnedIdx < 0 || wsIdx < 0) throw new Error("both containers must stay listed in 目录");
if (!(pinnedIdx < wsIdx)) throw new Error("a pinned row must sort first among its siblings, not leave the band");
if (!hasClass("pinned")(flat[pinnedIdx].props.className)) throw new Error("a pinned row must keep its pin marker");
if (findAll(flat[pinnedIdx], hasClass("tpin")).length !== 1) {
  throw new Error("a pinned tree row must draw the pin glyph, not only bold its label");
}
if (hasClass("pinned")(quickRow.props.className)) throw new Error("a bookmark is not a pin: it must not draw the pin marker");
if (findAll(quickRow, hasClass("tpin")).length !== 0) {
  throw new Error("a bookmark is a button, not a pin: it must not draw the pin glyph");
}
console.log("quick access ok: a strip of buttons above 目录; 置顶 only reorders 目录");

// ── 快速访问: the label parks, the rows take drops *into* them ──────────────
// Parking a container in the strip is the *label* gesture, so the band cannot
// wait for its first entry to exist: an empty strip draws the caption and one
// placeholder line, and both accept that drop.
//
// A drop on a *row* is a different thing (m03793). The row is the folder it
// names, so the payload goes inside that folder exactly as it would one level
// down in 目录: a bookmark dropped on a sibling moves into it, and a session
// dropped on a bookmarked workspace re-homes there. A strip that read every drop
// as "add/reorder a bookmark" refused a folder the very same folder took in the
// tree.
const dropCalls = [];
const moveCalls = [];
const sessionDrops = [];
const bandProps = (qa) => ({
  tree: { ...tree, quickAccessNodes: qa, quickAccess: Object.fromEntries(qa.map((id, i) => [id, qa.length - i])), pins: {} },
  scope: "f-root", onSelect: noop, expanded: new Set(["f-root"]), onToggle: noop, width: 260,
  // A drop carries the whole container half of the check-set (m01540), so the
  // band hands the tree an array even for the one-node gesture.
  onMove: (sources, target) => moveCalls.push([sources, target]),
  onDropSessions: (ids, workspaceId) => sessionDrops.push([ids, workspaceId]),
  onPlaceSessions: noop, onDropShortcut: noop, onHint: noop,
  rename: null, onBeginRename: noop, pins: {}, quickAccess: qa, onNodeContextMenu: noop,
  onDropOnQuick: (sources) => dropCalls.push(sources),
});
const emptyBand = findAll(render({ type: TreePane, props: bandProps([]) }), () => true);
const emptyCap = emptyBand.find((node) => isCap(node, "快速访问")) ?? null;
if (!emptyCap) throw new Error("an empty 快速访问 must still draw its caption");
if (typeof emptyCap.props.onDrop !== "function") throw new Error("the 快速访问 caption must be a drop target");
const ghost = emptyBand.find((node) => hasClass("tghost")(clsOf(node))) ?? null;
if (!ghost) throw new Error("an empty 快速访问 must draw the placeholder that says what it is for");
if (!textOf(ghost).includes("把文件夹或工作区拖到这里")) {
  throw new Error("the empty band must say what to drag here, got " + JSON.stringify(textOf(ghost)));
}
// Two bookmarks: drag the first, drop it on the label, then on its sibling.
const twoBand = findAll(render({ type: TreePane, props: bandProps(["w-ws-1", "d-1"]) }), () => true);
if (twoBand.some((node) => hasClass("tghost")(clsOf(node)))) {
  throw new Error("a non-empty 快速访问 must not keep the placeholder");
}
const bandDragEvent = { stopPropagation: noop, dataTransfer: { setData: noop, effectAllowed: "" } };
const srcRow = twoBand.find((node) => isRow(node, "w-ws-1") && typeof node.props.onDragStart === "function") ?? null;
if (!srcRow) throw new Error("a bookmark row must be draggable");
srcRow.props.onDragStart(bandDragEvent);
const bandDropEvent = { preventDefault: noop, stopPropagation: noop, dataTransfer: { dropEffect: "" } };
emptyCap.props.onDrop(bandDropEvent);
if (JSON.stringify(dropCalls) !== JSON.stringify([["w-ws-1"]])) {
  throw new Error("a drop on the 快速访问 label must park the container once, got " + JSON.stringify(dropCalls));
}
// A drop on a *row* means "into this folder": Trow forwards a container payload
// to onDropNode(scope), which is the same move the row takes in 目录. It must
// not touch the strip — the bookmark list is unchanged by it.
{
  const dstRow = twoBand.find((node) => isRow(node, "d-1")) ?? null;
  if (!dstRow) throw new Error("the second bookmark must draw a row");
  if (typeof dstRow.props.onDrop !== "function") throw new Error("a bookmark must accept a drop as a container");
  // The label drop above cleared the shared payload, so arm the drag again: a
  // dragover reads the source from module state, not from the DataTransfer.
  srcRow.props.onDragStart(bandDragEvent);
  // The row decides through its own dragover verdict — that is what greys a bad
  // target out before the pointer is released.
  let ok = false;
  dstRow.props.onDragOver({ preventDefault: () => { ok = true; }, dataTransfer: { types: ["text/plain"], dropEffect: "" } });
  if (!ok) throw new Error("a bookmark must accept a container dropped into it");
  const rowDropEvent = {
    preventDefault: noop, stopPropagation: noop,
    dataTransfer: { types: ["text/plain"], dropEffect: "", getData: () => "d-1" },
  };
  dstRow.props.onDrop(rowDropEvent);
  if (JSON.stringify(moveCalls) !== JSON.stringify([[["w-ws-1"], "d-1"]])) {
    throw new Error("dropping a bookmark on a sibling must move into that folder, got " + JSON.stringify(moveCalls));
  }
  if (dropCalls.length !== 1) throw new Error("a drop on a row must not rewrite the strip, got " + JSON.stringify(dropCalls));
}
// A session dropped on a bookmarked *workspace* re-homes there: the row answers
// through the same canDropNode/onDrop pair the tree row uses.
{
  const wsRow = twoBand.find((node) => isRow(node, "w-ws-1")) ?? null;
  if (!wsRow) throw new Error("the bookmarked workspace must draw a row");
  let takesSession = false;
  wsRow.props.onDragOver({
    preventDefault: () => { takesSession = true; },
    dataTransfer: { types: ["application/x-dsh-session-ids"], dropEffect: "" },
  });
  if (!takesSession) throw new Error("a bookmarked workspace must accept a session dropped into it");
  const sessionDropEvent = {
    preventDefault: noop, stopPropagation: noop, ctrlKey: false, metaKey: false,
    dataTransfer: { types: ["application/x-dsh-session-ids"], dropEffect: "", getData: () => JSON.stringify(["session-1"]) },
  };
  wsRow.props.onDrop(sessionDropEvent);
  if (JSON.stringify(sessionDrops) !== JSON.stringify([[["session-1"], "ws-1"]])) {
    throw new Error("a session dropped on a bookmarked workspace must move into it, got " + JSON.stringify(sessionDrops));
  }
}
// The band only lights up while a container is in flight. Once the drag ends
// with nothing carried, the caption must refuse the default — a band that
// accepted stray drags would read as a target for sessions too.
srcRow.props.onDragEnd();
let lit = false;
const strayEvent = { preventDefault: () => { lit = true; }, dataTransfer: { dropEffect: "" } };
emptyCap.props.onDragOver(strayEvent);
if (lit) throw new Error("an empty drag must not light the 快速访问 band");
console.log("quick access drop ok: the label parks, a row takes the drop inside it");

// ── a folder / workspace member is drawn as the container itself ───────────
// 收藏 holds memberships, and a membership of a folder *is* that folder: the
// page draws one row with the container's own glyph, name and 文件夹 tag. Two
// things must stay true while it does:
//   1. the row's data-id is the *shortcut's* id, because 移出收藏 deletes the
//      membership and nothing else;
//   2. opening the row lands on the original node, so the double-click carries
//      the target id rather than the pointer's.
const mappedTree = {
  ...tree,
  nodes: {
    ...tree.nodes,
    "s-f": {
      id: "s-f", type: "shortcut", kind: "shortcut", name: "", fixed: false,
      parent: "f-favorites", order: 0, shortcutKind: "folder", targetId: "d-1",
    },
    "s-w": {
      id: "s-w", type: "shortcut", kind: "shortcut", name: "", fixed: false,
      parent: "f-favorites", order: 1, shortcutKind: "workspace", targetId: "ws-1",
    },
  },
  children: { ...tree.children, "f-favorites": ["s-f", "s-w"] },
  counts: { ...tree.counts, "f-favorites": 2 },
};
decorateTree(mappedTree);
const opened = [];
const mappedList = listPaneWith({
  tree: mappedTree,
  scope: "f-favorites",
  onOpenWorkspace: (id) => opened.push(id),
});
const mappedFolder = findAll(mappedList, hasClass("folderrow")).find((node) => node.props?.["data-id"] === "s-f") ?? null;
const mappedWorkspace = findAll(mappedList, hasClass("wsrow")).find((node) => node.props?.["data-id"] === "s-w") ?? null;
if (!mappedFolder) throw new Error("a folder member of 收藏 must be drawn as a folder row");
if (!mappedWorkspace) throw new Error("a workspace member of 收藏 must be drawn as a workspace row");
for (const [row, what] of [[mappedFolder, "文件夹"], [mappedWorkspace, "工作区"]]) {
  if (!textOf(row).includes(what)) throw new Error("a mapping row must carry the " + what + " tag, got " + JSON.stringify(textOf(row)));
  if (textOf(row).includes("快捷方式")) throw new Error("a mapping row must not call itself 快捷方式, got " + JSON.stringify(textOf(row)));
}
// The pointer keeps its own id: that is what the menu deletes.
if (findAll(mappedList, hasClass("scrow")).length !== 0) {
  throw new Error("a mapping must not also draw a 快捷方式 row");
}
const clickEvent = { stopPropagation() {}, preventDefault() {} };
// 双击要有时限 (m01775): opening now lives in the second *press*, so the smoke
// presses twice the way a pointer would. The native dblclick handler is left
// with nothing but swallowing the text selection.
for (const row of [mappedFolder, mappedWorkspace]) {
  const before = opened.length;
  row.props.onClick(clickEvent);
  if (opened.length !== before) throw new Error("one press must not open a container");
  row.props.onClick(clickEvent);
}
if (opened[0] !== "d-1" || opened[1] !== "w-ws-1") {
  throw new Error("a mapping must open its target, got " + JSON.stringify(opened));
}
// …and the menu must address the membership, not the container.
const menuKinds = [];
const menuList = listPaneWith({
  tree: mappedTree,
  scope: "f-favorites",
  onNodeContextMenu: (event, descriptor) => menuKinds.push(descriptor?.kind),
});
for (const row of findAll(menuList, hasClass("mapped-row"))) row.props.onContextMenu(clickEvent);
if (menuKinds.join(",") !== "mapping,mapping") {
  throw new Error("a mapping row must open the mapping menu, got " + JSON.stringify(menuKinds));
}
// No pencil and no drop target: the row stands for a container but may only be
// taken out of this page.
if (findAll(mappedFolder, hasClass("nm-editbtn")).length !== 0) {
  throw new Error("a mapping row must not offer a rename pencil");
}
console.log("mapping row ok: drawn as the container, opens the original, acts on the membership");

const detailProps = {
  now: Date.now(), onClose: noop, onHint: noop, width: 320, parent: null, children: [], forks: [],
  forkSource: null, onOpen: noop, onEnterNode: noop, onOpenSession: noop, tagLibrary: [{ tag: "release", count: 1, preset: true }],
  onAddTag: noop, onRemoveTag: noop, onNewTag: noop, onDropTag: noop, onSetNote: noop, onToggleFlag: noop,
  onArchive: noop, onFork: noop, onRename: noop, onRestore: noop, onDelete: noop,
};
console.log("DetailPane (session) ok:", Boolean(render({ type: DetailPane, props: { ...detailProps, session, node: null } })));
// AI 字段 (m00531, m01823) lives right under 备注 in the pane that has a session.
// With nothing stored it still draws its heading and the one command that can
// change that — a session without fields must not look like a broken pane.
const sessionDetail = render({ type: DetailPane, props: { ...detailProps, session, node: null } });
const detailSections = findAll(sessionDetail, (cls) => cls.split(" ").includes("det-sec")).map((element) => textOf(element));
const noteAt = detailSections.findIndex((text) => text.trim().startsWith("备注"));
const fieldsAt = detailSections.findIndex((text) => text.includes("AI 字段"));
if (fieldsAt < 0) throw new Error("the detail pane must show the AI 字段 section");
if (noteAt < 0 || fieldsAt !== noteAt + 1) throw new Error("AI 字段 must sit directly under 备注");
if (!detailSections[fieldsAt].includes("让 AI 写标题和标签")) throw new Error("an empty record must offer the one command that fills it");
console.log("DetailPane AI 字段 ok: heading + 让 AI 写标题和标签 under 备注");

// A filled record: the three rows, and tags that are toggles rather than
// labels. Nothing was stored when the pane was first rendered above, so this
// second render is what proves the filled branch draws at all.
summaryRecord = {
  id: session.id,
  entry: {
    title: "修复导出",
    description: "助手的话现在也会导出。",
    tags: ["导出", "会话"],
    at: Date.now() - 60_000,
    model: { provider: "p", model: "m", effort: "" },
    tokens: { inputTokens: 1200, outputTokens: 60 },
    applied: { title: false, description: false, tags: false },
  },
};
await summaryStore.refresh();
const filled = render({ type: DetailPane, props: { ...detailProps, session, node: null } });
const chips = findAll(filled, (cls) => cls.split(" ").includes("ai-tag"));
if (chips.length !== 2) throw new Error("a stored record must draw one chip per tag, got " + chips.length);
if (!chips.every((chip) => chip.props.className.includes("on"))) throw new Error("every tag starts ticked");
if (!textOf(filled).includes("合并所选（2）")) throw new Error("the tag row must say how many will be merged");
const mergeRows = findAll(filled, (cls) => cls.split(" ").includes("ai-field")).map((row) => textOf(row));
if (!mergeRows.some((text) => text.includes("并入我的备注"))) throw new Error("the description must be mergeable on its own");
if (!mergeRows.some((text) => text.includes("用这个标题"))) throw new Error("the title must be mergeable on its own");
console.log("DetailPane AI 字段 filled ok: title/description/tags rows, ticked chips, 合并所选（2）");
console.log("DetailPane (trashed) ok:", Boolean(render({ type: DetailPane, props: { ...detailProps, session: { ...session, trashed: true }, node: null } })));
const wsDetail = render({ type: DetailPane, props: { ...detailProps, session: null, node: workspaceNode } });
console.log("DetailPane (workspace) ok:", Boolean(wsDetail));
// A workspace must describe itself as a workspace. Reading the wrong flag made
// it say 文件夹 in the detail pane.
const wsText = textOf(wsDetail);
if (!wsText.includes("工作区")) throw new Error("a workspace detail must say 工作区");
if (wsText.includes("文件夹")) throw new Error("a workspace detail must not say 文件夹");
const folderDetail = render({ type: DetailPane, props: { ...detailProps, session: null, node: folderNode } });
const folderText = textOf(folderDetail);
if (!folderText.includes("文件夹")) throw new Error("a folder detail must say 文件夹");
if (folderText.includes("工作区")) throw new Error("a folder detail must not say 工作区");
console.log("DetailPane (folder) ok:", Boolean(folderDetail));
console.log("DetailPane (empty) ok:", Boolean(render({ type: DetailPane, props: { ...detailProps, session: null, node: null } })));

console.log("FilterDialog open ok:", Boolean(render({
  type: FilterDialog,
  props: {
    open: true, value: { favorite: "all", archived: "all", todo: "all", tags: ["release"] },
    library: [{ tag: "release" }], onApply: noop, onClose: noop,
  },
})));
console.log("FilterDialog closed ok:", render({ type: FilterDialog, props: { open: false, value: { favorite: "all", archived: "all", todo: "all", tags: [] }, library: [], onApply: noop, onClose: noop } }) === null);
const scopeOpen = render({
  type: SearchScopeDialog,
  props: { open: true, value: { place: "here", name: true, tags: true, note: true, content: false }, onApply: noop, onClose: noop, onManage: noop },
});
console.log("SearchScopeDialog open ok:", Boolean(scopeOpen));
// 搜索位置 (m01916): two radio options above the field checkboxes, and the footer
// link to the index settings. A dialog that silently lost either is still a valid
// tree, so the smoke test has to look for them by role and by text.
const scopeText = textOf(scopeOpen);
console.log("SearchScopeDialog place ok:", scopeText.includes("所有位置") && scopeText.includes("当前目录"));
console.log("SearchScopeDialog manage ok:", scopeText.includes("搜索索引设置"));
const scopeClosed = render({
  type: SearchScopeDialog,
  props: { open: false, value: { name: true, tags: true, note: true, content: false }, onApply: noop, onClose: noop },
});
console.log("SearchScopeDialog closed ok:", scopeClosed === null);
const plainMenu = render({
  type: CommandMenu,
  props: {
    anchor: { left: 400, bottom: 300, element: null },
    items: [{ label: "刷新", icon: "refresh", run: noop }, { sep: true }, { label: "撤销", run: noop }],
    onClose: noop,
  },
});
console.log("CommandMenu ok:", Boolean(plainMenu));
if (findAll(plainMenu, hasClass("has-sub")).length > 0) throw new Error("a flat menu must not grow a flyout");

// 发送到: a parent with `sub` is a label, not a command. It carries has-sub and
// aria-haspopup, its .k slot holds the chevron instead of a shortcut key, and
// the children live inside .submenu as ordinary .mi rows (separators included).
const subMenu = render({
  type: CommandMenu,
  props: {
    anchor: { left: 400, bottom: 300, element: null },
    items: [
      { label: "发送到", icon: "shortcut", sub: [
        { label: "收藏", icon: "star", run: noop },
        { label: "待办", icon: "todo", run: noop },
        { sep: true },
        { label: "创建快捷方式（放到收藏）", icon: "shortcut", run: noop },
      ] },
      { label: "删除", icon: "trash", danger: true, run: noop },
    ],
    onClose: noop,
  },
});
const parents = findAll(subMenu, hasClass("has-sub"));
if (parents.length !== 1) throw new Error("the 发送到 parent must be the only has-sub row");
const parent = parents[0];
if (parent.props["aria-haspopup"] !== "true") throw new Error("a flyout parent advertises aria-haspopup");
if (typeof parent.props.onClick === "function") parent.props.onClick();
const flyout = findAll(parent, hasClass("submenu"))[0] ?? null;
if (!flyout) throw new Error("the parent must contain a .submenu");
const children = findAll(flyout, hasClass("mi"));
if (children.length !== 3) throw new Error("the flyout must hold three items, got " + children.length);
if (findAll(flyout, hasClass("misep")).length !== 1) throw new Error("a sep inside sub becomes a .misep");
if (!textOf(flyout).includes("收藏") || !textOf(flyout).includes("创建快捷方式")) throw new Error("the flyout labels must render");
if (findAll(subMenu, hasClass("danger")).length !== 1) throw new Error("the sibling row keeps its own class");
console.log("CommandMenu 发送到 flyout ok:", children.length === 3);

// A menu that would push its flyout off the right edge flips it to the left:
// data-flip rides on the .ctxmenu and the stylesheet turns left:100% into
// right:100%. Without it 发送到 would open outside the window.
const flipMenu = (left) => findAll(render({
  type: CommandMenu,
  props: {
    anchor: { left, bottom: 300, element: null },
    items: [{ label: "发送到", icon: "shortcut", sub: [{ label: "收藏", icon: "star", run: noop }] }],
    onClose: noop,
  },
}), hasClass("ctxmenu"))[0];
const nearEdge = flipMenu(1270);
if (nearEdge.props["data-flip"] !== "1") throw new Error("a right-edge menu must flip its flyout");
const away = flipMenu(400);
if (away.props["data-flip"] !== undefined) throw new Error("a menu with room must keep the default flyout");
console.log("CommandMenu data-flip ok:", nearEdge.props["data-flip"] === "1");

// ── dialogs ─────────────────────────────────────────────────────────────────
// Every dialog is local now, and it must be local *and* on the plugin's dialog
// layer. The old design rendered destructive confirms through DSH's Modal,
// which sits at the app's dialog tier — below this panel — so a confirmation
// could be painted underneath the window that opened it.
const dialogsHosted = (dialog) =>
  render({ type: DialogHost, props: { dialog, promptRef: { current: null }, onSettle: noop } });

const plainConfirm = dialogsHosted({
  kind: "confirm",
  title: "删除文件夹",
  message: "内容会移动到上一级。",
  confirmLabel: "删除",
  cancelLabel: "取消",
  danger: true,
  resolve: noop,
});
const riskConfirm = dialogsHosted({
  kind: "confirm",
  title: "永久删除",
  message: "不可撤销。",
  confirmLabel: "永久删除",
  cancelLabel: "取消",
  danger: true,
  acknowledge: "我明白此操作不可撤销",
  resolve: noop,
});
const promptDialog = dialogsHosted({
  kind: "prompt",
  title: "新建文件夹",
  message: "",
  placeholder: "新建文件夹",
  value: "新建文件夹",
  confirmLabel: "创建",
  cancelLabel: "取消",
  maxLength: 64,
  validate: null,
  resolve: noop,
});
console.log("DialogHost confirm ok:", Boolean(plainConfirm));
console.log("DialogHost risk ok:", Boolean(riskConfirm));
console.log("DialogHost prompt ok:", Boolean(promptDialog));

for (const [label, dialog] of [["confirm", plainConfirm], ["risk", riskConfirm], ["prompt", promptDialog]]) {
  if (!dialog) throw new Error("the " + label + " dialog must render");
  if (findAll(dialog, hasClass("fmodal")).length !== 1) {
    throw new Error("the " + label + " dialog must be a local .fmodal layer");
  }
  if (findAll(dialog, (cls) => cls.includes("se-native-dialog")).length > 0) {
    throw new Error("the " + label + " dialog must not use the removed native class");
  }
}
// The acknowledgement checkbox is what makes 永久删除 hard to trigger by accident.
if (findAll(riskConfirm, hasClass("se-dlg-ack")).length !== 1) {
  throw new Error("a destructive confirm must carry the acknowledgement checkbox");
}
if (findAll(plainConfirm, hasClass("se-dlg-ack")).length !== 0) {
  throw new Error("an ordinary confirm must not carry an acknowledgement");
}
const dialogLayer = findAll(plainConfirm, hasClass("fmodal"))[0];
if (dialogLayer.props?.onMouseDown === undefined) {
  throw new Error("the dialog backdrop must dismiss on mousedown, not on any click");
}
console.log("dialogs presenter: local (above the panel)");

// ── sizing ──────────────────────────────────────────────────────────────────
// The host has modalSizeOf; the bundle cannot import it, so the two are pinned
// to the same answers here. A drift would make the panel and the settings page
// disagree about what "中" means.
const cases = [
  [{ sizing: "fixed", size: "sm" }, { width: "min(860px, 94vw)", height: "min(560px, 90vh)" }],
  [{ sizing: "fixed", size: "md" }, { width: "min(1100px, 94vw)", height: "min(720px, 90vh)" }],
  [{ sizing: "fixed", size: "lg" }, { width: "min(1320px, 94vw)", height: "min(820px, 90vh)" }],
  [{ sizing: "fixed", size: "xl" }, { width: "min(1600px, 94vw)", height: "min(960px, 90vh)" }],
  [{ sizing: "percent", percent: "p50" }, { width: "50vw", height: "50vh" }],
  [{ sizing: "percent", percent: "p100" }, { width: "100vw", height: "100vh" }],
];
for (const [input, expected] of cases) {
  const actual = frameSizeOf(input);
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error("frameSizeOf(" + JSON.stringify(input) + ") = " + JSON.stringify(actual) + ", expected " + JSON.stringify(expected));
  }
}
console.log("sizing presets ok:", cases.length);

// ── DSH's own session surfaces ──────────────────────────────────────────────
// The header strip and the two row-menu entries are mounted by DSH, outside the
// panel: they receive one session id, not the bootstrap snapshot, so their
// contract is wording + which clicks are allowed. 归档 becomes 取消归档 once the
// session is archived, and a trashed session offers nothing that writes.
const { headerActionsFor, SessionHeaderActions, SessionMenuItems, DialogChannel, dialogStore } = mod.__test;
const tKey = (key) => key;

for (const name of ["conversation.session.header.actions", "sidebar.workspaces.session.menu.item"]) {
  if (!registered.some(([slot]) => slot === name)) throw new Error("the plugin must inject into " + name);
}

const idleActions = headerActionsFor({}, tKey);
if (idleActions.map((action) => action.key).join(",") !== "archive,favorite,todo,reveal,delete") {
  throw new Error("the header must offer the five actions in DSH's order: " + JSON.stringify(idleActions.map((a) => a.key)));
}
if (idleActions.map((action) => action.label).join(",") !== "hdrArchive,hdrFavorite,hdrTodo,hdrReveal,hdrDelete") {
  throw new Error("a live session must read 归档/收藏/待办/查看/删除: " + JSON.stringify(idleActions.map((a) => a.label)));
}
if (idleActions.some((action) => action.disabled)) throw new Error("a live session must leave every header action enabled");

// "Not read yet" is not "no flags set". The strip decides what a press will
// write from this state, so until it arrives — or if reading it failed — every
// write waits. Carrying the previous session's state over made the strip offer
// 取消收藏 on a session that was never favorited and then write that.
const unknownActions = headerActionsFor(null, tKey);
if (unknownActions.some((action) => !action.disabled)) {
  throw new Error("an unread session state must not offer a write: " + JSON.stringify(unknownActions.filter((a) => !a.disabled).map((a) => a.key)));
}

const onActions = headerActionsFor({ archived: true, favorite: true, todo: true }, tKey);
if (onActions[0].label !== "hdrUnarchive" || onActions[1].label !== "hdrUnfavorite" || onActions[2].label !== "hdrUntodo") {
  throw new Error("a set flag must offer its inverse: " + JSON.stringify(onActions.map((a) => a.label)));
}
if (!onActions[0].pressed || !onActions[1].pressed || !onActions[2].pressed) {
  throw new Error("a set flag must read pressed, so the strip shows the state");
}
// 在会话资源管理器查看 only reads, so a trashed session keeps it; everything that
// writes into the annotations document or moves the log is off.
const trashedActions = headerActionsFor({ trashed: true }, tKey);
if (trashedActions.filter((action) => action.disabled).map((action) => action.key).join(",") !== "archive,favorite,todo,delete") {
  throw new Error("a trashed session must refuse every write: " + JSON.stringify(trashedActions.filter((a) => a.disabled).map((a) => a.key)));
}
// One write at a time: the annotations document is revision-guarded, so a second
// click while one is in flight would just lose the race.
const busyActions = headerActionsFor({}, tKey, "archive");
if (busyActions.some((action) => !action.disabled)) throw new Error("a write in flight must disable every header action");

const strip = render({ type: SessionHeaderActions, props: { sessionId: "session-1", t: tKey } });
if (!strip) throw new Error("the header strip must render for a session");
if (findAll(strip, hasClass("se-hdrActions")).length !== 1) throw new Error("the strip must be a .se-hdrActions");
const stripButtons = findAll(strip, hasClass("se-hdrBtn"));
if (stripButtons.length !== 5) throw new Error("the strip must render five buttons, got " + stripButtons.length);
if (stripButtons.map((button) => button.props["data-action"]).join(",") !== "archive,favorite,todo,reveal,delete") {
  throw new Error("the strip's buttons must carry their action: " + JSON.stringify(stripButtons.map((b) => b.props["data-action"])));
}
// The strip renders before this session's state is known, and a press at that
// moment would be decided from nothing — so it starts disabled and enables once
// the state lands.
if (stripButtons.some((button) => !button.props.disabled)) throw new Error("a strip that has not read its state must not offer a write");

// Every button is icon + word: the icon is a 16x16 inline svg stroked with
// currentColor (so 删除 can paint it red), and the word lives in .se-hdrLabel,
// which the narrow-window media query hides.
for (const button of stripButtons) {
  const key = button.props["data-action"];
  const icons = findAll(button, hasClass("se-hdrIco"));
  if (icons.length !== 1) throw new Error(key + " must carry exactly one icon, got " + icons.length);
  if (!String(icons[0].props.className).includes("se-hdrIco-" + key)) {
    throw new Error(key + " must carry its own icon, got " + icons[0].props.className);
  }
  if (icons[0].type !== "svg" || icons[0].props.viewBox !== "0 0 16 16") {
    throw new Error(key + "'s icon must be a 16x16 svg");
  }
  if ((icons[0].children ?? []).length === 0) throw new Error(key + "'s icon must draw at least one path");
  const labels = findAll(button, hasClass("se-hdrLabel"));
  if (labels.length !== 1) throw new Error(key + " must carry exactly one label span");
  if (textOf(labels[0]) !== button.props.title) {
    throw new Error(key + "'s label must read what its title says");
  }
  // The tooltip stays the plain name, so hovering an armed 删除 still says 删除.
  if (typeof button.props["aria-label"] !== "string") throw new Error(key + " must name itself for a screen reader");
}

// 删除 asks before it deletes: one click opens the plugin's dialog channel, and
// nothing reaches the host until the question is answered "yes".
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const deleteButton = stripButtons.find((button) => button.props["data-action"] === "delete");
if (!deleteButton) throw new Error("the strip must render 删除");
const callsBefore = fetchCalls.length;

deleteButton.props.onClick();
await flush();
const pending = dialogStore.getSnapshot();
if (!pending) throw new Error("删除 must open the confirm dialog");
if (pending.kind !== "confirm" || pending.danger !== true) {
  throw new Error("删除 must ask a danger confirm, got " + JSON.stringify({ kind: pending.kind, danger: pending.danger }));
}
if (pending.title !== "hdrDeleteTitle" || pending.confirmLabel !== "hdrDelete" || pending.cancelLabel !== "hdrCancel") {
  throw new Error(
    "the delete question must be worded by the strip: " +
      JSON.stringify([pending.title, pending.confirmLabel, pending.cancelLabel]),
  );
}
if (fetchCalls.length !== callsBefore) {
  throw new Error("asking must not write: the delete reached the host before the answer");
}

// The question is drawn by the plugin on its own dialog layer, with a solid red
// confirm button — the same red the 删除 button and menu row carry.
const question = render({ type: DialogHost, props: { dialog: pending, promptRef: null, onSettle: () => {} } });
if (findAll(question, hasClass("fmodal")).length !== 1) throw new Error("the question must be drawn on the dialog layer");
const confirmButtons = findAll(question, hasClass("act")).filter((button) =>
  String(button.props.className).includes("danger-solid"),
);
if (confirmButtons.length !== 1) throw new Error("the confirm button must be the red danger-solid one");
if (textOf(confirmButtons[0]) !== "hdrDelete") throw new Error("the confirm button must read 删除");

// 取消 answers no and writes nothing.
dialogStore.settle(false);
await flush();
if (dialogStore.getSnapshot() !== null) throw new Error("answering must clear the dialog");
if (fetchCalls.length !== callsBefore) throw new Error("取消 must not delete the session");

// 删除 answers yes and the session goes to the trash.
deleteButton.props.onClick();
await flush();
if (!dialogStore.getSnapshot()) throw new Error("删除 must ask again on every click");
dialogStore.settle(true);
await flush();
if (!fetchCalls.some((call) => call.method === "POST" && call.url.endsWith("/trash"))) {
  throw new Error("answering yes must post the session to the trash, saw " + JSON.stringify(fetchCalls.slice(callsBefore)));
}
if (dialogStore.getSnapshot() !== null) throw new Error("an answered dialog must leave the channel empty");

// The channel is mounted beside the sidebar entry, so it exists while the panel
// is closed and draws nothing when there is no question.
if (render({ type: DialogChannel }) !== null) throw new Error("the channel must draw nothing without a question");
console.log("header strip ok:", stripButtons.length, "buttons");

// DSH mounts the slot per session view; without an id there is nothing to act on.
if (render({ type: SessionHeaderActions, props: { t: tKey } }) !== null) {
  throw new Error("the strip must render nothing without a session id");
}

const menuItems = render({ type: SessionMenuItems, props: { sessionId: "session-1", t: tKey } });
if (!menuItems) throw new Error("the row menu entries must render");
const menuLabels = textOf(menuItems);
if (!menuLabels.includes("hdrReveal")) throw new Error("the first row must be 在会话资源管理器查看");
if (!menuLabels.includes("hdrDelete")) throw new Error("the second row must be 删除");
// The rows are drawn by the plugin (a client slot must not require a Harness
// package), so both are .se-menuItem — no host row chrome is involved.
const menuRows = findAll(menuItems, hasClass("se-menuItem"));
if (menuRows.length !== 2) throw new Error("both entries must be .se-menuItem rows, got " + menuRows.length);
if (menuRows.map((row) => row.props.role).join(",") !== "menuitem,menuitem") {
  throw new Error("each row must be role=menuitem");
}
// The first row starts this group, so it carries the hairline; the second does not.
if (!menuRows[0].props.className.includes("se-menuItem-sep")) {
  throw new Error("the first entry must start the group with a separator");
}
if (menuRows[1].props.className.includes("se-menuItem-sep")) {
  throw new Error("only the first entry of the group gets a separator");
}
// 删除 is destructive here too: same red, and the same question.
if (!String(menuRows[1].props.className).includes("se-menuItem-danger")) {
  throw new Error("the row menu's 删除 must carry the danger class");
}
const beforeMenuAsk = fetchCalls.length;
menuRows[1].props.onClick();
await flush();
if (!dialogStore.getSnapshot()) throw new Error("the row menu's 删除 must ask before it deletes");
if (fetchCalls.length !== beforeMenuAsk) throw new Error("the row menu must not delete before the answer");
dialogStore.settle(false);
await flush();
// No session id: nothing to view or delete, so the menu must not grow rows.
if (render({ type: SessionMenuItems, props: { t: tKey } }) !== null) {
  throw new Error("the row menu entries must render nothing without a session id");
}
console.log("row menu entries ok: reveal + delete");

