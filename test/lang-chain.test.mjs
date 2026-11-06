/**
 * The one list of languages, and the four places it has to be true.
 *
 * A language code travels from DSH's locale, through the panel, over the bridge
 * to the Host, into the Electron helper, into the page's URL, and finally into
 * the shim's dictionary. Three of those hops live in files that cannot import
 * one another — the helper runs inside a downloaded Electron runtime, the shim is
 * a plain script in a document, and the panel is a single bundle — so each keeps
 * its own copy of the list. That is the kind of agreement that rots silently: a
 * ninth language added to lib/lang.js and forgotten in the helper would open a
 * window that draws 中文 for a reader of that language, and nothing else would
 * fail.
 *
 * @module test/lang-chain
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { LANGS, normalizeLang } from "../lib/lang.js";
import { normalizeCommand } from "../lib/host/bridge.js";
import { loadClientBundle } from "./support/client-bundle.mjs";

const here = (path) => new URL("../" + path, import.meta.url);
const read = (path) => readFileSync(here(path), "utf8");

/** The codes a file ships, as one sorted list. */
const sorted = (codes) => [...codes].sort();

/** The languages on disk: a dictionary per language, and that is the list. */
const onDisk = sorted(readdirSync(here("assets/i18n")).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)));

/**
 * The `const LANGS = [...]` a self-contained file carries.
 *
 * Read as source, because importing it is exactly what those two files cannot do.
 *
 * @param {string} source
 * @returns {string[]}
 */
function langsOf(source) {
  const match = /const LANGS = \[([^\]]*)\]/.exec(source);
  assert.ok(match, "the file carries its own LANGS list");
  return match[1]
    .split(",")
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

test("every language has a dictionary, and the list is the directory", () => {
  assert.deepEqual(onDisk, sorted(LANGS), "assets/i18n holds exactly LANGS");
  assert.equal(LANGS.length, 10, "ten languages");
});

test("the Electron helper carries the same list", () => {
  assert.deepEqual(sorted(langsOf(read("lib/detached/main.cjs"))), sorted(LANGS));
});

test("the shim carries the same list", () => {
  assert.deepEqual(sorted(langsOf(read("assets/detached/shim.js"))), sorted(LANGS));
});

test("the panel derives the same list from its inlined dictionaries", () => {
  const { test: internals } = loadClientBundle({ expose: ["LANGS", "DICTS"] });
  assert.deepEqual(internals.LANGS, sorted(LANGS), "DICTS keys are the language list");
  assert.deepEqual(sorted(Object.keys(internals.DICTS)), sorted(LANGS));
});

test("a region-tagged code belongs to its base language, and an unknown one to nothing", () => {
  assert.equal(normalizeLang("zh-CN"), "zh");
  assert.equal(normalizeLang("en_GB"), "en");
  assert.equal(normalizeLang("  JA "), "ja");
  assert.equal(normalizeLang("pt-BR"), "pt", "a Brazilian locale draws the Portuguese table");
  // 繁體中文 — the one language with four common codes, none of which DSH itself
  // can send: they come from the plugin's own picker or from a window's URL.
  assert.equal(normalizeLang("zh-TW"), "zh-hant", "Taiwan is the traditional table");
  assert.equal(normalizeLang("zh-Hant"), "zh-hant");
  assert.equal(normalizeLang("zh-HK"), "zh-hant");
  assert.equal(normalizeLang("zh-MO"), "zh-hant");
  assert.equal(normalizeLang("it-IT"), "", "no Italian table, so no Italian claim");
  assert.equal(normalizeLang(""), "");
  assert.equal(normalizeLang(null), "");
  assert.equal(normalizeLang(42), "");
});

test("the bridge lets every supported language through, and drops the rest", () => {
  for (const code of LANGS) {
    assert.equal(normalizeCommand({ kind: "lang-changed", payload: { lang: code } }).payload.lang, code);
  }
  assert.equal(normalizeCommand({ kind: "lang-changed", payload: { lang: "ja-JP" } }).payload.lang, "ja");
  assert.equal(normalizeCommand({ kind: "lang-changed", payload: { lang: "pt-BR" } }).payload.lang, "pt");
  assert.equal(normalizeCommand({ kind: "lang-changed", payload: { lang: "it-IT" } }).payload.lang, undefined);
  assert.equal(normalizeCommand({ kind: "lang-changed", payload: {} }).payload.lang, undefined);
});

test("the Host route and the controller both normalize rather than compare", () => {
  const host = read("lib/index.js");
  assert.match(host, /api\.detached\.open\(\{ lang: normalizeLang\(req\.body\?\.lang\) \|\| "zh" \}\)/);
  const launcher = read("lib/detached/launcher.js");
  assert.match(launcher, /const next = normalizeLang\(request\.lang\) \|\| "zh"/);
});
