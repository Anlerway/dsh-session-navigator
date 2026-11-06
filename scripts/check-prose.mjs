#!/usr/bin/env node
// ── 文风检查 ──
// 扫描 Markdown 里的假对比、递进拔高、预告式开头与套话收尾。
// 规则来源：dev-notes/文档与注释规范.md §3；脚本只报不自动改写。
// 用法：
//   node scripts/check-prose.mjs            扫描仓库内全部 md，有 error 退 1
//   node scripts/check-prose.mjs --strict   把 warning 也当失败
//   node scripts/check-prose.mjs --json     机器可读输出
//   node scripts/check-prose.mjs PATH...    只查指定文件
// 豁免：在出问题的行尾写 <!-- prose-ok: 理由 --> 即可跳过该行。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SKIP_DIRS = new Set(["node_modules", "archive", ".git", "lib/client-src"]);

const RULES = [
  {
    id: "pseudo-contrast",
    level: "error",
    // 只认紧邻的两种形状：不是A，而是B / 不是A，是B / 不是A而是B
    re: /不是[^。！？\n，,]{1,18}(?:，|,)\s*而是|不是[^。！？\n，,]{1,18}(?:，|,)\s*是|不是[^。！？\n，,]{1,18}而是/,
    hint: "先立后破。直接陈述后半句；前半句确实是读者误解时，另起一句写「常见误解：……」",
  },
  {
    id: "escalation",
    level: "error",
    re: /不仅[^。！？\n]{0,30}(更是|而且是|还是)/,
    hint: "递进拔高。删掉前半句，只留事实。",
  },
  {
    id: "teaser",
    level: "error",
    re: /(让我们|下面我们|接下来我们)(看看|来看|深入)|深入探讨|本文将介绍/,
    hint: "预告式开头。直接写内容，小节导航用标题。",
  },
  {
    id: "hype-tail",
    level: "error",
    re: /(彰显|体现了|标志着)[^。！？\n]{0,20}(追求|新时代|里程碑|价值)/,
    hint: "句尾拔高。删掉，保留原因与结果。",
  },
  {
    id: "filler-word",
    level: "warning",
    re: /赋能|闭环|无缝|抓手|颗粒度|至关重要|众所周知/,
    hint: "空泛词。换成具体动作或数字；工程术语（闭环控制等）按上下文保留。",
  },
  {
    id: "contrast-cadence",
    level: "warning",
    // 一行里连用两次以上「而不是」，读起来是排比而不是陈述
    re: /而不是[^\n]*而不是[^\n]*而不是|而不是[^\n]*而不是/,
    hint: "对比句连用。留一处，其余改成并列陈述或拆句。",
  },
  {
    id: "hedge-stack",
    level: "warning",
    re: /(也许|或许|可能)[^。！？\n]{0,6}(可能|会)/,
    hint: "限定叠用。压到一层。",
  },
  {
    id: "wrap-up",
    level: "warning",
    re: /(总而言之|综上所述，让我们|让我们拭目以待)/,
    hint: "套话收尾。留实质结论或下一步。",
  },
  {
    id: "dash-chain",
    level: "warning",
    // 一行内出现两次以上破折号
    re: /——[^\n]*——/,
    hint: "破折号串联。改成分句或列表。",
  },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (extname(name) === ".md") out.push(full);
  }
  return out;
}

function scanFile(file) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const hits = [];
  let inFence = false;

  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    if (/prose-ok\s*:/.test(line)) return;
    if (/^\s*\|?[-:| ]{0,8}\|?\s*$/.test(line)) return; // 表格分隔行

    // 行内代码去掉再匹配，避免命中 `不是 x，是 y` 这类引用
    const stripped = line.replace(/`[^`]*`/g, "");
    for (const rule of RULES) {
      if (rule.re.test(stripped)) {
        hits.push({ line: i + 1, rule: rule.id, level: rule.level, text: line.trim(), hint: rule.hint });
      }
    }
  });
  return hits;
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const strict = args.includes("--strict");
const explicit = args.filter((a) => !a.startsWith("--"));

const files = explicit.length
  ? explicit.map((p) => (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : join(ROOT, p)))
  : walk(ROOT);

const results = [];
for (const file of files) {
  const hits = scanFile(file);
  if (hits.length) results.push({ file: relative(ROOT, file).replace(/\\/g, "/"), hits });
}

const errors = results.reduce((n, r) => n + r.hits.filter((h) => h.level === "error").length, 0);
const warnings = results.reduce((n, r) => n + r.hits.filter((h) => h.level === "warning").length, 0);

if (json) {
  console.log(JSON.stringify({ errors, warnings, results }, null, 2));
} else {
  for (const r of results) {
    console.log(`\n${r.file}`);
    for (const h of r.hits) {
      console.log(`  ${String(h.line).padStart(4)}  ${h.level === "error" ? "✗" : "·"} ${h.rule.padEnd(15)} ${h.text.slice(0, 90)}`);
    }
  }
  console.log(`\n文风检查：${errors} error / ${warnings} warning，扫描 ${files.length} 个文件`);
  if (errors || (strict && warnings)) {
    console.log("改写规则见 dev-notes/文档与注释规范.md §3");
    process.exit(1);
  }
}
