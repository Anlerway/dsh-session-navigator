#!/usr/bin/env node
/**
 * 错误码门禁：构造出来的码必须在表里。
 *
 * 负责：扫 src 里每一个错误码的构造点——`codedError(...)` 的参数（含三元两个分支）
 * 和 `error.code = "..."` 赋值——每一个都必须是 `src/errors.js` 的 ERROR_CODES 里
 * 的一行。缺一行的后果是静默的：statusFor 落 500，messageFor 把英文原文抛给中文
 * 窗口，而调用方看不出少了什么。
 *
 * 不负责：表里有没有多余的行。`llm/*`、`gateway/*`、`session/*`、`workspace/*`
 * 这些拼写来自 DSH 与 LLM 层，插件只负责翻译，仓库里不会出现它们的构造点，
 * 所以反向检查必然整片误报。
 *
 * 用法：
 *   node scripts/check-errors.mjs          人读输出，有问题退 1
 *   node scripts/check-errors.mjs --json   机器可读
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_CODES } from "../src/errors.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const asJson = process.argv.includes("--json");

/** 注释按长度替换成空格：行号保持原位，注释里的 `codedError("x")` 不算构造点。 */
function maskComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (line, lead) => lead + " ".repeat(line.length - lead.length));
}

/** 一个字面量是不是错误码的形状：小写 ASCII，允许 / - . 分段，或恰好是表里的一行。 */
function isCode(value) {
  if (value.length === 0 || value.length > 64) return false;
  if (/^[a-z][a-z0-9]*(?:[/.-][A-Za-z0-9_-]+)+$/.test(value)) return true;
  return Object.hasOwn(ERROR_CODES, value);
}

/** 从 `codedError(` 起取到配对的右括号，跨行、跳过字符串。 */
function callSpan(text, start) {
  let depth = 1;
  let index = start;
  while (index < text.length && depth > 0) {
    const ch = text[index];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      index += 1;
      while (index < text.length && text[index] !== quote) {
        if (text[index] === "\\") index += 1;
        index += 1;
      }
    }
    index += 1;
  }
  return index;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", "lib"].includes(entry.name)) continue;
      out.push(...jsFiles(path));
    } else if (entry.name.endsWith(".js")) {
      out.push(path);
    }
  }
  return out;
}

const files = jsFiles(join(ROOT, "src"));
/** @type {Map<string, string>} */
const produced = new Map();
const problems = [];

for (const file of files) {
  const raw = readFileSync(file, "utf8");
  const masked = maskComments(raw);
  const where = relative(ROOT, file).split("\\").join("/");

  let from = 0;
  while (true) {
    const at = masked.indexOf("codedError(", from);
    if (at < 0) break;
    const inner = masked.slice(at, callSpan(masked, at + "codedError(".length));
    for (const match of inner.matchAll(/"([^"\\]*)"|'([^'\\]*)'/g)) {
      const value = match[1] ?? match[2];
      if (!isCode(value)) continue;
      produced.set(value, where + ":" + lineOf(masked, at));
      if (!Object.hasOwn(ERROR_CODES, value)) problems.push(where + ":" + lineOf(masked, at) + " constructs " + value + ", which has no row in src/errors.js");
    }
    from = at + 1;
  }

  for (const match of masked.matchAll(/\.code\s*=\s*"([^"\\]*)"/g)) {
    const value = match[1];
    if (!isCode(value)) continue;
    produced.set(value, where + ":" + lineOf(masked, match.index));
    if (!Object.hasOwn(ERROR_CODES, value)) problems.push(where + ":" + lineOf(masked, match.index) + " assigns " + value + ", which has no row in src/errors.js");
  }
}

// 扫描本身要是匹配不到东西，门禁就变成了绿灯装饰。
if (produced.size < 40) problems.push("the scan found only " + produced.size + " constructed codes; it is probably not reading src/");

if (asJson) {
  console.log(JSON.stringify({ ok: problems.length === 0, codes: [...produced.keys()].sort(), problems }, null, 2));
} else if (problems.length > 0) {
  for (const problem of problems) console.log("error: " + problem);
  console.log("check-errors: " + problems.length + " problem(s), " + produced.size + " code(s) constructed");
} else {
  console.log("check-errors: " + produced.size + " constructed code(s), every one has a row in src/errors.js");
}
process.exit(problems.length === 0 ? 0 : 1);
