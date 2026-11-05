/**
 * The CSS token bridge — what the stylesheet promises to define.
 *
 * Every colour in this bundle comes from a `--sm-*` variable that the token
 * bridges on `.se-shell`, `.se-set` and `.se-notes` derive from DSH's own
 * `--dsw-alias-*` palette. A name that is *read* but never *defined* is the
 * quiet failure: the declaration is invalid at computed-value time, so the
 * browser falls back to whatever literal sits in the `var()` and the element
 * keeps that colour under every theme.
 *
 * That is exactly what happened to `--sm-surface`: the option list of the AI
 * model `<select>` asked for it with a dark literal as the fallback, so the list
 * was black in the light theme while its text followed `--sm-text` and turned
 * black too — black on black, and nothing in the test suite noticed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "lib", "client.js"), "utf8");

const READ = [...SOURCE.matchAll(/var\((--sm-[a-z0-9-]+)/g)].map((match) => match[1]);
const DEFINED = new Set([...SOURCE.matchAll(/(--sm-[a-z0-9-]+)\s*:/g)].map((match) => match[1]));

test("every --sm-* variable the stylesheet reads is one it defines", () => {
  const missing = [...new Set(READ)].filter((name) => !DEFINED.has(name)).sort();
  assert.deepEqual(missing, [], "undefined token(s) read by the stylesheet: " + missing.join(", "));
});

test("the option list of a select is painted from the theme, not a dark literal", () => {
  const rules = [...SOURCE.matchAll(/(^|\n)(\.[^{]*option[^{]*)\{([^}]*)\}/g)]
    .map((match) => ({ selector: match[2].trim(), body: match[3] }));
  assert.ok(rules.length >= 2, "expected the select option rules to exist");
  for (const rule of rules) {
    assert.match(rule.body, /background:\s*var\(--sm-surface\)/, rule.selector + " paints its background from --sm-surface");
    assert.match(rule.body, /color:\s*var\(--sm-text\)/, rule.selector + " paints its text from --sm-text");
  }
});

test("the token bridges derive a raised surface from the theme", () => {
  const bridges = [...SOURCE.matchAll(/(--sm-surface\s*:[^;]+;)/g)].map((match) => match[1].replace(/\s+/g, " "));
  assert.ok(bridges.length >= 3, "one bridge per root: .se-shell, .se-set, .se-notes");
  for (const line of bridges) {
    assert.match(line, /var\(--dsw-alias-bg-layer-2/, line + " reads DSH's raised-layer alias");
    assert.match(line, /var\(--sm-tint\)/, line + " falls back to the tint, which flips with the text colour");
  }
});
