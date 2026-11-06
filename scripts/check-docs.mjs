#!/usr/bin/env node
/**
 * check-docs.mjs — documentation must not cite line numbers.
 *
 * Prose that says "see lib/index.js:2184" is wrong the moment anybody inserts a
 * line above it, and nothing catches that: the reader finds a plausible-looking
 * function and trusts it. Symbol references ("lib/index.js 的 handle()") survive
 * every refactor that renames nothing, so the fix is to name the symbol, not the
 * offset.
 *
 * The gate is deliberately narrow. It flags a path immediately followed by a
 * line number, and the parentheses that only carry a bare line number
 * ("（:122-123）", "、:532"); everything else is left to review. --fix rewrites
 * what it can do mechanically — it never invents a symbol name, so a reference
 * that only makes sense with its line number still needs a human sentence.
 *
 * Usage: node scripts/check-docs.mjs [--fix]
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Repository root — scripts/ is always one level below it. */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Files checked in every repository, plus every docs/*.md found on disk. */
const ROOT_FILES = ["README.md", "README.en.md", "CHANGELOG.md"];

/** Source extensions a path reference may point at. */
const EXTENSIONS = "js|mjs|cjs|ts|tsx|jsx|json|css|scss|md|ya?ml|html|sh";

/**
 * A path with a line suffix: lib/index.js:2184, lib/client.js:6975-7100,
 * assets/detached/shim.js:1-25. Group 1 is the bare path.
 */
const PATH_WITH_LINE = new RegExp(
  "((?:[A-Za-z0-9_@.~-]+/)*[A-Za-z0-9_@.~-]+" + "\\.(?:" + EXTENSIONS + ")):(\\d+)(?:[-–]\\d+)?",
  "g",
);

/**
 * A bare line number where a path was given once already: "、:532".
 * Group 0 covers the leading separator so the fix can drop both.
 */
const LIST_CONTINUATION = /、\s*:(?:\d+)(?:[-–]\d+)?/g;

/**
 * The same continuation wrapped in backticks: "（`lib/component/manager.js`、`:532`）".
 * The backticks are markdown, not part of the reference, so the fix drops both.
 */
const BACKTICK_CONTINUATION = /、\s*`\s*:(?:\d+)(?:[-–]\d+)?\s*`/g;

/**
 * A parenthetical that carries nothing but a line number: "（:122-123）",
 * "( :250 附近 )". The trailing word is the author admitting the number is a
 * guess, so it goes with the number.
 */
const BARE_REF = /[（(]\s*`?\s*:(?:\d+)(?:[-–]\d+)?(?:\s*(?:附近|起|一带))?\s*`?\s*[)）]/g;

/** Space that punctuation does not want. */
const SPACE_BEFORE_PUNCTUATION = / +([，。；：、）])/g;
/**
 * Trailing whitespace is only trimmed on a line the fixer already touched: it
 * would otherwise reflow fenced code, where runs of spaces are column
 * alignment, and markdown hard breaks, where two trailing spaces are markup.
 */
const TRAILING_SPACE = /[ \t]+$/;

/**
 * List the documents to check, repository-root files first.
 *
 * @returns {string[]} absolute paths
 */
function documents() {
  const files = ROOT_FILES.map((name) => join(ROOT, name));
  const docs = join(ROOT, "docs");
  let entries = [];
  try {
    entries = readdirSync(docs, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(join(docs, entry.name));
  }
  return files;
}

/** @returns {string} one line of context for the report, trimmed. */
const excerpt = (line) => line.trim().slice(0, 120);

/**
 * Find every line-number reference on one line.
 *
 * @param {string} line source line
 * @returns {boolean} whether the line carries one
 */
function hasReference(line) {
  PATH_WITH_LINE.lastIndex = 0;
  LIST_CONTINUATION.lastIndex = 0;
  BACKTICK_CONTINUATION.lastIndex = 0;
  BARE_REF.lastIndex = 0;
  return (
    PATH_WITH_LINE.test(line) ||
    LIST_CONTINUATION.test(line) ||
    BACKTICK_CONTINUATION.test(line) ||
    BARE_REF.test(line)
  );
}

/**
 * Drop the mechanical line references from one line.
 *
 * @param {string} line source line
 * @returns {string} the line with paths intact and line numbers gone
 */
function stripReferences(line) {
  const fixed = line
    .replace(BACKTICK_CONTINUATION, "")
    .replace(LIST_CONTINUATION, "")
    .replace(PATH_WITH_LINE, "$1")
    .replace(BARE_REF, "");
  if (fixed === line) return line;
  return fixed.replace(SPACE_BEFORE_PUNCTUATION, "$1").replace(TRAILING_SPACE, "");
}

/**
 * Entry point.
 *
 * @returns {number} process exit code
 */
function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--fix" && arg !== "--help" && arg !== "-h");
  if (unknown.length > 0) {
    process.stderr.write("check-docs: unknown argument " + unknown[0] + "\n");
    return 2;
  }
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "node scripts/check-docs.mjs — fail when docs cite a line number.\n\n" +
        "  --fix   remove line numbers mechanically before reporting\n\n" +
        "Exit code: 0 clean, 1 references remain, 2 bad invocation.\n",
    );
    return 0;
  }

  const fix = args.includes("--fix");
  const files = documents();
  let fixedCount = 0;
  let fixedFiles = 0;
  const hits = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    let touched = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (!hasReference(lines[index])) continue;
      if (fix) {
        const fixed = stripReferences(lines[index]);
        if (fixed !== lines[index]) {
          lines[index] = fixed;
          touched += 1;
        }
      }
    }
    if (touched > 0) {
      writeFileSync(file, lines.join("\n"), "utf8");
      fixedCount += touched;
      fixedFiles += 1;
    }
    for (let index = 0; index < lines.length; index += 1) {
      if (!hasReference(lines[index])) continue;
      hits.push({ file, line: index + 1, text: lines[index] });
    }
  }

  if (fix) {
    process.stdout.write(
      "check-docs: removed line numbers from " + fixedCount + " line(s) in " + fixedFiles + " file(s)\n",
    );
  }

  for (const hit of hits) {
    const rel = relative(ROOT, hit.file).replaceAll("\\", "/");
    process.stdout.write(rel + ":" + hit.line + ": line number — " + excerpt(hit.text) + "\n");
  }

  if (hits.length > 0) {
    process.stderr.write("check-docs: " + hits.length + " reference(s) still cite line numbers\n");
    return 1;
  }
  process.stdout.write("check-docs: " + files.length + " document(s), no line-number references\n");
  return 0;
}

process.exitCode = main();
