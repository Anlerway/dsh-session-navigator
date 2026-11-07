/**
 * 界面语言 — the plugin's own language picker.
 *
 * DSH ships eight languages and the panel speaks ten: 한국어 and 繁體中文 have a
 * dictionary but no host switch, so the plugin carries a setting of its own. The
 * setting is a document field (`ui.lang`), not a browser preference: the panel
 * is drawn inside DSH, and DSH's own language is what "auto" means.
 *
 * Two halves are pinned here — the document (`src/domain/settings.js`) that
 * stores the choice, and the resolution chain in the bundle that reads it:
 *
 *     saved 界面语言  >  DSH's translator  >  whatever the panel was drawing
 *
 * @module test/ui-lang
 */
import test from "node:test";
import assert from "node:assert/strict";

import { loadClientBundle } from "./support/client-bundle.mjs";
import { byClass, collect, renderSettings, textOf } from "./support/settings-harness.mjs";
import { LANGS } from "../src/lang.js";
import {
  UI_LANGS,
  defaultSettings,
  mergeSettings,
  normalizeSettings,
} from "../src/domain/settings.js";

const { test: surface } = loadClientBundle({ expose: ["applyUiLang", "uiLang", "aiLang", "T", "DICTS"] });
const { applyUiLang, uiLang, aiLang, T, DICTS } = surface;

// ── the document ────────────────────────────────────────────────────────────
test("a fresh document follows DSH", () => {
  assert.equal(defaultSettings().ui.lang, "auto", "the shipped answer must be 跟随 DSH");
});

test("the enum is the dictionary list plus auto", () => {
  assert.equal(UI_LANGS[0], "auto");
  assert.deepEqual([...UI_LANGS].slice(1), [...LANGS], "every dictionary must be pickable");
  assert.equal(UI_LANGS.length, LANGS.length + 1);
});

test("a patch sets the choice and normalisation keeps only codes we can draw", () => {
  const merged = mergeSettings(defaultSettings(), { ui: { lang: "ja" } });
  assert.deepEqual(merged.ui, { lang: "ja" });
  assert.equal(normalizeSettings(merged).ui.lang, "ja", "a real code survives a round trip");
  assert.equal(normalizeSettings({ ui: { lang: "it-IT" } }).ui.lang, "auto", "no Italian table, no Italian setting");
  assert.equal(normalizeSettings({ ui: { lang: 42 } }).ui.lang, "auto", "a non-string is not a language");
  assert.equal(normalizeSettings({}).ui.lang, "auto", "a document written before the key existed follows DSH");
});

test("the merge keeps the rest of the document", () => {
  const before = defaultSettings();
  const after = mergeSettings(before, { ui: { lang: "de" } });
  assert.equal(after.list.dateFormat, before.list.dateFormat);
  assert.equal(after.shell.open.mode, before.shell.open.mode);
  assert.deepEqual(before.ui, { lang: "auto" }, "the merge must not mutate the document it was given");
});

// ── the resolution chain ────────────────────────────────────────────────────
test("with nothing saved the panel follows the host, which is 中文 by default", () => {
  assert.equal(applyUiLang(null), "");
  assert.equal(uiLang(), "zh");
  assert.equal(aiLang(), "zh", "a Chinese panel asks the summariser in Chinese");
  assert.equal(T("新建"), "新建", "中文's table repeats the key, so the label comes back unchanged");
});

test("a saved code takes over every label", () => {
  assert.equal(applyUiLang({ ui: { lang: "ja" } }), "ja");
  assert.equal(uiLang(), "ja", "the detached window is opened in the same language");
  assert.equal(aiLang(), "en", "a Japanese panel still asks the summariser for English");
  const key = Object.keys(DICTS.ja.panel)[0];
  assert.equal(T(key), DICTS.ja.panel[key], "T() reads the Japanese table");
  assert.equal(T("新建"), DICTS.ja.panel["新建"]);
});

test("繁體中文 is one table behind four codes", () => {
  assert.equal(applyUiLang({ ui: { lang: "zh-TW" } }), "zh-hant");
  assert.equal(uiLang(), "zh-hant");
  assert.equal(T("详细信息"), "詳細資料");
  // The server's prompt templates have a zh branch, so a traditional panel is a
  // Chinese panel as far as the summariser is concerned.
  assert.equal(aiLang(), "zh");
  assert.equal(applyUiLang({ ui: { lang: "zh-Hant" } }), "zh-hant");
});

test("an unknown code is 跟随 DSH, not a guess", () => {
  assert.equal(applyUiLang({ ui: { lang: "it-IT" } }), "");
  assert.equal(applyUiLang({ ui: { lang: "auto" } }), "");
  assert.equal(applyUiLang({}), "");
});

// ── the picker ──────────────────────────────────────────────────────────────
test("every language names itself in its own words", () => {
  // The names travel in the dictionaries (settings.langName) instead of sitting
  // as literals in the bundle: a picker lists a language the way that language
  // spells itself, and 繁體中文's own name is not a translation of anything.
  const names = LANGS.map((code) => DICTS[code].settings.langName);
  assert.deepEqual(names, [
    "简体中文",
    "English",
    "日本語",
    "한국어",
    "Deutsch",
    "Français",
    "Español",
    "Русский",
    "Português",
    "繁體中文",
  ]);
  assert.equal(new Set(names).size, LANGS.length, "two languages must not share a name");
});

// ── the picker on the settings page ─────────────────────────────────────────
const picker = (tree, t) =>
  collect(tree, (element) => element.type === "select" && element.props?.["aria-label"] === t("setUiLang"))[0];

test("the display group draws 跟随 DSH plus every dictionary in its own words", async () => {
  const { tree, t } = await renderSettings({});
  const select = picker(tree, t);
  assert.ok(select, "the page has a language picker");
  assert.equal(select.props.value, "auto", "a fresh document follows DSH");
  const options = collect(select, (element) => element.type === "option");
  // The order is the dictionary order, which is what the bundle derives: one
  // list, no second copy to drift. It reads alphabetically by code.
  const codes = Object.keys(DICTS).sort();
  assert.deepEqual(options.map((option) => option.props.value), ["auto", ...codes]);
  assert.equal(textOf(options[0]), t("setUiLangAuto"));
  assert.deepEqual(
    options.slice(1).map(textOf),
    codes.map((code) => DICTS[code].settings.langName),
  );
});

test("picking a language writes the document, not the browser", async () => {
  const { tree, calls, t } = await renderSettings({});
  const select = picker(tree, t);
  await select.props.onChange({ target: { value: "ja" } });
  const put = calls.filter((call) => call.method === "PUT" && call.url.includes("/settings")).at(-1);
  assert.deepEqual(put.body, { ui: { lang: "ja" } }, "the patch carries ui.lang and nothing else");
});

test("a saved choice renders as the selected option", async () => {
  const { tree, t } = await renderSettings({ uiLang: "zh-hant" });
  const select = picker(tree, t);
  assert.equal(select.props.value, "zh-hant");
  const [option] = collect(select, (element) => element.type === "option" && element.props.value === "zh-hant");
  assert.equal(textOf(option), "繁體中文");
});
