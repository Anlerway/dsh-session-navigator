/**
 * The languages this plugin speaks, in one place.
 *
 * `assets/i18n/<code>.json` holds one file per language and the client bundle
 * inlines the whole directory (see `src/client/22-locale.js`), so this array
 * is not a preference list: `scripts/check-i18n.mjs` fails when the directory and
 * the array disagree, and `test/lang-chain.test.mjs` pins every copy below.
 *
 * Three runtimes cannot import this module, which is why the copies exist:
 *
 *   src/detached/main.cjs        runs inside a downloaded Electron runtime on its
 *                                own; only that one file travels
 *   assets/detached/shim.js      a plain script served to the window's document
 *   lib/client.js                the bundle's own copy, derived from the inlined
 *                                dictionary keys
 *
 * A language code that is not in `LANGS` is not a language this plugin can draw:
 * `normalizeLang` answers "" for it rather than guessing, so every caller keeps
 * its own default instead of inheriting a dictionary it does not have.
 */

/** Ordered by nothing in particular; the list, not the order, is what matters. */
export const LANGS = ["zh", "en", "ja", "ko", "de", "fr", "es", "ru", "pt", "zh-hant"];

/**
 * A region-tagged code (`zh-CN`, `pt-BR`) belongs to its base language when that
 * base is one we draw in, and to nothing when it is not.
 *
 * @param {unknown} value
 * @returns {string} one of `LANGS`, or "" when the value names no such language
 */
export function normalizeLang(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase().replace(/_/g, "-") : "";
  // 繁體中文 — DSH has no 繁體 switch of its own, so the codes that reach the
  // panel are zh-TW / zh-HK / zh-MO / zh-Hant, from the plugin's own override or
  // from a detached window's URL. They all mean the one traditional table.
  if (/^zh-(hant|tw|hk|mo)(-|$)/.test(raw) && LANGS.includes("zh-hant")) return "zh-hant";
  const base = raw.split("-")[0];
  return LANGS.includes(base) ? base : "";
}
