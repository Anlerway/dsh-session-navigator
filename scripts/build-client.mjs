#!/usr/bin/env node
/**
 * Rebuild lib/client.js from the fragments in lib/client-src/.
 *
 * The client half is one factory the module loader hands to us, so there is no
 * module system to split it into: the fragments are plain byte ranges of the one
 * file, and this script is the only thing that ever writes lib/client.js. It
 * concatenates the fragments named in lib/client-src/manifest.json, in order,
 * prepends the one-line marker below, and performs exactly one transform: a
 * `@inline` marker is replaced by the text of the asset file it names. There is
 * no wrapper and no import, so what a reviewer reads in the fragments is what
 * the browser runs. The marker exists because the failure this file was written
 * to stop is somebody patching the bundle and losing the patch on the next
 * build.
 *
 * Usage:
 *   node scripts/build-client.mjs            write lib/client.js
 *   node scripts/build-client.mjs --check    compare with disk, exit 1 on drift
 *   node scripts/build-client.mjs --list     print the fragment table, write nothing
 *
 * `--check` is the drift guard: it says whether the checked-in bundle still matches
 * its sources, and it is cheap enough to run on every change. When it fails it
 * names the first byte that differs, because "the build is stale" is useless
 * without knowing which fragment moved.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSET_DIR = join(ROOT, "assets");
const SRC_DIR = join(ROOT, "lib", "client-src");
const MANIFEST = join(SRC_DIR, "manifest.json");
const OUTPUT = join(ROOT, "lib", "client.js");

/**
 * The first line of every build. One line, so it survives being pasted into an
 * issue and so `git diff` on a real edit still starts at the edit.
 */
const HEADER = "// GENERATED FILE — edit lib/client-src/ then run `node scripts/build-client.mjs`. Do not edit by hand.\n";

/** `/* @inline <path> *\/ ""` or `/* @inline <dir>/*.json *\/ {}`. */
const INLINE_RE = /\/\* @inline ([A-Za-z0-9_./*-]+) \*\/ (""|\{\})/g;

/** A fragment larger than this means the split has drifted; warn, do not fail. */
const FRAGMENT_WARN_LINES = 2000;

const USAGE = [
  "usage: node scripts/build-client.mjs [--check | --list]",
  "",
  "  (no flag)  concatenate lib/client-src/ into lib/client.js",
  "  --check    rebuild in memory and compare with the file on disk; exit 1 on drift",
  "  --list     print the fragment table (order, lines, bytes) and exit",
].join("\n");

/**
 * Read and validate the ordered fragment list.
 *
 * A manifest that silently drops a file is the worst failure mode this script
 * has — the app would lose code and every test would still pass — so an unlisted
 * fragment, a missing one, or a duplicate is a hard error rather than a warning.
 *
 * @returns {{ file: string, note: string }[]}
 */
function readManifest() {
  const raw = readFileSync(MANIFEST, "utf8");
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch (cause) {
    throw new Error("lib/client-src/manifest.json is not valid JSON: " + cause.message);
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("lib/client-src/manifest.json must be a non-empty array");
  }
  const seen = new Set();
  for (const entry of entries) {
    const file = entry?.file;
    if (typeof file !== "string" || !file.endsWith(".js")) {
      throw new Error("manifest entry without a .js `file`: " + JSON.stringify(entry));
    }
    if (file !== file.replace(/[\\/]/g, "") || file === "." || file === "..") {
      throw new Error("manifest entry must be a bare file name: " + file);
    }
    if (seen.has(file)) throw new Error("manifest lists " + file + " twice");
    seen.add(file);
  }
  const stray = readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".js") && !seen.has(name))
    .sort();
  if (stray.length > 0) {
    throw new Error("lib/client-src/ has fragments the manifest does not list: " + stray.join(", "));
  }
  return entries;
}

/** @param {Buffer} buffer */
function countLines(buffer) {
  let lines = 0;
  for (const byte of buffer) if (byte === 0x0a) lines += 1;
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/** @param {Buffer} buffer */
function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Concatenate the fragments in manifest order.
 *
 * Every fragment is read as bytes and appended as bytes: no decoding, so a
 * fragment cannot acquire or lose a line ending on the way through. The header
 * is the only bytes this script adds, and it is not in any fragment -- a marker
 * that lived in `00-head.js` would be an invitation to delete it.
 *
 * @returns {{ output: Buffer, parts: { file: string, bytes: number, lines: number }[] }}
 */
function build() {
  const entries = readManifest();
  const parts = [];
  const chunks = [];
  for (const entry of entries) {
    let chunk;
    try {
      chunk = readFileSync(join(SRC_DIR, entry.file));
    } catch (cause) {
      throw new Error("cannot read fragment " + entry.file + ": " + cause.message);
    }
    parts.push({ file: entry.file, bytes: chunk.length, lines: countLines(chunk) });
    chunks.push(chunk);
  }
  const output = Buffer.concat([Buffer.from(HEADER, "utf8"), ...chunks]);
  const inlined = Buffer.from(applyInlines(output.toString("utf8")), "utf8");
  assertContract(inlined);
  return { output: inlined, parts };
}

/**
 * Expand every `@inline` marker into the asset it names.
 *
 * Two forms, both of which must sit in expression position so the built file
 * stays valid JavaScript:
 *
 *   const CSS   = /* @inline assets/panel.css *\/ "";
 *   const DICTS = /* @inline assets/i18n/*.json *\/ {};
 *
 * The first inlines one file as a JSON string literal, which is why quotes,
 * backslashes, newlines and `${}` inside the asset need no escaping in the
 * fragment. The second inlines a directory of .json files as one object keyed by
 * file name, so ten languages cost one marker instead of ten.
 *
 * Only `assets/` is readable here. A build script that can inline any path turns
 * a review of lib/client-src/ into a review of the machine.
 *
 * @param {string} text the concatenated fragments
 * @returns {string} the same text with every marker replaced
 * @throws {Error} on an unknown path, a missing asset, or a marker left behind
 */
function applyInlines(text) {
  const expanded = text.replace(INLINE_RE, (whole, spec, placeholder, offset) => {
    const glob = spec.includes("*");
    if (glob !== (placeholder === "{}")) {
      throw new Error('@inline ' + spec + " must end with " + (glob ? '{} for a directory' : '"" for a single file'));
    }
    if (!glob) {
      let bytes;
      try {
        bytes = readAsset(spec);
      } catch (cause) {
        throw new Error("@inline " + spec + " could not be read: " + cause.message);
      }
      return templateLiteral(bytes.toString("utf8"), spec);
    }
    const slash = spec.lastIndexOf("/");
    const dir = resolve(ROOT, spec.slice(0, slash));
    const tail = spec.slice(slash + 1);
    const suffix = tail.slice(tail.lastIndexOf("."));
    if (relative(ASSET_DIR, dir).startsWith("..")) {
      throw new Error("@inline may only read assets/, not " + spec);
    }
    let names;
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(suffix)).sort();
    } catch (cause) {
      throw new Error("@inline " + spec + " could not read " + dir + ": " + cause.message);
    }
    if (names.length === 0) throw new Error("@inline " + spec + " matched no files");
    const entries = names.map((name) => {
      const key = name.slice(0, name.length - suffix.length);
      const raw = readFileSync(join(dir, name), "utf8");
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (cause) {
        throw new Error("@inline " + spec + ": " + name + " is not valid JSON: " + cause.message);
      }
      return jsLiteral(key) + ": " + jsLiteral(parsed);
    });
    // The object closes on the column its marker opened on: the bundle keeps a
    // 4-space body indent, and a brace at column 0 would still parse but reads as
    // a fragment boundary to anyone scanning lib/client.js.
    const indent = lineIndentAt(text, offset);
    const body = entries.map((entry) => indent + "  " + entry).join(",\n");
    return "{\n" + body + "\n" + indent + "}";
  });
  const leftover = expanded.match(/\/\*\s*@inline[^*]*\*\//);
  if (leftover) {
    throw new Error(
      "a fragment still carries the marker " + JSON.stringify(leftover[0]) + '; the marker must be followed by "" (one file) or {} (a directory)',
    );
  }
  return expanded;
}

/**
 * The leading whitespace of the line `offset` falls on.
 *
 * A marker sits at the end of an assignment, so its own column is what the
 * generated object lines up with; reading it back from the text keeps the
 * generator from hard-coding an indent that only one fragment happens to use.
 *
 * @param {string} text
 * @param {number} offset index of the marker's first character
 * @returns {string} spaces or tabs, possibly empty
 */
function lineIndentAt(text, offset) {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const match = /^[ \t]*/.exec(text.slice(start, offset));
  return match ? match[0] : "";
}

/**
 * One file inlined as a template literal, verbatim.
 *
 * The product keeps the sheet one rule per line, which is what makes a diff of
 * lib/client.js readable and what the stylesheet tests query; a JSON string
 * literal would flatten the whole sheet into one line. Verbatim inlining is only
 * safe when the asset contains none of the three sequences that close a template
 * literal early, so this refuses instead of escaping: an escaped sheet is a sheet
 * nobody can grep.
 *
 * @param {string} text
 * @param {string} spec path shown in the error
 * @returns {string}
 */
function templateLiteral(text, spec) {
  const opener = "$" + "{";
  if (text.includes(String.fromCharCode(96)) || text.includes("\\") || text.includes(opener)) {
    throw new Error("@inline " + spec + " contains a backtick, a backslash or a template opener; it cannot be inlined verbatim");
  }
  return String.fromCharCode(96) + text + String.fromCharCode(96);
}

/**
 * A JSON value as a JavaScript literal.
 *
 * JSON is already valid JavaScript for strings, numbers, objects and arrays; the
 * one gap is U+2028 and U+2029, legal in JSON but line terminators to older
 * engines, so they are escaped rather than dropped. Values arrive here either
 * already parsed (a dictionary object) or already a string (one asset), which is
 * why the caller decides and this only serializes.
 *
 * @param {unknown} value
 * @returns {string}
 */
function jsLiteral(value) {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * Read one asset and prove it lives under assets/.
 *
 * @param {string} spec path relative to the repository root
 * @returns {Buffer}
 */
function readAsset(spec) {
  const target = resolve(ROOT, spec);
  if (relative(ASSET_DIR, target).startsWith("..")) {
    throw new Error("@inline may only read assets/, not " + spec);
  }
  return readFileSync(target);
}

/**
 * The two lines the host looks for, checked on every build.
 *
 * A fragment can be reordered or renamed and every test can still pass: the panel
 * is only exercised through the bundle's own exports, so a bundle that no longer
 * announces itself as `dsh-session-navigator` loads as nothing at all. Catching
 * that here costs two regular expressions and turns a silent 空白面板 into a
 * failed build.
 *
 * @param {Buffer} output the assembled bundle
 * @throws {Error} when the loader call or the exported surface is missing
 */
function assertContract(output) {
  const head = output.subarray(0, 4000).toString("utf8");
  if (!/window\.__ModuleLoader__\.load\(\{\s*id:\s*"dsh-session-navigator"/.test(head)) {
    throw new Error(
      "the bundle no longer opens with window.__ModuleLoader__.load({ id: \"dsh-session-navigator\", factory })",
    );
  }
  const tail = output.subarray(Math.max(0, output.length - 4000)).toString("utf8");
  for (const symbol of ["exports.apply", "exports.inject"]) {
    if (!tail.includes(symbol)) throw new Error("the bundle no longer exports " + symbol);
  }
}

/**
 * Where the rebuild and the file on disk stop agreeing.
 *
 * @param {Buffer} expected
 * @param {Buffer} actual
 * @returns {{ offset: number, truncated: boolean }}
 */
function firstDifference(expected, actual) {
  const limit = Math.min(expected.length, actual.length);
  let offset = 0;
  while (offset < limit && expected[offset] === actual[offset]) offset += 1;
  return { offset, truncated: offset === limit };
}

/**
 * @param {Buffer} buffer
 * @param {number} offset
 */
function describeAt(buffer, offset) {
  const line = buffer.subarray(0, offset).toString("latin1").split("\n").length;
  const column = offset - buffer.subarray(0, offset).lastIndexOf(0x0a);
  const window = buffer.subarray(offset, offset + 48).toString("utf8");
  const firstLine = window.split("\n")[0];
  return { line, column, text: firstLine.length < window.length ? firstLine : window };
}

/**
 * @param {{ output: Buffer, parts: { file: string, bytes: number, lines: number }[] }} built
 */
function summarize(built) {
  return [
    "fragments " + built.parts.length,
    "lines " + countLines(built.output),
    "bytes " + built.output.length,
    "sha256 " + sha256(built.output),
  ].join(", ");
}

/**
 * @param {{ file: string, bytes: number, lines: number }[]} parts
 */
function printTable(parts) {
  const width = String(parts.length).length;
  for (const [index, part] of parts.entries()) {
    const order = String(index).padStart(width, "0");
    if (part.lines > FRAGMENT_WARN_LINES) {
      console.warn("  ! " + part.file + " is over " + FRAGMENT_WARN_LINES + " lines");
    }
    console.log("  " + order + "  " + part.file.padEnd(42) + String(part.lines).padStart(5) + " L" + String(part.bytes).padStart(8) + " B");
  }
}

function main(argv) {
  const flags = argv.filter((arg) => arg.startsWith("--"));
  const unknown = flags.filter((flag) => flag !== "--check" && flag !== "--list" && flag !== "--help");
  if (unknown.length > 0) {
    console.error("unknown option: " + unknown.join(" ") + "\n\n" + USAGE);
    return 2;
  }
  if (flags.includes("--help")) {
    console.log(USAGE);
    return 0;
  }

  const built = build();
  const tooBig = built.parts.filter((part) => part.lines > FRAGMENT_WARN_LINES);

  if (flags.includes("--list")) {
    printTable(built.parts);
    console.log(summarize(built));
    return 0;
  }

  if (flags.includes("--check")) {
    let onDisk;
    try {
      onDisk = readFileSync(OUTPUT);
    } catch {
      console.error("lib/client.js is not built yet: it is generated, not tracked.");
      console.error("  run node scripts/build-client.mjs first");
      return 1;
    }
    if (onDisk.equals(built.output)) {
      console.log("lib/client.js matches lib/client-src: " + summarize(built));
      for (const part of tooBig) console.warn("  ! " + part.file + " is over " + FRAGMENT_WARN_LINES + " lines");
      return 0;
    }
    const { offset, truncated } = firstDifference(built.output, onDisk);
    const builtAt = describeAt(built.output, Math.min(offset, Math.max(built.output.length - 1, 0)));
    const diskAt = describeAt(onDisk, Math.min(offset, Math.max(onDisk.length - 1, 0)));
    console.error("lib/client.js is stale: run node scripts/build-client.mjs");
    console.error("  first difference at byte " + offset + (truncated ? " (one file is a prefix of the other)" : ""));
    console.error("  rebuilt  " + built.output.length + " B, line " + builtAt.line + " col " + builtAt.column + ": " + JSON.stringify(builtAt.text));
    console.error("  on disk  " + onDisk.length + " B, line " + diskAt.line + " col " + diskAt.column + ": " + JSON.stringify(diskAt.text));
    return 1;
  }

  let current = null;
  try {
    current = readFileSync(OUTPUT);
  } catch {
    // missing output is fine; it will be created
  }
  if (current !== null && current.equals(built.output)) {
    console.log("lib/client.js unchanged: " + summarize(built));
    return 0;
  }
  writeFileSync(OUTPUT, built.output);
  console.log("wrote lib/client.js: " + summarize(built));
  for (const part of tooBig) console.warn("  ! " + part.file + " is over " + FRAGMENT_WARN_LINES + " lines");
  return 0;
}

/**
 * A bad manifest is an operator mistake, not a crash: print the sentence and exit
 * 1 instead of dumping a stack trace at somebody who only forgot an entry.
 */
try {
  process.exitCode = main(process.argv.slice(2));
} catch (cause) {
  console.error("build-client: " + cause.message);
  process.exitCode = 1;
}
