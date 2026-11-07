#!/usr/bin/env node
/**
 * 死代码门禁，管两件机器能判准的事。
 *
 * 1) 未使用的 import：一个名字在文件里除了 import 那一行再没出现过。
 * 2) 未使用的 export：一个符号在 src / test / scripts 里没有任何别的文件引用。
 *
 * 不判 src/client：那 31 个分片由 scripts/build-client.mjs 拼成 lib/client.js，
 * 共享同一个作用域，"本文件没有调用点"在那里全是假阳性。判定只看拼接产物之外的
 * 普通模块。
 *
 * 入口符号 name / inject / apply 由 DSH 按名字加载，没有静态引用，写进豁免表。
 *
 * 用法：
 *   node scripts/check-deadcode.mjs          人读输出，有问题退 1
 *   node scripts/check-deadcode.mjs --json   机器可读
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const asJson = process.argv.includes("--json");

/** 宿主按名字取用的入口符号，源码里不会有引用。 */
const ENTRY_EXPORTS = new Set(["name", "inject", "apply", "Config"]);

const problems = [];

/** 注释按长度换成空格：注释里写到的 "import ... from ..." 不算 import。 */
function maskComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (line, lead) => lead + " ".repeat(line.length - lead.length));
}

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", "lib"].includes(entry.name)) continue;
      out.push(...jsFiles(path));
    } else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) {
      out.push(path);
    }
  }
  return out;
}

const rel = (file) => relative(ROOT, file).split("\\").join("/");
const srcFiles = jsFiles(join(ROOT, "src"));
const corpusFiles = [...srcFiles, ...jsFiles(join(ROOT, "test")), ...jsFiles(join(ROOT, "scripts"))];
const texts = new Map(corpusFiles.map((file) => [file, readFileSync(file, "utf8")]));

// ── 规则 A：未被使用的 import ────────────────────────────────────────────────
let importCount = 0;
for (const file of srcFiles) {
  const text = maskComments(texts.get(file));
  for (const match of text.matchAll(/^import\s+([^;]*?)\s+from\s+"[^"]*";?/gm)) {
    const clause = match[1];
    const locals = [];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop();
        if (name) locals.push(name);
      }
    }
    const head = clause.split("{")[0];
    for (const part of head.split(",")) {
      const name = part.trim().replace(/^\*\s*as\s+/, "");
      if (name && name !== "*") locals.push(name);
    }
    const rest = text.replace(match[0], " ".repeat(match[0].length));
    for (const local of locals) {
      importCount += 1;
      const used = new RegExp("\\b" + local.replace(/\$/g, "\\$") + "\\b").test(rest);
      if (!used) problems.push(rel(file) + " imports " + local + ", which the file never uses");
    }
  }
}

// ── 规则 B：没有外部引用的 export ────────────────────────────────────────────
let exportCount = 0;
for (const file of srcFiles) {
  if (rel(file).startsWith("src/client/")) continue;
  const text = maskComments(texts.get(file));
  const names = new Set();
  for (const match of text.matchAll(/^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1]);
  for (const match of text.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1]);
  for (const match of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name && name !== "default") names.add(name);
    }
  }
  for (const name of names) {
    exportCount += 1;
    if (ENTRY_EXPORTS.has(name) && rel(file) === "src/index.js") continue;
    const pattern = new RegExp("\\b" + name.replace(/\$/g, "\\$") + "\\b");
    let referenced = false;
    for (const other of corpusFiles) {
      if (other === file) continue;
      if (pattern.test(texts.get(other))) { referenced = true; break; }
    }
    if (!referenced) problems.push(rel(file) + " exports " + name + ", which nothing outside the file references");
  }
}

// 扫描没读到东西时不能算通过。
if (srcFiles.length < 100) problems.push("only " + srcFiles.length + " source files scanned; the walk is probably broken");
if (importCount < 300) problems.push("only " + importCount + " imported names seen; the import parser is probably broken");

if (asJson) {
  console.log(JSON.stringify({ ok: problems.length === 0, files: srcFiles.length, imports: importCount, exports: exportCount, problems }, null, 2));
} else if (problems.length > 0) {
  for (const problem of problems) console.log("error: " + problem);
  console.log("check-deadcode: " + problems.length + " problem(s) across " + srcFiles.length + " files");
} else {
  console.log("check-deadcode: " + srcFiles.length + " files, " + importCount + " imports, " + exportCount + " exports, nothing unreferenced");
}
process.exit(problems.length === 0 ? 0 : 1);
