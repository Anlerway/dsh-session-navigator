/**
 * The settings page's render harness: a stateful React stand-in, the
 * settings document the host would answer with, and renderSettings(), which
 * renders the page against that document and hands back the tree plus the
 * calls the page made.
 *
 * Kept out of the test file so the assertions read as a list of behaviours
 * instead of a list of behaviours behind 460 lines of scaffolding.
 */
import { loadClientBundle, recordingFetch } from "./client-bundle.mjs";

export const EXPOSE = ["SettingsSection"];

/** Shallow dependency comparison; functions are never news. */
function sameDeps(previous, next) {
  if (previous.length !== next.length) return false;
  return previous.every((value, index) => Object.is(value, next[index]) || (typeof value === "function" && typeof next[index] === "function"));
}

/**
 * A React stand-in with working state.
 *
 * Hook storage is keyed by the component's position in the rendered tree, not by
 * a global call counter: a child that mounts on a later pass (`ComponentGroup`,
 * which waits for the document) must not inherit its parent's hook slots.
 */
export function makeReact() {
  const scopes = new Map();
  const effectDeps = new Map();
  let cursor = 0;
  let cells = [];
  let pending = [];
  let dirty = false;

  const hook = (index, create) => {
    if (!(index in cells)) cells[index] = create();
    return cells[index];
  };
  const readIndex = () => cursor++;

  const React = {
    Component: class {
      constructor(props) {
        this.props = props;
        this.state = {};
      }
      setState(patch) {
        this.state = { ...this.state, ...(typeof patch === "function" ? patch(this.state) : patch) };
        dirty = true;
      }
    },
    Fragment: Symbol("Fragment"),
    createElement: (type, props, ...children) => {
      const merged = { ...(props ?? {}) };
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { type, props: merged, children };
    },
    createPortal: (node) => node,
    memo: (type) => type,
    useRef: (initial) => hook(readIndex(), () => ({ current: initial })),
    useState: (initial) => {
      const cell = hook(readIndex(), () => ({ value: typeof initial === "function" ? initial() : initial }));
      const set = (next) => {
        const value = typeof next === "function" ? next(cell.value) : next;
        if (Object.is(value, cell.value)) return;
        cell.value = value;
        dirty = true;
      };
      return [cell.value, set];
    },
    useEffect: (effect, deps) => {
      const key = cells.scope + ":" + readIndex();
      // Dependencies are compared the way React compares them, except that two
      // functions always count as equal: this stand-in keeps a callback's first
      // identity, so a `[load]` list would otherwise re-run on every paint. An
      // omitted list means `[]`, which is what the page means by it.
      const list = Array.isArray(deps) ? deps : [];
      const previous = effectDeps.get(key);
      if (previous && sameDeps(previous, list)) return;
      effectDeps.set(key, list);
      pending.push(effect);
    },
    useLayoutEffect: (effect) => React.useEffect(effect),
    useMemo: (compute) => compute(),
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };

  /** Render one pass, running each first-time effect. */
  async function settle(renderRoot) {
    for (let pass = 0; pass < 25; pass += 1) {
      pending = [];
      dirty = false;
      const tree = renderRoot();
      for (const effect of pending) {
        try {
          effect();
        } catch (error) {
          throw new Error("an effect threw: " + error?.message);
        }
      }
      // Let every awaited request land before deciding whether to paint again.
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!dirty) return tree;
    }
    throw new Error("the settings page did not settle");
  }

  /** Walk the tree, calling components; host elements keep their props. */
  function render(element, path = "root") {
    if (element === null || element === undefined || typeof element !== "object") return element;
    if (Array.isArray(element)) return element.map((child, index) => render(child, `${path}[${index}]`));
    if (typeof element.type === "function") {
      const savedCursor = cursor;
      const savedCells = cells;
      cells = scopes.get(path) ?? [];
      cells.scope = path;
      scopes.set(path, cells);
      cursor = 0;
      let output;
      if (element.type.prototype && typeof element.type.prototype.render === "function") {
        output = new element.type(element.props).render();
      } else {
        output = element.type(element.props, ...(element.children ?? []));
      }
      cursor = savedCursor;
      cells = savedCells;
      return render(output, `${path}>`);
    }
    return {
      type: element.type,
      props: element.props,
      children: (element.children ?? []).map((child, index) => render(child, `${path}/${index}`)),
    };
  }

  return { React, settle, render };
}

/** Every host element in a rendered tree that matches a predicate. */
export function collect(element, match, out = []) {
  if (!element || typeof element !== "object") return out;
  if (Array.isArray(element)) {
    for (const child of element) collect(child, match, out);
    return out;
  }
  if (match(element)) out.push(element);
  for (const child of element.children ?? []) collect(child, match, out);
  return out;
}

/** An element's text, including nested text. */
export function textOf(element) {
  if (element === null || element === undefined) return "";
  if (typeof element === "string" || typeof element === "number") return String(element);
  if (Array.isArray(element)) return element.map(textOf).join("");
  return (element.children ?? []).map(textOf).join("");
}

export const byClass = (name) => (element) => {
  const className = typeof element.props?.className === "string" ? element.props.className : "";
  return className.split(/\s+/).includes(name);
};

/** The settings document the host would answer with. */
export function settingsDocument(mode, component, uiLang = "auto", wallpaper = null) {
  return {
    settings: {
      // 独立窗口美化: the panel at its default density until a case says otherwise.
      wallpaper: wallpaper ?? { enabled: true, blur: 0, frost: 60, dim: 10, sync: true, custom: "", customName: "" },
      shell: {
        open: { mode },
        modal: { sizing: "fixed", size: "md", percent: "p70", dim: 0, closeOnBackdrop: true },
        window: { alwaysOnTop: false, bounds: null },
        header: { style: "auto" },
      },
      list: { autoCollapse: false, showArchived: true },
      // 搜索索引: the index cache is on and the idle build is off, the
      // same defaults a fresh install gets.
      search: { indexIdle: false },
      // AI 摘要: no model chosen yet, and every piece of session
      // metadata goes into the prompt until the user says otherwise.
      summary: { provider: "", model: "", effort: "", fields: { title: true, description: true, tags: true } },
      // 界面语言: the shipped answer follows DSH; a case that pins one passes it in.
      ui: { lang: uiLang },
      dataDir: { current: null },
    },
    revision: 4,
    capabilities: { component },
    dataDir: "C:/data",
    // The build number rides along with the document so the 关于 group can print
    // it without a request of its own.
    version: "1.0.0",
  };
}

/** The model catalogue a host with one provider would answer with. */
export function defaultCatalog() {
  return {
    providers: [
      {
        id: "wb-proxy",
        name: "WB Proxy",
        models: [
          {
            id: "deepseek-v4.1-flash",
            name: "DeepSeek V4.1 Flash",
            description: "1M window",
            efforts: [
              { id: "low", name: "Low" },
              { id: "high", name: "High" },
            ],
            defaultEffort: "low",
          },
          { id: "hy3", name: "hy3", description: "", efforts: [], defaultEffort: null },
        ],
      },
    ],
    failures: [],
    at: 1_700_000_000_000,
  };
}

/** An idle summarizer, in the shape `GET /summarize/state` returns. */
export function idleState() {
  return {
    running: false,
    cancelled: false,
    total: 0,
    done: 0,
    failed: 0,
    pending: 0,
    current: null,
    lastError: "",
    lastFailureId: "",
    startedAt: null,
    finishedAt: null,
    summarized: 0,
    spend: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, runs: 0, failures: 0 },
  };
}

/** What `GET /release-notes` answers with: a title and the blocks the host
 *  parsed out of the document. The shapes here are the contract in
 *  src/domain/notes.js — h / p / list / hr. */
export function releaseNotes() {
  return {
    title: "更新说明：V1.1.0",
    bytes: 160,
    updatedAt: 0,
    blocks: [
      { kind: "p", runs: [{ text: "主要改动" }] },
      { kind: "list", ordered: true, items: [[{ text: "会话内容搜索" }], [{ text: "性能优化" }]] },
      { kind: "hr" },
      { kind: "h", level: 2, runs: [{ text: "新增" }] },
      { kind: "list", ordered: false, items: [[{ text: "更新说明弹窗", bold: true }, { text: "：设置里就能看" }]] },
    ],
  };
}

/** One render of the page, through the driver so its hooks get a stable scope. */
export const page = (driver, api, t) => driver.render(driver.React.createElement(api.SettingsSection, { t }));

/** The real `t` replaces `{name}` placeholders. Tests usually match on the bare
 *  key, so interpolation is opt-in — but a case that asserts on a number needs it,
 *  and the key is kept in front of the text so both assertions still work. */
export const interpolating = (key, vars = {}) =>
  key.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole)) +
  (Object.keys(vars).length ? `(${Object.values(vars).join(", ")})` : "");

/** Render the page against a document, and hand back the tree and the calls. */
export async function renderSettings({
  mode = "panel",
  component = "absent",
  update = null,
  clear = null,
  interpolate = false,
  // 搜索索引: what GET /search/index answers, and what the two buttons
  // are answered with. An object with ok: false makes the button fail.
  index = null,
  rebuildIndex = null,
  clearIndex = null,
  // AI 摘要: the model catalogue, the queue's state, the stored
  // summaries with their spend ledger, and whether the "uns summarized" button
  // has anything to hand the host.
  catalog = null,
  summarizeState = null,
  summaries = null,
  pendingIds = [],
  // What POST /summarize/pending answers, when a case needs the host to refuse.
  pendingReply = null,
  // 更新说明: the parsed document, or { ok: false } when the host has no file.
  notes = null,
  // 浏览器组件: what a scan of DSH's home finds. Mutable below, so an
  // install or a borrow can change what the next status read says.
  scan = null,
  // The status payload, when a case needs more than a phase — a borrowed runtime
  // is ready *and* remembers whose tree it is.
  componentInfo = null,
  // 界面语言: which code the document holds, so a saved choice renders as selected.
  uiLang = "auto",
  // 数据目录: what GET /datadir answers. A case that restores leaves the stub
  // holding the new location, the way the host would after the migration.
  dataDirInfo = null,
  // 独立窗口美化: what GET /settings answers for the wallpaper group.
  wallpaper = null,
  // 弹窗: what GET /settings answers for shell.modal (遮罩黑度 lives there).
  modal = null,
  // Milliseconds a settings write takes to answer, so a case can watch what a
  // control does while its previous write is still out.
  putDelay = 0,
} = {}) {
  let componentState = componentInfo ?? { phase: component, version: "1.0.0", installed: component === "ready" };
  let dataDir = dataDirInfo;
  let currentUiLang = uiLang;
  let currentWallpaper = settingsDocument(mode, component, currentUiLang, wallpaper).settings.wallpaper;
  let currentModal = { ...settingsDocument(mode, component, currentUiLang, null).settings.shell.modal, ...(modal ?? {}) };
  // Each write answers with the counter it wrote, the way the host does: a
  // second write that waited for the first therefore cites the newer number,
  // and a case can tell "waited" from "raced" by reading If-Match.
  let settingsRevision = settingsDocument(mode, component, currentUiLang, null).revision;
  const settingsWrite = (call) => {
    if (call.body.ui?.lang) currentUiLang = call.body.ui.lang;
    const doc = settingsDocument(call.body.shell?.open?.mode ?? mode, component, currentUiLang, currentWallpaper);
    doc.settings.shell.modal = { ...currentModal };
    if (call.body.shell?.header) doc.settings.shell.header = call.body.shell.header;
    if (call.body.shell?.modal) {
      Object.assign(doc.settings.shell.modal, call.body.shell.modal);
      currentModal = doc.settings.shell.modal;
    }
    if (call.body.wallpaper) {
      Object.assign(doc.settings.wallpaper, call.body.wallpaper);
      currentWallpaper = doc.settings.wallpaper;
    }
    if (call.body.list) Object.assign(doc.settings.list, call.body.list);
    if (call.body.search) Object.assign(doc.settings.search, call.body.search);
    if (call.body.summary) {
      const patch = call.body.summary;
      doc.settings.summary = {
        ...doc.settings.summary,
        ...patch,
        fields: { ...doc.settings.summary.fields, ...(patch.fields ?? {}) },
      };
    }
    settingsRevision += 1;
    return { ok: true, result: { settings: doc.settings, revision: settingsRevision } };
  };
  const fetchImpl = recordingFetch((call) => {
    const path = call.url.replace(/^.*?\/api/, "");
    if (path === "/settings" && call.method === "GET") {
      const doc = settingsDocument(mode, component, currentUiLang, currentWallpaper);
      doc.settings.shell.modal = { ...currentModal };
      doc.revision = settingsRevision;
      return { ok: true, result: doc };
    }
    if (path === "/settings" && call.method === "PUT") {
      const answer = () => settingsWrite(call);
      if (putDelay > 0) return new Promise((resolve) => setTimeout(() => resolve(answer()), putDelay));
      return answer();
    }
    // AI 字段. The catalogue is what the model `<select>` and the
    // effort `<select>` are both drawn from.
    if (path === "/summarize/catalog") {
      return { ok: true, result: catalog ?? defaultCatalog() };
    }
    if (path === "/summarize/state") {
      return { ok: true, result: summarizeState ?? idleState() };
    }
    if (path === "/summaries") {
      return {
        ok: true,
        result: summaries ?? {
          sessions: {},
          spend: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, runs: 0, failures: 0 },
          pending: pendingIds,
          revision: 2,
          choice: { provider: "", model: "", effort: "" },
        },
      };
    }
    if (path === "/summarize/pending") {
      if (pendingReply) return pendingReply;
      if (pendingIds.length === 0) {
        return { ok: false, code: "nothing-pending", error: "所有会话都已经有描述和标签了" };
      }
      return { ok: true, result: { ...idleState(), running: true, total: pendingIds.length } };
    }
    if (path === "/summarize") {
      return { ok: true, result: { ...idleState(), running: true, total: (call.body?.ids ?? []).length } };
    }
    if (path === "/summarize/cancel") {
      return { ok: true, result: { ...idleState(), cancelled: true } };
    }
    // The component group re-probes on mount and reports the phase upward, so
    // the launch chips have to agree with it — a stub that answered nothing
    // would leave 独立弹窗 disabled however the document was written.
    // 搜索索引: a page that reports the index and has two buttons that change it.
    if (path === "/search/index") {
      return {
        ok: true,
        result: index ?? {
          indexed: 63,
          total: 63,
          pending: 0,
          cache: { enabled: true, bytes: 4096, exists: true, sessions: 63 },
          building: false,
        },
      };
    }
    if (path === "/search/index/rebuild") {
      if (rebuildIndex && rebuildIndex.ok === false) return rebuildIndex;
      return {
        ok: true,
        result: rebuildIndex ?? {
          indexed: 0,
          total: 0,
          pending: 0,
          cache: { enabled: true, bytes: 0, exists: false, sessions: 0 },
          building: false,
        },
      };
    }
    if (path === "/search/index/clear") {
      if (clearIndex && clearIndex.ok === false) return clearIndex;
      return {
        ok: true,
        result: clearIndex ?? {
          freedBytes: 4096,
          sessions: 63,
          indexed: 0,
          total: 0,
          pending: 0,
          cache: { enabled: true, bytes: 0, exists: false, sessions: 0 },
          building: false,
        },
      };
    }
    if (path === "/datadir") {
      return { ok: true, result: dataDir ?? {} };
    }
    if (path === "/datadir/inspect") {
      const target = call.body?.target ?? "";
      return {
        ok: true,
        result: {
          target,
          current: dataDir?.current ?? "C:/data",
          defaultDir: dataDir?.defaultDir ?? target,
          isDefault: target === dataDir?.defaultDir,
          exists: true,
          writable: true,
          sameVolume: true,
          mode: "move",
          sizeBytes: 0,
          currentSizeBytes: dataDir?.sizeBytes ?? 0,
        },
      };
    }
    if (path === "/datadir/migrate") {
      const target = call.body?.target ?? "";
      if (dataDir) dataDir = { ...dataDir, current: target, recorded: target, atDefault: true, restorable: false };
      return {
        ok: true,
        result: { target, mode: call.body?.mode ?? "move", steps: ["copied", "recorded", "signpost-cleared", "pointer", "removed"], revision: 6 },
      };
    }
    if (path === "/component/status") {
      return { ok: true, result: componentState };
    }
    // The manual scan is read-only on the host and never touches the runtimes it
    // finds, so the stub only has to name them.
    if (path === "/component/scan") {
      if (scan && scan.ok === false) return scan;
      return { ok: true, result: { home: "C:/Users/me/.dsh", candidates: [], ...(scan ?? {}) } };
    }
    // Borrowing arrives as an install with a path in the body; a real host then
    // reports ready + borrowed, which is what the page must render.
    if (path === "/component/install") {
      componentState = call.body?.borrowed
        ? { phase: "ready", version: "1.0.0", installed: true, source: "borrowed", sizeBytes: 0, borrowed: call.body.borrowed }
        : { phase: "downloading", version: "1.0.0", installed: false, receivedBytes: 0, totalBytes: 100 };
      return { ok: true, result: componentState };
    }
    if (path === "/component/remove") {
      componentState = { phase: "absent", version: "1.0.0", installed: false };
      return { ok: true, result: componentState };
    }
    // 关于: the update check, the cache clear and the link opener are the only
    // routes on this page that do something irreversible-ish, so the stub
    // answers each one explicitly instead of with a bare {}.
    if (path.startsWith("/update")) {
      return update
        ? { ok: true, result: update }
        : { ok: false, code: "update-unreachable", error: "GitHub is not reachable" };
    }
    if (path === "/cache/clear") {
      const result = clear ?? { freedBytes: 0, caches: [], tmp: { removed: 0, bytes: 0 }, downloads: { removed: 0, bytes: 0 }, staging: { removed: 0, bytes: 0 }, manifest: { removed: 0, bytes: 0 }, skipped: [], tookMs: 1 };
      // A real clear takes the bytes out of the data directory, which is what the
      // 占用大小 row reads back: the stub has to shrink by as much or the refresh
      // has nothing to show.
      if (result.ok !== false && dataDir && typeof dataDir.sizeBytes === "number") {
        dataDir = { ...dataDir, sizeBytes: Math.max(0, dataDir.sizeBytes - (result.freedBytes ?? 0)) };
      }
      return { ok: true, result };
    }
    if (path === "/release-notes") {
      if (notes && notes.ok === false) return notes;
      return { ok: true, result: notes ?? releaseNotes() };
    }
    if (path === "/about/open") {
      return { ok: true, result: { target: call.body?.target ?? "", url: "", opened: true } };
    }
    // 清除数据: the stub answers with the summary a real host returns, so the
    // page's "freed N" line has something to print.
    if (path === "/data/reset") {
      return {
        ok: true,
        result: {
          freedBytes: 2048,
          documents: { tree: { removed: true, bytes: 1024 }, settings: { removed: true, bytes: 1024 } },
          trash: { removed: 2, bytes: 0 },
          quarantine: { removed: 0, bytes: 0 },
          tmp: { removed: 0, bytes: 0 },
          keptLocation: null,
          dataDir: "C:/data",
          tookMs: 3,
        },
      };
    }
    return { ok: true, result: {} };
  });
  const driver = makeReact();
  const { test: api } = loadClientBundle({ fetch: fetchImpl, expose: EXPOSE, react: driver.React });
  const t = (key, vars) => (interpolate ? interpolating(key, vars) : key);
  const tree = await driver.settle(() => page(driver, api, t));
  return { tree, calls: fetchImpl.calls, driver, api, t };
}