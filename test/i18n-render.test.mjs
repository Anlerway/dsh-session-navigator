/**
 * Every language, actually drawn.
 *
 * locale-parity.test.mjs holds zh and en against each other; this file is the
 * other half of the promise. Seven translated dictionaries ship, and a table can
 * be complete while never being read: a label that bypasses T(), or a lookup
 * that misses, leaves the user staring at Chinese while every JSON file looks
 * finished. So the assertions here are made against DOM text produced by the
 * real bundle, mounted with the same stub React and fake document
 * test/render-smoke.mjs uses — no jsdom, no production surface widened.
 *
 * panelLang is module state, and the panel sets it from the translator the host
 * hands it (t("langCode")). That is how DSH switches the panel, so that is how
 * this test switches it: mounting with a translator that answers one code. No
 * client source is touched to make it possible.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";

import { loadClientBundle } from "./support/client-bundle.mjs";

// ── stub React ───────────────────────────────────────────────────────────────
// Hooks return their initial values and effects never run, exactly as in
// render-smoke: the panel's loading branch still paints the titlebar, command
// bar and status bar, which is where the labels this test reads live.
class StubComponent {
  constructor(props) {
    this.props = props;
    this.state = {};
  }
  setState(patch) {
    this.state = { ...this.state, ...(typeof patch === "function" ? patch(this.state) : patch) };
  }
}

let hookCalls = 0;
const React = {
  Component: StubComponent,
  Fragment: Symbol("Fragment"),
  // Children go into props.children as well as positionally: PanelBoundary is a
  // class component and renders this.props.children.
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
  useLayoutEffect: () => {
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
  memo: (type) => type,
  useSyncExternalStore: (_subscribe, getSnapshot) => {
    hookCalls += 1;
    return getSnapshot();
  },
};

// ── fake document ───────────────────────────────────────────────────────────
// The panel portals its shell into an overlay root appended to <body>. The
// first mount creates that root; every later mount asks body.contains() whether
// it is still alive, so the stub must answer yes instead of throwing.
const documentStub = {
  querySelector: () => null,
  createElement: () => ({
    setAttribute: () => {},
    appendChild: () => {},
    style: {},
    contains: () => false,
  }),
  head: { appendChild: () => {} },
  body: { appendChild: () => {}, removeChild: () => {}, contains: () => true },
  getElementById: () => null,
  createTextNode: () => ({}),
  documentElement: null,
};

const { bundle, test: api } = loadClientBundle({
  expose: ["DICTS", "LANGS", "EN", "LOCALE_TABLES", "normalizeLang", "T", "panelTable", "uiLang", "aiLang"],
  react: React,
  document: documentStub,
});

const { DICTS, LANGS, EN, LOCALE_TABLES, normalizeLang, T, panelTable, uiLang, aiLang } = api;

// ── render helpers ──────────────────────────────────────────────────────────
/** Hook calls per component, to catch a hook that a branch can skip. */
const hookCounts = new WeakMap();

/**
 * Walk an element tree, calling every function component once.
 *
 * The hook count is compared across renders of the same component: a component
 * that used a different number of hooks under another language would crash in
 * React, not merely paint the old text.
 */
function render(element) {
  if (element === null || element === undefined || element === false || element === true) return null;
  if (Array.isArray(element)) return element.map(render);
  if (typeof element !== "object") return element;
  if (typeof element.type === "function") {
    if (element.type.prototype && typeof element.type.prototype.render === "function") {
      const instance = new element.type(element.props ?? {});
      instance.props = element.props ?? {};
      return render(instance.render());
    }
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
          name + " used " + count + " hooks here but " + seen + " the first time it was rendered",
        );
      }
    }
    return render(out);
  }
  return { type: element.type, props: element.props, children: (element.children ?? []).flatMap(render) };
}

/** Flatten the text under an element, for assertions about labels. */
function textOf(element) {
  if (element === null || element === undefined || element === false || element === true) return "";
  if (typeof element === "string" || typeof element === "number") return String(element);
  if (Array.isArray(element)) return element.map(textOf).join(" ");
  return (element.children ?? []).map(textOf).join(" ");
}

// ── mount the real slot ─────────────────────────────────────────────────────
const registered = [];
const ctx = {
  effect: () => {},
  // A host without a locale service: bind() answers the key, which normalizes
  // to "" and leaves the panel on the language its translator reported.
  locale: { register: () => {}, bind: () => (key) => key },
  slots: {
    inject: (name, fn) => registered.push([name, fn()]),
    register: (meta, component) => ({ name: meta.name, component }),
  },
};
bundle.apply(ctx);
bundle.panelStore.set(true);
const footer = registered.find(([name]) => name === "sidebar.footer.action")[1];

/**
 * The translator DSH would hand the footer: langCode answers the panel's
 * language, the named settings keys come from that language's table. Every
 * other label is drawn by T(), so this mirrors the host without inventing one.
 */
function translatorFor(lang) {
  return (key) => {
    if (key === "langCode") return lang;
    const table = DICTS[lang]?.settings;
    if (table && Object.hasOwn(table, key)) return table[key];
    return EN[key] ?? key;
  };
}

/** Mount the panel once in one language and return its DOM text. */
function mountPanel(lang) {
  const tree = render({ type: footer.component, props: { wide: true, t: translatorFor(lang) } });
  return { tree, text: textOf(tree).replace(/\s+/g, " ").trim() };
}

/** One run of Han characters per match, in document order. */
const hanRuns = (text, minimum = 1) =>
  [...text.matchAll(/[\u4e00-\u9fff]+/g)].map((match) => match[0]).filter((run) => run.length >= minimum);

const placeholdersOf = (value) => [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

// Labels the mounted panel draws without any host data. They are the first
// thing a user sees, so a language that misses them is a language that does not
// actually work.
const LABELS = ["新建", "收藏", "待办", "筛选", "详细信息", "排序"];

// ── 1. the dictionary set ──────────────────────────────────────────────────
test("DICTS carries exactly the languages LANGS names", () => {
  assert.equal(Object.keys(DICTS).length, LANGS.length, "the bundle must inline every shipped dictionary");
  assert.deepEqual(Object.keys(DICTS).sort(), [...LANGS].sort());
  assert.deepEqual(LANGS, Object.keys(DICTS).sort(), "LANGS is the sorted key list of DICTS");
  assert.equal(new Set(LANGS).size, LANGS.length, "no duplicate language code");
});

test("the assets/i18n directory holds the same languages", () => {
  const onDisk = readdirSync(new URL("../assets/i18n", import.meta.url))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5))
    .sort();
  assert.deepEqual(onDisk, [...LANGS].sort(), "a dictionary that ships without a file (or the reverse) is invisible");
});

// ── 2. each table names itself ──────────────────────────────────────────────
test("every table names itself and asks the model for its own language", () => {
  for (const code of LANGS) {
    const settings = DICTS[code].settings;
    assert.equal(settings.langCode, code, code + " settings.langCode must be its own code");
    assert.ok(settings.aiLang === "zh" || settings.aiLang === "en", code + " aiLang must be zh or en");
    // 中文 and 繁體中文 are the two tables that ask the summariser for Chinese:
    // the server's prompt templates only have a zh and an en branch.
    assert.equal(settings.aiLang, code === "zh" || code === "zh-hant" ? "zh" : "en", code + " aiLang");
    assert.equal(LOCALE_TABLES[code], settings, "the locale service receives the same table the panel reads");
  }
  assert.deepEqual(
    LANGS.filter((code) => DICTS[code].settings.aiLang === "zh"),
    ["zh", "zh-hant"],
    "only the Chinese tables may ask the summariser for Chinese",
  );
});

// ── 3. one key set per section ──────────────────────────────────────────────
test("the settings tables all carry one key set", () => {
  const base = Object.keys(EN).sort();
  assert.ok(base.length > 100, "the settings dictionary should still be a dictionary");
  for (const code of LANGS) {
    assert.deepEqual(Object.keys(DICTS[code].settings).sort(), base, code + " settings keys");
  }
});

test("every panel table carries English's key set", () => {
  const base = Object.keys(DICTS.en.panel).sort();
  assert.ok(base.length > 100, "the panel dictionary should still be a dictionary");
  for (const code of LANGS) {
    assert.deepEqual(Object.keys(DICTS[code].panel).sort(), base, code + " panel keys");
    assert.equal(panelTable(code), DICTS[code].panel, code + " panelTable() must return that table");
  }
  // 中文's table is a copy of the source: every value repeats its key, so the
  // Chinese copy lives in zh.json like any translation and can be re-worded
  // there without touching the 465 call sites.
  const zhPanel = DICTS.zh.panel;
  for (const key of Object.keys(zhPanel)) {
    assert.equal(zhPanel[key], key, "zh.panel." + key + " must repeat its key");
  }
});

// ── 4. placeholders are a multiset ──────────────────────────────────────────
test("placeholders survive translation in every table", () => {
  for (const code of LANGS) {
    const settings = DICTS[code].settings;
    for (const key of Object.keys(EN)) {
      assert.deepEqual(
        placeholdersOf(settings[key]),
        placeholdersOf(EN[key]),
        code + ".settings." + key + " interpolates different things",
      );
    }
  }
  for (const code of LANGS) {
    const panel = DICTS[code].panel;
    for (const key of Object.keys(DICTS.en.panel)) {
      assert.deepEqual(
        placeholdersOf(panel[key]),
        placeholdersOf(DICTS.en.panel[key]),
        code + ".panel." + key + " interpolates different things",
      );
    }
  }
  // Without one real {placeholder} the loop above could pass on two empty lists.
  const withPlaceholders = Object.keys(DICTS.en.panel).filter(
    (key) => placeholdersOf(DICTS.en.panel[key]).length > 0,
  );
  assert.ok(withPlaceholders.length > 0, "the panel table must carry at least one interpolated label");
});

// ── 5. the render ───────────────────────────────────────────────────────────
test("each language draws its own labels in the panel", () => {
  const rendered = new Map();
  for (const code of LANGS) {
    const { text } = mountPanel(code);
    rendered.set(code, text);
    assert.equal(uiLang(), code, code + ": the panel must follow the translator's langCode");
    assert.equal(aiLang(), code === "zh" || code === "zh-hant" ? "zh" : "en", code + ": aiLang()");
    assert.ok(text.length > 40, code + ": the panel must actually paint something");
    const table = code === "zh" ? null : DICTS[code].panel;
    for (const label of LABELS) {
      const expected = table ? (table[label] ?? DICTS.en.panel[label]) : label;
      assert.ok(text.includes(expected), code + ": " + label + " should render as " + JSON.stringify(expected));
      if (code !== "zh") {
        // 繁體中文 writes some labels with the characters the simplified key
        // already uses ("收藏", "排序"), so an identical substring proves nothing
        // there; what proves the table was read is T() answering from it.
        if (code !== "zh-hant") {
          assert.ok(!text.includes(label), code + ": " + label + " must not fall back to Chinese");
        }
        assert.equal(T(label), expected, code + ": T() reads the same table the render did");
      }
    }
  }
  assert.equal(new Set(rendered.values()).size, LANGS.length, "each language must produce a different panel");
  // Chinese is still Chinese, English still English — the two ends of the switch.
  assert.ok(rendered.get("zh").includes("详细信息"), "the Chinese panel keeps its Chinese");
  assert.ok(rendered.get("en").includes("Details"), "the English panel reads English");
});

// ── 6. the reverse: no untranslated sentence survives ──────────────────────
test("a translated panel leaves no Chinese sentence behind", () => {
  // A long Han run is the signature of a missed lookup: T() falls back to the
  // Chinese key, which is a sentence-length string. Punctuation alone is not a
  // sentence and must not be flagged.
  assert.deepEqual(hanRuns("这是一整句没有翻译的中文", 4), ["这是一整句没有翻译的中文"], "detector sanity");
  assert.deepEqual(hanRuns("、，。 · ", 4), [], "punctuation alone is allowed");
  // English is the reference language and shares no characters with Chinese:
  // any Han character at all in its panel is a label that never got translated.
  assert.deepEqual(hanRuns(mountPanel("en").text), [], "the English panel must carry no Chinese at all");
  for (const code of LANGS) {
    if (code === "zh") continue;
    const { text } = mountPanel(code);
    const translated = Object.values(DICTS[code].panel ?? {});
    // The tab title and the footer label are the host's names for the plugin:
    // the panel asks the translator it was handed (t("title"), t("navLabel")),
    // so those three strings come from this language's settings table rather
    // than the panel table. They are translated, just not by the panel file.
    const hostNames = ["title", "footerLabel", "navLabel"]
      .map((key) => DICTS[code].settings?.[key])
      .filter((value) => typeof value === "string" && value.length > 0);
    // A run is accounted for only when it is part of a translation in this
    // language's table — a Chinese key is not, because no translation quotes it.
    const leaked = hanRuns(text, 4).filter(
      (run) => !translated.some((value) => value.includes(run)) && !hostNames.includes(run),
    );
    assert.deepEqual(leaked, [], code + ": Chinese text left in the panel: " + JSON.stringify(leaked));
  }
});

// ── 7. the boundary of normalizeLang ───────────────────────────────────────
test("normalizeLang maps a locale onto a language, or onto nothing", () => {
  assert.equal(normalizeLang("zh-CN"), "zh");
  assert.equal(normalizeLang("en_GB"), "en");
  assert.equal(normalizeLang("pt-BR"), "pt");
  assert.equal(normalizeLang("it-IT"), "");
  assert.equal(normalizeLang(""), "");
  assert.equal(normalizeLang(null), "");
  // A locale DSH may hand out that does have a table is not "nothing".
  assert.equal(normalizeLang("FR-ca"), "fr");
  assert.equal(normalizeLang(" zh "), "zh");
  assert.equal(normalizeLang(undefined), "");
});
