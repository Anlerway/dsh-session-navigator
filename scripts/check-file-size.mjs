#!/usr/bin/env node
/**
 * 文件行数预算门禁。
 *
 * 负责：给仓库里每个手写代码文件设一个行数上限，超限即失败；同时检查豁免表
 * 里有没有已经缩回上限以内、却还挂在表上的条目——豁免表只许变短。
 * 不负责：代码风格（scripts/lint.mjs）、文档引用（scripts/check-docs.mjs）。
 *
 * 上限取 1000 行，与 dsh-ops 的 scripts/check-file-size.mjs 同一个数字：跨千行
 * 的文件没人当整体读，测试也只能挑几处断言行，改动风险随行数线性上升。
 *
 * 用法：
 *   node scripts/check-file-size.mjs          报告并判定
 *   node scripts/check-file-size.mjs --json   机器可读输出
 *   node scripts/check-file-size.mjs --limit 800
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_LIMIT = 1000;
const FRAGMENT_LIMIT = 2000;

/**
 * 豁免表：路径 → { limit, reason, until }。
 * until 写清哪个阶段会消掉这条豁免；没有 until 的条目视为长期豁免，需要说明缘由。
 * 规则只减不增：文件回到 DEFAULT_LIMIT 以内后，条目必须一起删掉。
 */
const EXEMPTIONS = new Map([
  ["lib/client.js", {
    limit: Infinity,
    reason: "由 src/client/ 的分片拼接生成的产物，不手写（分片数见 manifest）",
    until: "长期（产物）",
  }],
  ["test/render-smoke.mjs", {
    limit: 1700,
    reason: "单文件冒烟脚本，不导出符号、不被任何人 import",
    until: "长期（脚本）",
  }],
]);

const CODE_DIRS = ["src", "test", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "client", ".git"]);

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const limitFlag = args.indexOf("--limit");
const baseLimit = limitFlag === -1 ? DEFAULT_LIMIT : Number(args[limitFlag + 1]);

if (!Number.isFinite(baseLimit) || baseLimit < 100) {
  console.error("check-file-size: --limit needs a number >= 100");
  process.exit(2);
}

/** 收集待检查文件：只算 .js / .mjs / .cjs，跳过产物与依赖。 */
function collect(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (!SKIP_DIRS.has(name)) collect(full, out);
      continue;
    }
    if (!/\.(m?js|cjs)$/.test(name)) continue;
    out.push(full);
  }
}

const files = [];
for (const dir of CODE_DIRS) collect(join(ROOT, dir), files);

/** 数行数，末尾没有换行的最后一行也算一行（与 wc -l 不同，这里不丢行）。 */
function countLines(path) {
  const text = readFileSync(path, "utf8");
  if (!text) return 0;
  let lines = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1;
  if (text.charCodeAt(text.length - 1) !== 10) lines += 1;
  return lines;
}

const over = [];
const stale = [];
let scanned = 0;

for (const full of files) {
  const path = relative(ROOT, full).split(sep).join("/");
  const lines = countLines(full);
  scanned += 1;
  const exempt = EXEMPTIONS.get(path);
  const limit = exempt ? exempt.limit : baseLimit;
  if (lines > limit) {
    over.push({
      path,
      lines,
      limit,
      reason: exempt ? exempt.reason : `超过 ${limit} 行预算`,
      until: exempt?.until ?? "应拆分",
    });
  } else if (exempt && lines <= baseLimit && exempt.limit !== Infinity) {
    stale.push({ path, lines, limit: exempt.limit, reason: exempt.reason });
  }
}

// 分片另有 2000 行上限：分片是拼接单位，粗到读不动就失去拆分意义。
const fragments = [];
const fragDir = join(ROOT, "src", "client");
try {
  for (const name of readdirSync(fragDir)) {
    if (!name.endsWith(".js")) continue;
    const lines = countLines(join(fragDir, name));
    fragments.push({ path: `src/client/${name}`, lines });
    if (lines > FRAGMENT_LIMIT) {
      over.push({
        path: `src/client/${name}`,
        lines,
        limit: FRAGMENT_LIMIT,
        reason: "分片过大",
        until: `拆到 ${FRAGMENT_LIMIT} 行以内`,
      });
    }
  }
} catch {
  // 没有 src/client 目录的检出（例如 git archive 的子集）不影响本门禁。
}

if (asJson) {
  console.log(JSON.stringify({
    ok: over.length === 0 && stale.length === 0,
    scanned,
    baseLimit,
    fragments: fragments.length,
    over,
    stale,
  }, null, 2));
} else {
  for (const item of over) {
    console.log(`  OVER  ${item.path}  ${item.lines} 行 > ${item.limit}`);
    console.log(`        理由：${item.reason}；去路：${item.until}`);
  }
  for (const item of stale) {
    console.log(`  STALE ${item.path}  已回到 ${item.lines} 行（豁免上限 ${item.limit}），删除该条豁免`);
  }
  const biggest = [...files]
    .map((f) => ({ path: relative(ROOT, f).split(sep).join("/"), lines: countLines(f) }))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 3);
  console.log(
    `check-file-size: ${scanned} file(s), ${fragments.length} fragment(s), limit ${baseLimit}, ` +
    `${over.length} over, ${stale.length} stale (top: ${biggest.map((b) => `${b.path} ${b.lines}`).join(", ")})`,
  );
}

process.exit(over.length === 0 && stale.length === 0 ? 0 : 1);
