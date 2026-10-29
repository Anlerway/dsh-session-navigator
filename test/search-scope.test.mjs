/**
 * 搜索范围 — which fields the search box reads, and the dialog that chooses them.
 *
 * 会话名 / 标签 / 备注 are answered from the rows the panel already holds; 会话内容
 * is answered by the host index and arrives as hits. These cases pin the split:
 * a field that is off must not match even when the row carries the text, and a
 * 会话内容 hit must not match while that field is off.
 *
 *   node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadClientBundle } from "./support/client-bundle.mjs";

/** Every draft the dialog tries to store, in order. */
const drafts = [];

/** The harness's React stub, with a useState that records its setter. */
const react = {
  Component: class {
    constructor(props) {
      this.props = props;
    }
  },
  Fragment: Symbol("Fragment"),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  createPortal: (node) => node,
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => {
    const value = typeof initial === "function" ? initial() : initial;
    return [value, (next) => drafts.push(typeof next === "function" ? next(value) : next)];
  },
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (compute) => compute(),
  useCallback: (fn) => fn(),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

const { test: api } = loadClientBundle({
  expose: ["SearchScopeDialog", "DEFAULT_SEARCH_SCOPES", "normalizeSearchScopes", "sessionMatchesQuery", "searchBaseSessions"],
  react,
});

/** Every element in a rendered tree, depth first. */
function elements(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
    return out;
  }
  if (node.type) out.push(node);
  for (const child of node.children ?? []) elements(child, out);
  return out;
}

/** The text inside an element, concatenated. */
function textOf(node) {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  return (node.children ?? []).map(textOf).join("");
}

/** The button drawn with this exact label, if the dialog drew one. */
function button(tree, label) {
  return elements(tree).find((node) => node.type === "button" && textOf(node) === label);
}

/** A session row as the listing reports it. */
const session = (extra = {}) => ({
  id: "s-1",
  displayTitle: "登录失败排查",
  title: "session.v1",
  note: "记得问一下超时设置",
  tags: ["auth", "p0"],
  cwd: "C:/work/api",
  workspaceTitle: "api",
  ...extra,
});

/** The default range with a few fields moved. */
const scopes = (extra = {}) => ({ ...api.DEFAULT_SEARCH_SCOPES, ...extra });

test("the default range is the three fields the box always read", () => {
  assert.deepEqual(api.DEFAULT_SEARCH_SCOPES, { name: true, tags: true, note: true, content: false });
  assert.deepEqual(api.normalizeSearchScopes(undefined), api.DEFAULT_SEARCH_SCOPES);
  assert.deepEqual(api.normalizeSearchScopes(null), api.DEFAULT_SEARCH_SCOPES);
  // 会话内容 is the expensive one: only an explicit true turns it on.
  assert.equal(api.normalizeSearchScopes({ content: "yes" }).content, false);
  assert.equal(api.normalizeSearchScopes({}).content, false);
  assert.equal(api.normalizeSearchScopes({ content: true }).content, true);
  assert.equal(api.normalizeSearchScopes({ name: false }).name, false);
  // Junk is ignored rather than guessed at: an unreadable stored range falls
  // back to searching, not to searching nothing.
  assert.deepEqual(api.normalizeSearchScopes({ junk: 1, tags: 0 }), api.DEFAULT_SEARCH_SCOPES);
});

test("each field matches on its own text", () => {
  assert.equal(api.sessionMatchesQuery(session(), "登录", scopes()), true, "title");
  assert.equal(api.sessionMatchesQuery(session(), "超时", scopes()), true, "note");
  assert.equal(api.sessionMatchesQuery(session(), "auth", scopes()), true, "tag");
  assert.equal(api.sessionMatchesQuery(session(), "api", scopes()), true, "workspace");
  assert.equal(api.sessionMatchesQuery(session(), "nothing", scopes()), false);
  assert.equal(api.sessionMatchesQuery(session(), "", scopes()), true, "an empty needle filters nothing");
});

test("a field that is off cannot match, even when the row carries the text", () => {
  assert.equal(api.sessionMatchesQuery(session(), "登录", scopes({ name: false })), false);
  assert.equal(api.sessionMatchesQuery(session(), "超时", scopes({ note: false })), false);
  assert.equal(api.sessionMatchesQuery(session(), "auth", scopes({ tags: false })), false);
  // The row's note and title are still there — turning them off is a decision,
  // not a data change.
  assert.equal(api.sessionMatchesQuery(session(), "登录", scopes({ tags: false })), true);
});

test("会话内容 matches the host's hits, and only while the field is on", () => {
  const hits = { "s-1": { id: "s-1", count: 3, snippet: "…timeout 30s…" } };
  assert.equal(api.sessionMatchesQuery(session(), "timeout", scopes({ content: true }), hits), true);
  assert.equal(api.sessionMatchesQuery(session(), "timeout", scopes({ content: true }), {}), false, "no hit yet");
  assert.equal(api.sessionMatchesQuery(session(), "timeout", scopes({ content: false }), hits), false);
  // While the index is still building there are no hits yet, and the row simply
  // does not match — the status bar is what says the answer is partial.
  assert.equal(api.sessionMatchesQuery(session(), "timeout", scopes({ content: true }), undefined), false);
});

test("会话内容 can be the only field searched", () => {
  const only = scopes({ name: false, tags: false, note: false, content: true });
  // The word is on screen — in the title and in the note — and still must not
  // match, because neither of those fields is in range.
  assert.equal(api.sessionMatchesQuery(session(), "登录", only, {}), false);
  // A body hit is then the only thing that can bring the row back.
  const hits = { "s-1": { id: "s-1", count: 1, snippet: "…" } };
  assert.equal(api.sessionMatchesQuery(session(), "登录", only, hits), true);
});

test("a caller with no range still searches the three metadata fields", () => {
  // ListPane is rendered by other callers (and by the smoke test) without the
  // prop; the box must behave as it did before the range existed.
  assert.equal(api.sessionMatchesQuery(session(), "登录", undefined, undefined), true);
});

test("the dialog draws one checkbox per field and nothing takes effect early", () => {
  const tree = api.SearchScopeDialog({ open: true, value: scopes(), onApply: () => {}, onClose: () => {} });
  const boxes = elements(tree).filter((node) => node.props?.role === "checkbox");
  assert.deepEqual(boxes.map(textOf), ["会话名", "标签", "备注", "会话内容"]);
  assert.deepEqual(boxes.map((box) => box.props["aria-checked"]), [true, true, true, false]);
  assert.ok(button(tree, "应用"));
  assert.ok(button(tree, "重置"));
  assert.ok(button(tree, "取消"));
});

test("the dialog is absent until it is opened", () => {
  assert.equal(api.SearchScopeDialog({ open: false, value: scopes(), onApply: () => {}, onClose: () => {} }), null);
});

test("重置 restores the defaults as a draft — 应用 still decides", () => {
  drafts.length = 0;
  const calls = [];
  const tree = api.SearchScopeDialog({
    open: true,
    value: scopes({ name: false, content: true }),
    onApply: (next) => calls.push(next),
    onClose: () => {},
  });
  button(tree, "重置").props.onClick();
  assert.deepEqual(drafts, [{ ...api.DEFAULT_SEARCH_SCOPES }]);
  assert.deepEqual(calls, [], "reset is a draft change, not an application");
});

test("a click on 会话内容 toggles exactly that field", () => {
  drafts.length = 0;
  const tree = api.SearchScopeDialog({ open: true, value: scopes(), onApply: () => {}, onClose: () => {} });
  button(tree, "会话内容").props.onClick();
  assert.deepEqual(drafts, [{ ...api.DEFAULT_SEARCH_SCOPES, content: true }]);
});

test("应用 hands the draft back, and 取消 only closes", () => {
  const applied = [];
  const closed = [];
  const value = scopes({ tags: false });
  const tree = api.SearchScopeDialog({
    open: true,
    value,
    onApply: (next) => applied.push(next),
    onClose: () => closed.push(true),
  });
  button(tree, "应用").props.onClick();
  assert.deepEqual(applied, [value]);
  button(tree, "取消").props.onClick();
  assert.deepEqual(closed, [true]);
  assert.deepEqual(applied, [value], "取消 does not apply");
});

const { searchBaseSessions } = api;
const ownRows = [{ id: "s1" }];
const library = [{ id: "s1" }, { id: "s2" }];
const base = (needle, scope) => searchBaseSessions({ needle, scope, trashScope: "trash", own: ownRows, library });

test("a search answers with the whole library, wherever you stand (m00470)", () => {
  // 站在文件夹里、搜到三条分支以外的会话：结果视图缩小到子树等于回答"这里没有"。
  assert.equal(base("登录", "d-proj"), library);
  // 收藏 是浏览的地方，不是搜索的边界。
  assert.equal(base("登录", "favorites"), library);
  assert.equal(base("登录", "todos"), library);
});

test("with no needle a container lists only its own rows", () => {
  assert.equal(base("", "d-proj"), ownRows);
});

test("回收站 keeps its own rows: 清空 has to stay aimable", () => {
  assert.equal(base("登录", "trash"), ownRows);
});

test("the panel hands the range to the list and mounts the dialog", () => {
  // The wiring is the part no unit case covers: every piece above can be right
  // while the panel forgets to pass it down, and then 会话内容 silently does
  // nothing. Read the two mounts and check the props are there.
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const mountAt = source.indexOf("h(ListPane, {");
  assert.ok(mountAt > 0, "the panel still mounts the list");
  const mount = source.slice(mountAt, mountAt + source.slice(mountAt).indexOf("})"));
  for (const prop of ["searchScopes", "contentHits", "contentPending"]) {
    assert.ok(mount.includes(prop), "ListPane is not receiving " + prop);
  }
  const dialogAt = source.indexOf("h(SearchScopeDialog, {");
  assert.ok(dialogAt > 0, "the dialog is mounted");
  const dialog = source.slice(dialogAt, dialogAt + source.slice(dialogAt).indexOf("})"));
  for (const prop of ["open: scopeOpen", "value: searchScopes", "onApply", "onClose"]) {
    assert.ok(dialog.includes(prop), "SearchScopeDialog is not receiving " + prop);
  }
  // And the way in: a funnel button next to the search box.
  assert.ok(source.includes('className: "nbtn scopes"'), "the 搜索范围 button is missing from the navbar");
});

test("an empty range is refused rather than applied", () => {
  const empty = { name: false, tags: false, note: false, content: false };
  const tree = api.SearchScopeDialog({ open: true, value: empty, onApply: () => {}, onClose: () => {} });
  assert.equal(button(tree, "应用").props.disabled, true);
  assert.match(textOf(tree), /至少选择一项/);
});
