#!/usr/bin/env node
// i18n 门禁：每门语言一个文件，键集合一致、占位符一致、langCode/aiLang 正确。
// 只读 assets/i18n/*.json，不依赖任何第三方包。
//
// 用法：
//   node scripts/check-i18n.mjs          人读输出，有问题退 1
//   node scripts/check-i18n.mjs --json   机器可读
import fs from "node:fs";
import path from "node:path";

// 语言清单只有一处权威：src/lang.js。这里 import 而不是抄一份 —— 抄一份的话，
// 加一门语言时最容易漏的就是门禁自己，门禁从此只检查旧的七门。
import { LANGS } from "../src/lang.js";

const DIR = "assets/i18n";
// 十门语言都有两节：zh 的 panel 值是键本身（中文原文即译文），结构上与别的语言没有区别。
// 服务端写摘要的提示模板只有中文与英文两套（src/host/summarize.js 与
// src/domain/summaries.js 都是 lang === "en" 的两分支），所以凡是中文词典 ——
// 简体与繁体 —— 都让 AI 讲中文，其余语言一律 "en"。
const AI_ZH = new Set(["zh", "zh-hant"]);

const asJson = process.argv.includes("--json");
const problems = [];
const notes = [];

function fail(lang, kind, detail) {
  problems.push({ lang, kind, detail });
}

function placeholders(text) {
  return (String(text).match(/\{(?:\w+|\d+)\}/g) || []).sort().join(",");
}

if (!fs.existsSync(DIR)) {
  console.error("check-i18n: " + DIR + " does not exist");
  process.exit(1);
}

const onDisk = fs.readdirSync(DIR).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
const unexpected = onDisk.filter((code) => !LANGS.includes(code));
const missing = LANGS.filter((code) => !onDisk.includes(code));
for (const code of unexpected) fail(code, "unexpected-file", code + ".json is not one of the languages src/lang.js lists");
for (const code of missing) fail(code, "missing-file", code + ".json is missing");

const dicts = new Map();
for (const code of LANGS) {
  const file = path.join(DIR, code + ".json");
  if (!fs.existsSync(file)) continue;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(code, "bad-json", file + ": " + error.message);
    continue;
  }
  const settings = raw?.settings;
  const panel = raw?.panel;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    fail(code, "bad-shape", "missing settings object");
    continue;
  }
  if (settings.langCode !== code) fail(code, "bad-lang-code", "settings.langCode is " + JSON.stringify(settings.langCode) + ", expected " + JSON.stringify(code));
  const wantAi = AI_ZH.has(code) ? "zh" : "en";
  if (settings.aiLang !== wantAi) fail(code, "bad-ai-lang", "settings.aiLang is " + JSON.stringify(settings.aiLang) + ", expected " + JSON.stringify(wantAi));
  if (!panel || typeof panel !== "object" || Array.isArray(panel)) {
    fail(code, "bad-shape", "missing panel object");
    continue;
  }
  for (const [section, table] of [["settings", settings], ["panel", panel || {}]]) {
    for (const [key, value] of Object.entries(table)) {
      if (typeof value !== "string") fail(code, "non-string", section + "." + key + " is " + typeof value);
      else if (value.trim() === "") fail(code, "empty-string", section + "." + key + " is empty");
    }
  }
  dicts.set(code, { settings, panel: panel || {} });
  notes.push({ lang: code, settings: Object.keys(settings).length, panel: Object.keys(panel || {}).length, bytes: fs.statSync(file).size });
}

const base = dicts.get("zh");
const ref = dicts.get("en");
if (base) {
  for (const [code, dict] of dicts) {
    if (code === "zh") continue;
    const a = new Set(Object.keys(base.settings));
    const b = new Set(Object.keys(dict.settings));
    for (const key of a) if (!b.has(key)) fail(code, "missing-key", "settings." + key);
    for (const key of b) if (!a.has(key)) fail(code, "extra-key", "settings." + key);
    for (const [key, value] of Object.entries(dict.settings)) {
      const zhValue = base.settings[key];
      if (typeof zhValue !== "string") continue;
      const want = placeholders(zhValue);
      const got = placeholders(value);
      if (want !== got) fail(code, "placeholder-mismatch", "settings." + key + ": expected {" + want + "}, got {" + got + "}");
    }
  }
}
if (ref) {
  const refKeys = new Set(Object.keys(ref.panel));
  for (const [code, dict] of dicts) {
    if (code === "zh") continue;
    const keys = new Set(Object.keys(dict.panel));
    for (const key of refKeys) if (!keys.has(key)) fail(code, "missing-key", "panel." + key);
    for (const key of keys) if (!refKeys.has(key)) fail(code, "extra-key", "panel." + key + " (panel keys must be the Chinese source text)");
    for (const [key, value] of Object.entries(dict.panel)) {
      const want = placeholders(ref.panel[key]);
      const got = placeholders(value);
      if (want !== got) fail(code, "placeholder-mismatch", "panel." + key + ": expected {" + want + "}, got {" + got + "}");
    }
  }
}

// locale/<code>.json 是另一份东西：DSH 插件市场列表里显示的名字与一句话介绍，
// 由宿主读，不进客户端包。它必须和面板词典覆盖同一批语言，否则市场里会出现
// 一门有界面却没有标题的语言（或者反过来，展示一门我们画不出来的语言）。
const META_DIR = "locale";
if (!fs.existsSync(META_DIR)) {
  fail("*", "missing-locale-dir", META_DIR + "/ does not exist");
} else {
  const metaOnDisk = fs.readdirSync(META_DIR).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
  for (const code of LANGS) {
    if (!metaOnDisk.includes(code)) fail(code, "missing-locale-meta", META_DIR + "/" + code + ".json is missing");
  }
  for (const code of metaOnDisk) {
    if (!LANGS.includes(code)) fail(code, "unexpected-locale-meta", META_DIR + "/" + code + ".json is not one of the " + LANGS.length + " supported languages");
  }
  for (const code of LANGS) {
    const file = path.join(META_DIR, code + ".json");
    if (!fs.existsSync(file)) continue;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      fail(code, "bad-json", file + ": " + error.message);
      continue;
    }
    const meta = raw?.meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      fail(code, "bad-shape", file + ": missing meta object");
      continue;
    }
    for (const key of ["title", "description"]) {
      const value = meta[key];
      if (typeof value !== "string" || value.trim() === "") fail(code, "bad-locale-meta", file + ": meta." + key + " is " + JSON.stringify(value));
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ languages: notes, problems }, null, 2));
} else {
  for (const note of notes) console.log("  " + note.lang + ": settings " + note.settings + ", panel " + note.panel + ", " + note.bytes + " B");
  const shown = problems.slice(0, 40);
  for (const p of shown) console.log("  " + p.lang + " " + p.kind + ": " + p.detail);
  if (problems.length > shown.length) console.log("  … " + (problems.length - shown.length) + " more");
  console.log("check-i18n: " + notes.length + "/" + LANGS.length + " language(s), " + problems.length + " problem(s)");
}
process.exit(problems.length === 0 ? 0 : 1);
