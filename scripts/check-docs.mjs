#!/usr/bin/env node
/**
 * check-docs.mjs — documentation must not cite line numbers.
 *
 * Prose that says "see src/index.js:2184" is wrong the moment anybody inserts a
 * line above it, and nothing catches that: the reader finds a plausible-looking
 * function and trusts it. Symbol references ("src/index.js 的 handle()") survive
 * every refactor that renames nothing, so the fix is to name the symbol, not the
 * offset.
 *
 * The gate is deliberately narrow. It flags a path immediately followed by a
 * line number, and the parentheses that only carry a bare line number
 * ("（:122-123）", "、:532"); everything else is left to review. --fix rewrites
 * what it can do mechanically — it never invents a symbol name, so a reference
 * that only makes sense with its line number still needs a human sentence.
 *
 * A number in prose drifts the same way. "七十二个测试文件" outlives the
 * seventy-sixth test, and nobody re-reads the sentence when they add one. The
 * quantities below are read out of the repository itself — the test directory,
 * the fragment manifest, ROUTES, ERROR_CODES, LANGS — so a sentence and the
 * tree cannot disagree; --fix rewrites the number in the style it was written
 * (digits stay digits, 汉字 stays 汉字).
 *
 * Usage: node scripts/check-docs.mjs [--fix]
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Repository root — scripts/ is always one level below it. */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Files checked in every repository, plus every docs/*.md found on disk. */
const ROOT_FILES = ["README.md", "README.en.md", "CHANGELOG.md"];

/**
 * The counts a document is allowed to cite, each read from the thing it counts.
 * Importing the modules rather than grepping them keeps the gate honest when a
 * table grows: the number in the sentence follows the table, not the other way.
 */
const { ROUTES } = await import(pathToFileURL(join(ROOT, "src", "index.js")).href);
const { ERROR_CODES } = await import(pathToFileURL(join(ROOT, "src", "errors.js")).href);

/** @returns {number} fragments the client bundle is built from. */
const fragmentCount = () =>
  JSON.parse(readFileSync(join(ROOT, "src", "client", "manifest.json"), "utf8")).length;

/** @returns {number} node:test files the suite runs. */
const testFileCount = () =>
  readdirSync(join(ROOT, "test")).filter((name) => name.endsWith(".test.mjs")).length;

/**
 * One sentence shape plus the number it must carry. The first capture group is
 * the numeral and nothing else, so the fixer can swap it and keep the words
 * around it exactly as the author wrote them.
 */
const QUANTITIES = [
  {
    pattern: /(\d+|[零一二三四五六七八九十百]+)(\s*个\s*)测试文件/g,
    count: testFileCount,
    name: "test files",
  },
  {
    pattern: /(\d+|[零一二三四五六七八九十百]+)(\s*个\s*)分片/g,
    count: fragmentCount,
    name: "fragments",
  },
  {
    // "83 条 HTTP 路由"; bare "九条路由不写信封" counts a subset and stays out.
    pattern: /(\d+|[零一二三四五六七八九十百]+)(\s*条\s*HTTP\s*)路由/g,
    count: () => Object.keys(ROUTES).length,
    name: "routes",
  },
  {
    // "83 条路由的键" writes the same total the other way round.
    pattern: /(\d+|[零一二三四五六七八九十百]+)(\s*条\s*)路由的键/g,
    count: () => Object.keys(ROUTES).length,
    name: "routes",
  },
  {
    pattern: /(\d+|[零一二三四五六七八九十百]+)(\s*个\s*)错误码/g,
    count: () => Object.keys(ERROR_CODES).length,
    name: "error codes",
  },
];

/** Digits and place values of the numerals that turn up in prose. */
const HAN_DIGITS = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const HAN_UNITS = { 百: 100, 十: 10 };

/**
 * Read a numeral: "83" and "八十三" are the same claim.
 *
 * @param {string} text the numeral as written
 * @returns {number} its value, or NaN when the text is not a numeral
 */
function numeralValue(text) {
  if (/^\d+$/.test(text)) return Number(text);
  let total = 0;
  let pending = 0;
  for (const char of text) {
    if (char in HAN_DIGITS) pending = HAN_DIGITS[char];
    else if (char in HAN_UNITS) {
      total += (pending || 1) * HAN_UNITS[char];
      pending = 0;
    } else return Number.NaN;
  }
  return total + pending;
}

/**
 * Write a numeral the way the sentence already writes them.
 *
 * @param {number} value the true count
 * @param {string} like the numeral being replaced
 * @returns {string} digits for a digit numeral, 汉字 for a 汉字 one
 */
function numeralText(value, like) {
  if (/^\d+$/.test(like) || value >= 100) return String(value);
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (value < 10) return digits[value];
  if (value < 20) return "十" + (value === 10 ? "" : digits[value - 10]);
  const tens = digits[Math.floor(value / 10)] + "十";
  return value % 10 === 0 ? tens : tens + digits[value % 10];
}

/**
 * Collect every drifted quantity on one line.
 *
 * @param {string} line source line
 * @param {{name: string, written: string, actual: number}[]} found receiver
 * @returns {void}
 */
function quantityHits(line, found) {
  for (const rule of QUANTITIES) {
    for (const match of line.matchAll(rule.pattern)) {
      const actual = rule.count();
      if (numeralValue(match[1]) !== actual) {
        found.push({ name: rule.name, written: match[0].replace(/\s+/g, " "), actual });
      }
    }
  }
}

/**
 * Rewrite every drifted quantity on one line.
 *
 * @param {string} line source line
 * @returns {string} the corrected line, or the same string when it was right
 */
function fixQuantities(line) {
  let fixed = line;
  for (const rule of QUANTITIES) {
    fixed = fixed.replace(rule.pattern, (whole, numeral) => {
      const actual = rule.count();
      if (numeralValue(numeral) === actual) return whole;
      return numeralText(actual, numeral) + whole.slice(numeral.length);
    });
  }
  return fixed;
}

/** Source extensions a path reference may point at. */
const EXTENSIONS = "js|mjs|cjs|ts|tsx|jsx|json|css|scss|md|ya?ml|html|sh";

/**
 * A path with a line suffix: src/index.js:2184, lib/client.js:6975-7100,
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
 * The same continuation wrapped in backticks: "（`src/component/manager.js`、`:532`）".
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
      "node scripts/check-docs.mjs — fail when a doc cites a line number or a\n" +
        "count that no longer matches the repository.\n\n" +
        "  --fix   remove line numbers and correct counts before reporting\n\n" +
        "Exit code: 0 clean, 1 problems remain, 2 bad invocation.\n",
    );
    return 0;
  }

  const fix = args.includes("--fix");
  const files = documents();
  let fixedCount = 0;
  let fixedFiles = 0;
  const hits = [];
  const quantities = [];

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
    for (let index = 0; index < lines.length; index += 1) {
      if (!fix) continue;
      const corrected = fixQuantities(lines[index]);
      if (corrected !== lines[index]) {
        lines[index] = corrected;
        touched += 1;
      }
    }
    if (touched > 0 && fix) {
      writeFileSync(file, lines.join("\n"), "utf8");
      fixedCount += touched;
      fixedFiles += 1;
    }
    const reread = fix ? lines : text.split("\n");
    for (let index = 0; index < reread.length; index += 1) {
      if (hasReference(reread[index])) hits.push({ file, line: index + 1, text: reread[index] });
    }
    for (let index = 0; index < reread.length; index += 1) {
      const drifted = [];
      quantityHits(reread[index], drifted);
      for (const claim of drifted) quantities.push({ file, line: index + 1, ...claim });
    }
  }

  if (fix) {
    process.stdout.write(
      "check-docs: rewrote " + fixedCount + " line(s) in " + fixedFiles + " file(s)\n",
    );
  }

  for (const hit of hits) {
    const rel = relative(ROOT, hit.file).replaceAll("\\", "/");
    process.stdout.write(rel + ":" + hit.line + ": line number — " + excerpt(hit.text) + "\n");
  }
  for (const claim of quantities) {
    const rel = relative(ROOT, claim.file).replaceAll("\\", "/");
    process.stdout.write(
      rel + ":" + claim.line + ": " + claim.name + " — " + claim.written + " claimed, repository has " + claim.actual + "\n",
    );
  }

  if (hits.length > 0) {
    process.stderr.write("check-docs: " + hits.length + " reference(s) still cite line numbers\n");
  }
  if (quantities.length > 0) {
    process.stderr.write("check-docs: " + quantities.length + " count(s) drifted from the repository\n");
  }
  if (hits.length > 0 || quantities.length > 0) return 1;
  process.stdout.write("check-docs: " + files.length + " document(s), no line numbers, no drifted counts\n");
  return 0;
}

export { fixQuantities, numeralText, numeralValue, quantityHits };

/**
 * Counts the gate compares against, for a caller that wants to build a line
 * that is right today. Nothing in the gate depends on this shape.
 *
 * @returns {{testFiles: number, fragments: number, routes: number, codes: number}}
 */
export function counts() {
  return {
    testFiles: testFileCount(),
    fragments: fragmentCount(),
    routes: Object.keys(ROUTES).length,
    codes: Object.keys(ERROR_CODES).length,
  };
}

// Only a direct `node scripts/check-docs.mjs` runs the gate: a test imports
// the helpers above and must not have the repository checked under it.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main();
}
