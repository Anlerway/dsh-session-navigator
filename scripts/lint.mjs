#!/usr/bin/env node
/**
 * lint.mjs — the repository's only lint gate, and it installs nothing.
 *
 * The plugin ships zero runtime dependencies and has no build step; pulling in
 * an ESLint toolchain (plus config, plugins and their transitive tree) would be
 * a bigger dependency surface than the plugin itself. What actually matters
 * here is small and mechanical: every file parses, nobody reintroduces var,
 * loose equality or console.log into the Node half, and task markers name an
 * owner. That is cheap enough to keep in one file.
 *
 * Two design notes before editing:
 *
 *  - Comments and string/template/regex literals are masked (replaced by
 *    spaces of the same length) before the rules run, so prose such as
 *    "Env var that overrides the data directory" does not trip the var rule,
 *    and a regex source cannot smuggle in a loose comparison. Masking keeps
 *    offsets, so every reported line number points at the real source line.
 *  - The allowlist below matches the offending line's text, not a line
 *    number. Line numbers are exactly what rots; an allowlist keyed on them
 *    would be stale the next time anything above it moves.
 *
 * Usage: node scripts/lint.mjs [--help]
 */

import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Repository root — scripts/ is always one level below it. */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * At most this many node --check children in flight. The work is "parse a
 * file", not CPU aggregation, so one lane per core is plenty.
 */
const CHECK_CONCURRENCY = 8;

/**
 * What gets linted, and with which extension. src/detached/*.cjs is excluded on
 * purpose: those are CommonJS Electron entries loaded by a different runtime,
 * and node --check would judge them under package type "module".
 */
const TARGETS = [
  { dir: "src", extensions: new Set([".js"]) },
  { dir: "test", extensions: new Set([".mjs"]) },
  { dir: "scripts", extensions: new Set([".mjs"]) },
];

/**
 * Violations that are known, deliberate, and not worth a code change in this
 * pass. The line pattern is tested against the trimmed source line; why is the
 * reason a reviewer needs when they wonder why the gate lets these through.
 */
const ALLOWLIST = [
  {
    file: "lib/client.js",
    rule: "no-var",
    line: /^var (?:module|exports) = /,
    why:
      "The browser bundle recreates the CommonJS wrapper (module / exports) that " +
      "the DSH module loader hands every out-of-tree client plugin. The two are " +
      "deliberately hoisted above the export table and copied from the loader " +
      "contract; converting them is a no-op that belongs to a client-bundle " +
      "change, not to this gate.",
  },
];

/**
 * Directories never walked. src/client holds the numbered fragments that the
 * client bundle is concatenated from — individually they are not modules (they
 * open a function and close it many files later), so node --check would fail on
 * them by design. The concatenated result, lib/client.js, is linted instead.
 */
const SKIP_DIRECTORIES = new Set(["node_modules", "client"]);

/** Rules that run over the masked text. */
const RULES = [
  {
    name: "no-var",
    mask: "code",
    description: "block scoping only: var hoists out of its block",
    pattern: /\bvar[ \t]+[A-Za-z_$]/g,
  },
  {
    name: "strict-equality",
    mask: "code",
    description: "loose equality coerces; use === and !==",
    pattern: /(?<![=!<>])==(?!=)|!=(?!=)/g,
  },
  {
    name: "no-console-log",
    mask: "code",
    scope: "src/",
    description: "src/ reports through the host, never to stdout",
    pattern: /console[ \t]*\.[ \t]*log\b/g,
  },
  {
    name: "unowned-task-marker",
    mask: "comments",
    description: "task markers must carry an owner: NAME(owner), NAME[@owner] or NAME: #123",
    pattern: /\b(?:TODO|FIXME|HACK)\b/g,
    /** A marker is owned when the rest of its line names who resolves it. */
    owned(rest) {
      return /^(?:\([^)\n]+\)|\[[^\]\n]+\]|\s*@[A-Za-z0-9_.-]+|\s*:\s*(?:#\d+|https?:\/\/\S+))/u.test(rest);
    },
  },
];

/** Help text; the rule names are interpolated by main() rather than here. */
const HELP_HEAD = "node scripts/lint.mjs — parse every source file and run the house rules.\n\n";
const HELP_TAIL = "\n\n  --help   show this text\n\nExit code: 0 clean, 1 violations, 2 bad invocation.\n";

/**
 * Walk one directory tree and push matching regular files into out.
 *
 * @param {string} dir absolute directory to walk
 * @param {Set<string>} extensions lower-case extensions to keep, dots included
 * @param {string[]} out collector, absolute paths in walk order
 * @returns {void}
 */
function collect(dir, extensions, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) continue;
      collect(full, extensions, out);
    } else if (entry.isFile() && extensions.has(extname(entry.name))) {
      out.push(full);
    }
  }
}

/** Characters after which a slash opens a regex literal rather than dividing. */
const REGEX_AFTER_CHAR = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
/** Words after which a slash opens a regex literal. */
const REGEX_AFTER_WORD = new Set([
  "await", "case", "delete", "do", "else", "in", "instanceof", "new", "of",
  "return", "throw", "typeof", "void", "yield",
]);

/**
 * Is this code point part of an identifier?
 *
 * @param {string | undefined} ch one character
 * @returns {boolean}
 */
const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9_$]/u.test(ch);

/**
 * Replace comments and/or literal contents with spaces, preserving every
 * offset and newline so line numbers stay true.
 *
 * @param {string} text source file
 * @param {{ keepComments: boolean }} options when true, comment text survives
 *   (string literals are still masked) so the task-marker rule can read it
 * @returns {string} masked text of exactly text.length characters
 */
function maskSource(text, { keepComments }) {
  const out = text.split("");
  const n = text.length;
  const blank = (index) => {
    if (index < n && out[index] !== "\n" && out[index] !== "\r") out[index] = " ";
  };
  const blankRange = (from, to) => {
    for (let index = from; index < to; index += 1) blank(index);
  };
  /** Is there an unescaped closing slash on this line? Regex literals cannot span lines. */
  const closingSlash = (from) => {
    for (let index = from + 1; index < n && text[index] !== "\n"; index += 1) {
      if (text[index] === "\\") {
        index += 1;
        continue;
      }
      if (text[index] === "/") return index;
    }
    return -1;
  };
  const canOpenRegex = (lastChar, lastWord) => {
    if (lastChar === "") return true;
    if (REGEX_AFTER_CHAR.has(lastChar)) return true;
    return isWordChar(lastChar) && REGEX_AFTER_WORD.has(lastWord);
  };

  let state = "code";
  /** Brace depth of each open interpolation, innermost last. */
  const interpolation = [];
  let lastChar = "";
  let lastWord = "";
  let index = 0;

  // A shebang line is a comment to every engine; mask it like one.
  if (text.startsWith("#!")) {
    while (index < n && text[index] !== "\n") {
      blank(index);
      index += 1;
    }
  }

  while (index < n) {
    const ch = text[index];

    if (state === "template") {
      if (ch === "\\") {
        blank(index);
        blank(index + 1);
        index += 2;
        continue;
      }
      if (ch === "`") {
        blank(index);
        index += 1;
        state = "code";
        lastChar = "`";
        lastWord = "";
        continue;
      }
      if (ch === "$" && text[index + 1] === "{") {
        blank(index);
        blank(index + 1);
        index += 2;
        interpolation.push(0);
        state = "code";
        lastChar = "{";
        lastWord = "";
        continue;
      }
      blank(index);
      index += 1;
      continue;
    }

    const next = text[index + 1];

    if (ch === "/" && next === "/") {
      const start = index;
      while (index < n && text[index] !== "\n") index += 1;
      if (!keepComments) blankRange(start, index);
      continue;
    }

    if (ch === "/" && next === "*") {
      const start = index;
      index += 2;
      while (index < n && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index = Math.min(index + 2, n);
      if (!keepComments) blankRange(start, index);
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      blank(index);
      index += 1;
      while (index < n && text[index] !== quote) {
        if (text[index] === "\\") {
          blank(index);
          blank(index + 1);
          index += 2;
          continue;
        }
        blank(index);
        index += 1;
      }
      if (index < n) {
        blank(index);
        index += 1;
      }
      lastChar = quote;
      lastWord = "";
      continue;
    }

    if (ch === "`") {
      blank(index);
      index += 1;
      state = "template";
      continue;
    }

    if (ch === "/" && canOpenRegex(lastChar, lastWord)) {
      const close = closingSlash(index);
      if (close !== -1) {
        let end = close + 1;
        while (end < n && /[a-z]/u.test(text[end])) end += 1;
        blankRange(index, end);
        index = end;
        lastChar = "/";
        lastWord = "";
        continue;
      }
    }

    if (ch === "{") {
      if (interpolation.length > 0) interpolation[interpolation.length - 1] += 1;
      lastChar = "{";
      lastWord = "";
      index += 1;
      continue;
    }

    if (ch === "}") {
      if (interpolation.length > 0) {
        const depth = interpolation[interpolation.length - 1];
        if (depth === 0) {
          interpolation.pop();
          blank(index);
          index += 1;
          state = "template";
          continue;
        }
        interpolation[interpolation.length - 1] = depth - 1;
      }
      lastChar = "}";
      lastWord = "";
      index += 1;
      continue;
    }

    if (isWordChar(ch)) {
      lastWord = (isWordChar(text[index - 1]) ? lastWord : "") + ch;
      lastChar = ch;
      index += 1;
      continue;
    }

    if (!/\s/u.test(ch)) {
      lastChar = ch;
      lastWord = "";
    }
    index += 1;
  }

  return out.join("");
}

/**
 * Map a character offset to a 1-based line number.
 *
 * @param {string} text source file
 * @returns {(offset: number) => number} offset to line
 */
function lineLocator(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

/**
 * Run one rule over a masked file.
 *
 * @param {string} file absolute path
 * @param {string[]} lines the original source split on newlines
 * @param {string} masked the mask this rule declared
 * @param {{ name: string, pattern: RegExp, owned?: (rest: string) => boolean }} rule
 * @param {(offset: number) => number} lineOf offset to line number
 * @returns {{ file: string, line: number, rule: string, snippet: string, rawLine: string }[]}
 */
function scanRule(file, lines, masked, rule, lineOf) {
  const hits = [];
  for (const match of masked.matchAll(rule.pattern)) {
    if (rule.owned) {
      const eol = masked.indexOf("\n", match.index);
      const rest = masked.slice(match.index + match[0].length, eol === -1 ? masked.length : eol);
      if (rule.owned(rest)) continue;
    }
    const line = lineOf(match.index);
    const rawLine = lines[line - 1] ?? "";
    hits.push({
      file,
      line,
      rule: rule.name,
      snippet: rawLine.trim().slice(0, 140),
      rawLine: rawLine.trim(),
    });
  }
  return hits;
}

/** ANSI colour escapes; node --check does not emit them, but be safe. */
const ANSI = new RegExp(String.fromCharCode(27) + "\[[0-9;]*m", "gu");

/**
 * Ask Node itself whether a file parses. node --check honours package.json
 * "type", so every src/ .js file is checked as the ESM it actually is.
 *
 * @param {string} file absolute path
 * @returns {Promise<{ file: string, line: number, rule: string, snippet: string, rawLine: string } | null>}
 */
function checkSyntax(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--check", file], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ file, line: 0, rule: "syntax", snippet: error.message, rawLine: "" });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(null);
        return;
      }
      const message = stderr
        .replace(ANSI, "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" ");
      resolve({ file, line: 0, rule: "syntax", snippet: message || "node --check failed", rawLine: "" });
    });
  });
}

/**
 * Run worker over items with a fixed number of concurrent lanes.
 *
 * @template T, R
 * @param {T[]} items work items; results keep their input order
 * @param {number} limit concurrent lanes
 * @param {(item: T) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function pool(items, limit, worker) {
  const results = Array.from({ length: items.length });
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * Entry point.
 *
 * @returns {Promise<number>} process exit code
 */
async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(
      HELP_HEAD +
        "Files: " + TARGETS.map((target) => target.dir + "/**/" + [...target.extensions].join("|")).join(", ") + "\n" +
        "Rules: " + RULES.map((rule) => rule.name).join(", ") + "\n" +
        HELP_TAIL,
    );
    return 0;
  }

  const unknown = process.argv.slice(2).filter((arg) => arg !== "--help" && arg !== "-h");
  if (unknown.length > 0) {
    process.stderr.write("lint: unknown argument " + unknown[0] + "\n");
    return 2;
  }

  const started = Date.now();
  const files = [];
  for (const target of TARGETS) collect(join(ROOT, target.dir), target.extensions, files);

  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    const code = maskSource(text, { keepComments: false });
    const comments = maskSource(text, { keepComments: true });
    const lineOf = lineLocator(text);
    const rel = relative(ROOT, file).replaceAll("\\", "/");
    for (const rule of RULES) {
      if (rule.scope && !rel.startsWith(rule.scope)) continue;
      const hits = scanRule(file, lines, rule.mask === "comments" ? comments : code, rule, lineOf);
      for (const hit of hits) {
        const allowed = ALLOWLIST.some(
          (entry) => entry.file === rel && entry.rule === rule.name && entry.line.test(hit.rawLine),
        );
        if (!allowed) violations.push(hit);
      }
    }
  }

  const syntaxResults = await pool(files, CHECK_CONCURRENCY, checkSyntax);
  for (const result of syntaxResults) {
    if (result) violations.push(result);
  }

  violations.sort((a, b) => {
    const byFile = relative(ROOT, a.file).localeCompare(relative(ROOT, b.file));
    return byFile === 0 ? a.line - b.line : byFile;
  });

  for (const violation of violations) {
    const rel = relative(ROOT, violation.file).replaceAll("\\", "/");
    const where = violation.line > 0 ? rel + ":" + violation.line : rel;
    process.stdout.write(where + ": " + violation.rule + " — " + violation.snippet + "\n");
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (violations.length > 0) {
    process.stderr.write("lint: " + violations.length + " problem(s) in " + files.length + " file(s) (" + seconds + "s)\n");
    return 1;
  }
  process.stdout.write("lint: " + files.length + " files, " + RULES.length + " rules + syntax, 0 problems (" + seconds + "s)\n");
  return 0;
}

process.exitCode = await main();
