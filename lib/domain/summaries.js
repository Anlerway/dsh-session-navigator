/**
 * dsh-session-navigator — AI 字段 (m00531, m01823): what the model is asked for,
 * how the answer is checked, and what is stored.
 *
 * The product of one call is **three fields** — a title, a description and a set
 * of tags — not a paragraph of prose. The user's own words for it (2026-?-?):
 * "总结就是让你总结标题 描述 标签"; "不输出摘要，摘要不是产物". So there is no
 * `text` field anywhere in this module, and the prompt asks for a JSON object
 * rather than a narrative.
 *
 * `summaries.v1.json` is derived in one sense — it can be rebuilt by asking the
 * model again — but it is *not* a cache: the answer cost real tokens and cannot
 * be reproduced byte for byte, so the file is written like a document, never
 * silently discarded. The spend ledger lives in the same file for that reason:
 * it is money already spent, and a rebuild of one field set must not rewind it.
 *
 * Three rules shape what the model sees:
 *
 *   1. Only what the two of them *said*. Thinking is in `turn.reasoning` and
 *      tool traffic in `turn.tools`; this module reads `turn.text` and nothing
 *      else, so neither can leak into a prompt by accident. Injected context
 *      (the fifteen `source.kind` values DSH writes) is already dropped earlier,
 *      by `turnsOf`.
 *   2. No session metadata. The title, note and tags are what we are asking the
 *      model to produce; feeding the old ones in invites it to paraphrase them
 *      instead of reading the conversation.
 *   3. The budget is in characters, not tokens. A character count is exact and
 *      model-independent; a token estimate would be a guess presented as a
 *      number, and the call is capped by `maxTokens` on the way out anyway.
 *
 * @module lib/domain/summaries
 */

import { isAnnotationId } from "./annotations.js";

/** Longest title kept. DSH truncates titles anyway; a title is a label, not a sentence. */
export const TITLE_MAX_LENGTH = 30;

/** Longest description kept: one to three sentences, background → work → outcome. */
export const DESCRIPTION_MAX_LENGTH = 120;

/**
 * Longest single tag. Eight characters holds 会话导出 / 上下文压缩 / 插件设置 —
 * the vocabulary this user actually writes in — while a thirty-character label
 * stops being a tag and becomes a sentence with a # in front.
 */
export const TAG_MAX_LENGTH = 8;

/** Most tags kept. Six is already more than any one filter row wants to show. */
export const TAG_LIMIT = 6;

/** The three fields, in the order the prompt lists them. */
const SUMMARY_FIELDS = ["title", "description", "tags"];

/** Characters of conversation one prompt may carry, head and tail together. */
export const PROMPT_BUDGET_CHARS = 12000;

/** Longest single turn kept verbatim; a pasted 200-line log is not a message. */
const TURN_MAX_LENGTH = 2000;

/**
 * A second attempt carries this line after the conversation. The first answer
 * was not the JSON object we asked for — usually because the model tried to
 * call a tool it does not have, or wrapped the object in prose. Repeating the
 * same request verbatim tends to repeat the same shape, so the retry says what
 * went wrong instead of asking again.
 */
export function retryNudge(lang) {
  return lang === "en"
    ? "Your previous reply was not the JSON object described above. Reply with that one JSON object and nothing else, and do not call any tool."
    : "上一次的回答不是上面要求的那个 JSON 对象。请只回复那一个 JSON 对象，不要调用任何工具。";
}

/** How many existing tags one prompt may list. Enough to steer, short enough to read. */
const VOCABULARY_IN_PROMPT = 40;

/** Above this many pending sessions the run is refused instead of started. */
export const MAX_BATCH = 500;

/**
 * A fresh summaries document.
 *
 * @returns {{ sessions: Record<string, any>, spend: any }}
 */
export function emptySummaries() {
  return { sessions: {}, spend: emptySpend() };
}

/**
 * The cumulative cost of every summary this plugin has ever asked for.
 *
 * `runs` counts attempts, `failures` the subset that produced no answer — a
 * failed call can still be billed for its input tokens, so the token counters
 * move in both cases and only the fields are lost. A retried call therefore
 * shows up as two runs: it was billed twice.
 *
 * @returns {{ inputTokens: number, outputTokens: number, totalTokens: number, cacheReadTokens: number, cacheWriteTokens: number, runs: number, failures: number }}
 */
export function emptySpend() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    runs: 0,
    failures: 0,
  };
}

/**
 * Add one call's usage to the ledger.
 *
 * `totalTokens` is taken from the provider when it says so and summed from the
 * halves otherwise: providers disagree about whether the cached read is inside
 * `inputTokens`, so a locally derived total may not match their arithmetic. The
 * provider's number is the one the invoice uses.
 *
 * @param {any} spend stored ledger (may be missing fields)
 * @param {any} usage `TokenUsage` from the terminal stream, may be null
 * @param {boolean} ok whether fields came back
 * @returns {any} a new ledger
 */
export function addSpend(spend, usage, ok) {
  const base = normalizeSpend(spend);
  const inputTokens = countOf(usage?.inputTokens);
  const outputTokens = countOf(usage?.outputTokens);
  const totalTokens = Number.isFinite(usage?.totalTokens) ? Math.max(0, usage.totalTokens) : inputTokens + outputTokens;
  return {
    inputTokens: base.inputTokens + inputTokens,
    outputTokens: base.outputTokens + outputTokens,
    totalTokens: base.totalTokens + totalTokens,
    cacheReadTokens: base.cacheReadTokens + countOf(usage?.cacheReadTokens),
    cacheWriteTokens: base.cacheWriteTokens + countOf(usage?.cacheWriteTokens),
    runs: base.runs + 1,
    failures: base.failures + (ok === true ? 0 : 1),
  };
}

/**
 * Coerce a stored ledger into the exact shape the client may rely on.
 *
 * @param {any} raw
 * @returns {any}
 */
function normalizeSpend(raw) {
  const out = emptySpend();
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(out)) out[key] = countOf(raw[key]);
  return out;
}

/**
 * Coerce the field switches from settings.
 *
 * Unknown values are false rather than true: turning a field on costs money, so
 * only an explicit `true` may do it.
 *
 * @param {any} raw `settings.summary.fields`
 * @returns {{ title: boolean, description: boolean, tags: boolean }}
 */
function normalizeFieldsSwitch(raw) {
  const out = { title: false, description: false, tags: false };
  if (!raw || typeof raw !== "object") return out;
  for (const field of SUMMARY_FIELDS) out[field] = raw[field] === true;
  return out;
}

/**
 * The fields an answer must contain, in prompt order.
 *
 * @param {any} raw switches
 * @returns {string[]}
 */
export function wantedFields(raw) {
  const switches = normalizeFieldsSwitch(raw);
  return SUMMARY_FIELDS.filter((field) => switches[field]);
}

/**
 * Coerce one stored entry.
 *
 * A record with all three fields empty is dropped: "no fields yet" is a state the
 * panel acts on (补齐标题与标签), while a blank record looks like a model that had
 * nothing to say. Records written before m01823 carried a `text` field; they are
 * dropped for the same reason — there is no longer a place to show prose.
 *
 * @param {any} raw
 * @returns {any|null}
 */
export function normalizeSummaryEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = textOf(raw.title, TITLE_MAX_LENGTH);
  const description = textOf(raw.description, DESCRIPTION_MAX_LENGTH);
  const tags = cleanTags(raw.tags);
  if (title === "" && description === "" && tags.length === 0) return null;
  const model = raw.model && typeof raw.model === "object" ? raw.model : null;
  const applied = raw.applied && typeof raw.applied === "object" ? raw.applied : {};
  return {
    title,
    description,
    tags,
    at: countOf(raw.at),
    // The session's own activityAt when these fields were made. The panel
    // compares it with the row's current activityAt to offer 重新生成 instead of
    // presenting a stale title as news.
    sourceAt: Number.isFinite(raw.sourceAt) ? raw.sourceAt : null,
    model: model
      ? {
          provider: typeof model.provider === "string" ? model.provider : "",
          model: typeof model.model === "string" ? model.model : "",
          effort: typeof model.effort === "string" ? model.effort : "",
        }
      : null,
    tokens: raw.tokens && typeof raw.tokens === "object"
      ? {
          inputTokens: countOf(raw.tokens.inputTokens),
          outputTokens: countOf(raw.tokens.outputTokens),
        }
      : null,
    turns: countOf(raw.turns),
    // Whether the user took each field over. Applying is always a click — a
    // model-written title never renames a session on its own.
    applied: {
      title: applied.title === true,
      description: applied.description === true,
      tags: applied.tags === true,
    },
  };
}

/**
 * Coerce a stored document.
 *
 * @param {any} raw
 * @returns {{ sessions: Record<string, any>, spend: any }}
 */
export function normalizeSummaries(raw) {
  const out = emptySummaries();
  if (!raw || typeof raw !== "object") return out;
  const sessions = raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {};
  for (const [id, entry] of Object.entries(sessions)) {
    const normalized = normalizeSummaryEntry(entry);
    // `isAnnotationId` rather than a bare emptiness check: the document is a
    // plain object keyed by session id, so a key of `__proto__` would answer
    // every lookup and make every session look summarized.
    if (normalized && isAnnotationId(id)) out.sessions[id] = normalized;
  }
  out.spend = normalizeSpend(raw.spend);
  return out;
}

/**
 * Whether a row still needs fields written into it.
 *
 * The rule is deliberately narrow (user instruction, m01898): **only the
 * description and the tags are checked**. A session whose title is missing is
 * not pending, and renaming a session by hand does not make it "done" — a name
 * says nothing about what happened in the conversation.
 *
 * A field counts as present from either source, because the pair of them are
 * the user's own words for the same thing: the description is the model's
 * sentence or the note the user typed, and the tags are the model's labels or
 * the ones the user attached. Hand-curating either half retires that half.
 *
 * Liveness is asked two ways because the two sources know different things:
 * `blank` comes from the log's own first frame and is authoritative when the
 * head was read, while `stats.steps` comes from DSH's projcache and is missing
 * for any session DSH never listed. Treating "no step count" as "no
 * conversation" silently dropped those sessions from the sweep — the user then
 * asked why the button said there was nothing to do. So only a *known* empty
 * session is skipped: `blank === true`, or a step count that is present and
 * zero. An unknown one is queued, and if it turns out empty the run records
 * `nothing-to-summarize` for it and carries on with the rest.
 *
 * Subagents are included: they can be long-running and are exactly the runs a
 * user forgets. They are excluded from the *panel* by default, not from the
 * record.
 *
 * @param {readonly any[]} sessions rows from the reader snapshot
 * @param {any} document the summaries document
 * @param {any} [fields] `settings.summary.fields`
 * @returns {{ ids: string[], total: number, skipped: number }}
 */
export function pendingBreakdown(sessions, document, fields) {
  const stored = document?.sessions && typeof document.sessions === "object" ? document.sessions : {};
  const switches = normalizeFieldsSwitch(fields ?? { title: true, description: true, tags: true });
  // The title is generated when asked for, but it never makes a session
  // pending: 一键补齐 is about the two fields that describe content.
  const wantDescription = switches.description === true;
  const wantTags = switches.tags === true;
  const ids = [];
  let total = 0;
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || typeof session.id !== "string" || session.id === "") continue;
    if (session.trashed === true) continue;
    if (!session.logPath) continue;
    if (session.blank === true) continue;
    const steps = session.stats?.steps;
    const counted = typeof steps === "number" && Number.isFinite(steps) ? steps : null;
    if (counted !== null && counted <= 0 && session.blank !== false) continue;
    total += 1;
    const entry = stored[session.id] ?? null;
    // A field counts as present when *either* author wrote it: the note is the
    // user's own version of a description, and a tag they attached by hand is
    // worth exactly as much as one the model proposed.
    const hasDescription = (typeof entry?.description === "string" && entry.description !== "") || textOf(session.note, 1) !== "";
    const hasTags = (Array.isArray(entry?.tags) && entry.tags.length > 0) || (Array.isArray(session.tags) && session.tags.length > 0);
    const missing = (wantDescription && !hasDescription) || (wantTags && !hasTags);
    if (missing) ids.push(session.id);
  }
  return { ids, total, skipped: total - ids.length };
}

/**
 * The ids that still need fields — the sweep's list.
 *
 * @param {readonly any[]} sessions rows from the reader snapshot
 * @param {any} document the summaries document
 * @param {any} [fields] `settings.summary.fields`
 * @returns {string[]} session ids, in the order the rows arrived
 */
export function pendingSummaryIds(sessions, document, fields) {
  return pendingBreakdown(sessions, document, fields).ids;
}

/**
 * The system prompt: the output contract, in the interface language.
 *
 * One language, one prompt — the Chinese prompt ends with 用中文回答 and the
 * English one with Answer in English. There is no separate "answer language"
 * setting to disagree with the panel the user is reading.
 *
 * Only the fields that were switched on appear in the contract. Listing a field
 * we do not want invites the model to fill it, and that is a field we would then
 * have to throw away.
 *
 * @param {"zh"|"en"} lang
 * @param {any} [fields] switches
 * @returns {string}
 */
export function systemPrompt(lang, fields, vocabulary = []) {
  const wanted = wantedFields(fields ?? { title: true, description: true, tags: true });
  const english = lang === "en";
  const known = (Array.isArray(vocabulary) ? vocabulary : [])
    .filter((tag) => typeof tag === "string" && tag.trim() !== "")
    .slice(0, VOCABULARY_IN_PROMPT);
  const sample = wanted.map((field) => (field === "tags" ? '"tags": ["…", "…"]' : `"${field}": "…"`)).join(", ");
  const rules = [];
  if (wanted.includes("title")) rules.push(CHINESE_TITLE_RULE);
  if (wanted.includes("description")) rules.push(CHINESE_DESCRIPTION_RULE);
  if (wanted.includes("tags")) {
    rules.push(CHINESE_TAGS_RULE);
    // The library first, invention second. The list is capped because a real
    // vocabulary can run to hundreds of rows and the prompt is not a database.
    if (known.length > 0) rules.push(`- 这些标签已经在用，优先从中选：${known.join("、")}。只有当它们都说不清这段对话时，才新建一个。`);
  }

  if (english) {
    const englishRules = [];
    if (wanted.includes("title")) englishRules.push(ENGLISH_TITLE_RULE);
    if (wanted.includes("description")) englishRules.push(ENGLISH_DESCRIPTION_RULE);
    if (wanted.includes("tags")) {
      englishRules.push(ENGLISH_TAGS_RULE);
      if (known.length > 0) englishRules.push(`- These tags are already in use; prefer one of them: ${known.join(", ")}. Invent a new one only when none of them describes this conversation.`);
    }
    return [
      "You are filing an archive entry for a coding-assistant session. Below is the real conversation between a user and the agent.",
      `Extract ${englishList(wanted)}, so the user can recognize the session without opening it.`,
      "",
      "Output ONE JSON object only. No code fences, no explanation:",
      `{${sample}}`,
      "",
      "Field rules:",
      ...englishRules,
      "",
      "Discipline:",
      "- Only facts that appear in the conversation. Never speculate, never add advice, never judge the work.",
      "- Do not narrate tool calls; only when a call itself decided the outcome, carry that conclusion into one clause.",
      "- You have no tools in this call and must never try to use one: output that single JSON object.",
      "",
      "Answer in English.",
    ].join("\n");
  }
  return [
    "你在为一个编程助手的会话整理档案。下面是一段用户和助手之间的真实对话。",
    `请从这段对话里提炼出它的${chineseList(wanted)}，让用户不打开会话也能认出它。`,
    "",
    "只输出一个 JSON 对象，不要代码围栏，不要任何解释文字：",
    `{${sample}}`,
    "",
    "字段要求：",
    ...rules,
    "",
    "写作纪律：",
    "- 只写对话里出现过的事实。不要推测，不要补充建议，不要评价做得好不好。",
    "- 不要叙述工具调用的过程；只有某次调用本身决定了结论时，才用一句话把它带来的结论带出来。",
    "- 这次调用里你没有任何工具可用，也不要去调用工具：只输出那一个 JSON 对象。",
    "",
    "用中文回答。",
  ].join("\n");
}

const CHINESE_TITLE_RULE = `- title：不超过 ${TITLE_MAX_LENGTH} 个字，一句话说清这段会话在做什么、或最后做成了什么。不要引号，不要以句号结尾。`;
const CHINESE_DESCRIPTION_RULE = `- description：1 到 3 句，合计不超过 ${DESCRIPTION_MAX_LENGTH} 个字。先说背景或目标，再说做了什么，最后说结果、或还没做完的部分。`;
const CHINESE_TAGS_RULE = `- tags：3 到 ${TAG_LIMIT} 个，每个不超过 ${TAG_MAX_LENGTH} 个字。写这段会话涉及的技术、模块或任务类型（例如「会话导出」「插件设置」）。不要带 #，不要重复，不要写人名或公司名。`;
const ENGLISH_TITLE_RULE = `- title: at most ${TITLE_MAX_LENGTH} characters, one line saying what the session was doing or what it produced. No quotes, no trailing period.`;
const ENGLISH_DESCRIPTION_RULE = `- description: 1 to 3 sentences, ${DESCRIPTION_MAX_LENGTH} characters total at most. Background or goal first, then what was done, then the result or what is still open.`;
const ENGLISH_TAGS_RULE = `- tags: 3 to ${TAG_LIMIT} of them, each at most ${TAG_MAX_LENGTH} characters. Name the technology, module or kind of task (for example "session export", "plugin settings"). No #, no duplicates, no people or company names.`;

/**
 * `标题、描述和标签` / `标题和标签` — the field list as prose.
 *
 * @param {string[]} wanted
 * @returns {string}
 */
function chineseList(wanted) {
  const names = wanted.map((field) => (field === "title" ? "标题" : field === "description" ? "描述" : "标签"));
  if (names.length <= 1) return names[0] ?? "标题";
  return `${names.slice(0, -1).join("、")}和${names[names.length - 1]}`;
}

/**
 * `a title, a description and tags` — the same list in English.
 *
 * @param {string[]} wanted
 * @returns {string}
 */
function englishList(wanted) {
  const names = wanted.map((field) => (field === "title" ? "a title" : field === "description" ? "a description" : "tags"));
  if (names.length <= 1) return names[0] ?? "a title";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Prefer the tags this library already has.
 *
 * A model that is not shown the vocabulary invents a near-synonym every time
 * ("导出" / "会话导出" / "导出功能"), and a vocabulary of near-synonyms is worse
 * than none: the picker grows a dozen rows that all mean the same thing. So
 * generated tags are snapped onto an existing tag when one means the same thing
 * (same words, ignoring case and surrounding space). A tag with no match is left
 * alone — that is the case where the library genuinely has no word for it, and
 * the caller adds it to the library on apply.
 *
 * @param {string[]} tags tags the model wrote
 * @param {string[]} vocabulary tags already in use
 * @returns {string[]}
 */
export function alignTags(tags, vocabulary) {
  /** @type {Map<string, string>} */
  const known = new Map();
  for (const entry of vocabulary ?? []) {
    if (typeof entry !== "string") continue;
    const clean = entry.trim();
    if (clean === "") continue;
    known.set(clean.toLowerCase(), clean);
  }
  const out = [];
  const seen = new Set();
  for (const tag of tags ?? []) {
    if (typeof tag !== "string") continue;
    const clean = tag.trim();
    if (clean === "") continue;
    const canonical = known.get(clean.toLowerCase()) ?? clean;
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonical);
    if (out.length >= TAG_LIMIT) break;
  }
  return out;
}

/**
 * Fold one generated description into the note the user wrote.
 *
 * Merging appends rather than replaces: the note is the user's own words, and a
 * model's sentence is an addition to them, never a correction. Two paragraphs,
 * so the seam is visible in the pane that renders both.
 *
 * @param {string} note what the session note holds now
 * @param {string} description generated description
 * @returns {string}
 */
export function mergeNote(note, description) {
  const current = typeof note === "string" ? note.trim() : "";
  const addition = typeof description === "string" ? description.trim() : "";
  if (addition === "") return current;
  if (current === "") return addition;
  if (current.includes(addition)) return current;
  return `${current}\n\n${addition}`;
}

/**
 * The subset of generated tags the user picked, in the order they were stored.
 *
 * A selection that names nothing stored is empty, never "everything": the route
 * must not turn a typo into a silent apply of the whole list.
 *
 * @param {string[]} generated tags in the stored record
 * @param {unknown} selection ids the user ticked, or undefined for all
 * @returns {string[]}
 */
export function pickTags(generated, selection) {
  const stored = Array.isArray(generated) ? generated.filter((tag) => typeof tag === "string") : [];
  if (selection === undefined) return [...stored];
  if (!Array.isArray(selection)) return [];
  const wanted = new Set(selection.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase()));
  return stored.filter((tag) => wanted.has(tag.toLowerCase()));
}

/**
 * Turn a conversation into the lines one prompt carries.
 *
 * Head and tail are kept rather than a flat prefix: the beginning says what the
 * session was for, the end says how it turned out, and the middle of a long run
 * is mostly repetition of the same loop. The cut is made on line boundaries so a
 * turn is never presented half-said.
 *
 * Only `turn.text` of a user or assistant turn is read. Thinking lives in
 * `turn.reasoning`, tool calls and their output in `turn.tools`, and neither is
 * touched here (user instruction, m01840: 数据源要去掉思考和工具调用内容).
 *
 * @param {readonly any[]} turns from `turnsOf`
 * @param {{ lang?: "zh"|"en", budget?: number }} [options]
 * @returns {{ text: string, keptTurns: number, totalTurns: number, chars: number, omitted: number }}
 */
export function transcriptOf(turns, options = {}) {
  const lang = options.lang === "en" ? "en" : "zh";
  const budget = Number.isFinite(options.budget) ? Math.max(1000, options.budget) : PROMPT_BUDGET_CHARS;
  const say = lang === "en" ? { user: "User: ", agent: "Agent: " } : { user: "用户：", agent: "助手：" };
  /** @type {string[]} */
  const lines = [];
  let totalTurns = 0;
  for (const turn of Array.isArray(turns) ? turns : []) {
    if (!turn || (turn.role !== "user" && turn.role !== "assistant")) continue;
    const text = clip(String(turn.text ?? "").trim(), TURN_MAX_LENGTH);
    if (text === "") continue;
    totalTurns += 1;
    lines.push(`${turn.role === "user" ? say.user : say.agent}${text}`);
  }
  if (totalTurns === 0) return { text: "", keptTurns: 0, totalTurns: 0, chars: 0, omitted: 0 };

  const joined = lines.join("\n\n");
  if (joined.length <= budget) {
    return { text: joined, keptTurns: totalTurns, totalTurns, chars: joined.length, omitted: 0 };
  }

  // Split the budget between the two ends; the head gets the larger share
  // because the opening prompt states the task, while the tail often ends in
  // an acknowledgement that says little.
  const headBudget = Math.floor(budget * 0.55);
  const tailBudget = budget - headBudget;
  const head = [];
  let headChars = 0;
  let headKept = 0;
  for (const line of lines) {
    if (headChars + line.length > headBudget) break;
    head.push(line);
    headChars += line.length + 2;
    headKept += 1;
  }
  const tail = [];
  let tailChars = 0;
  let tailKept = 0;
  for (let index = lines.length - 1; index >= headKept; index -= 1) {
    const line = lines[index];
    if (tailChars + line.length > tailBudget) break;
    tail.unshift(line);
    tailChars += line.length + 2;
    tailKept += 1;
  }
  const omitted = totalTurns - headKept - tailKept;
  const gap = lang === "en"
    ? `…… ${omitted} messages omitted to fit the prompt budget ……`
    : `…… 为控制长度省略了 ${omitted} 条消息 ……`;
  const text = [...head, gap, ...tail].join("\n\n");
  return { text, keptTurns: headKept + tailKept, totalTurns, chars: text.length, omitted };
}

/**
 * Build the request one answer is made from.
 *
 * The user message is the conversation and nothing else: no existing title, no
 * note, no tags (see rule 2 at the top of this module). A few facts ride along
 * because they are cheap and true — how many messages, how many steps, what day
 * it ended — and they let the description say "over three days" without the
 * model inventing a timeline.
 *
 * @param {{
 *   turns: readonly any[],
 *   facts?: { createdAt?: number|null, activityAt?: number|null, steps?: number },
 *   lang?: "zh"|"en",
 *   budget?: number,
 *   fields?: any,
 *   vocabulary?: string[],
 * }} input
 * @returns {{ system: string, messages: any[], transcript: ReturnType<typeof transcriptOf>, chars: number }}
 */
export function buildMessages(input) {
  const lang = input?.lang === "en" ? "en" : "zh";
  const transcript = transcriptOf(input?.turns ?? [], { lang, budget: input?.budget });
  const facts = input?.facts ?? {};
  const steps = Number(facts.steps ?? 0);
  const when = formatDay(facts.activityAt ?? facts.createdAt ?? null);
  /** @type {string[]} */
  const head = [];
  if (lang === "en") {
    const parts = [`${transcript.totalTurns} messages`];
    if (steps > 0) parts.push(`${steps} steps`);
    if (when) parts.push(`last active ${when}`);
    head.push(`Conversation (${parts.join(", ")}):`);
  } else {
    const parts = [`共 ${transcript.totalTurns} 条消息`];
    if (steps > 0) parts.push(`${steps} 步`);
    if (when) parts.push(`最后活动 ${when}`);
    head.push(`对话（${parts.join("，")}）：`);
  }
  const body = head.join("\n") + "\n\n" + (transcript.text === "" ? (lang === "en" ? "(no text)" : "（没有可读的对话）") : transcript.text);
  return {
    system: systemPrompt(lang, input?.fields, input?.vocabulary),
    messages: [{ role: "user", content: [{ type: "text", text: body }] }],
    transcript,
    chars: body.length,
  };
}

/**
 * Pull the JSON object out of whatever the model wrapped it in.
 *
 * Models put answers behind ``` fences, in front of an apology, or inside a
 * sentence about their own confidence. Rather than reject those, take the
 * outermost braces — there is exactly one object in a well-formed answer, and
 * a malformed one fails `JSON.parse` a moment later anyway.
 *
 * @param {string} text
 * @returns {any|null}
 */
export function extractJsonObject(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return null;
  const unfenced = raw.replace(/```[a-zA-Z]*\s*/g, "").replace(/```/g, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(unfenced.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Check one parsed answer against the fields that were asked for.
 *
 * Over-long values are cut rather than rejected: a 34-character title is a
 * usable title, and paying for a second call to shorten it by four characters
 * is worse than trimming it here. A *missing* requested field is different — it
 * means the model answered a smaller question than the one asked — so it is
 * reported in `missing` for the caller to retry.
 *
 * @param {any} raw parsed JSON
 * @param {any} [fields] switches
 * @returns {{ title: string, description: string, tags: string[], missing: string[] }}
 */
export function normalizeFields(raw, fields) {
  const wanted = wantedFields(fields ?? { title: true, description: true, tags: true });
  const out = { title: "", description: "", tags: [], /** @type {string[]} */ missing: [] };
  if (!raw || typeof raw !== "object") {
    out.missing = wanted.slice();
    return out;
  }
  if (wanted.includes("title")) {
    out.title = textOf(raw.title, TITLE_MAX_LENGTH);
    if (out.title === "") out.missing.push("title");
  }
  if (wanted.includes("description")) {
    out.description = textOf(raw.description, DESCRIPTION_MAX_LENGTH);
    if (out.description === "") out.missing.push("description");
  }
  if (wanted.includes("tags")) {
    out.tags = cleanTags(raw.tags);
    if (out.tags.length === 0) out.missing.push("tags");
  }
  return out;
}

/**
 * Trim, cap and tidy a tag list.
 *
 * Accepts a comma/、/newline separated string too, because that is what a model
 * writes when it ignores the array in the contract. Clipping happens *before*
 * de-duplication: two different long labels that clip to the same eight
 * characters are the same tag to the filter row, and storing both would show a
 * duplicate.
 *
 * @param {any} value
 * @returns {string[]}
 */
export function cleanTags(value) {
  let list = [];
  if (Array.isArray(value)) list = value;
  else if (typeof value === "string") list = value.split(/[,，、;；\n]/);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    // Trim before stripping the hashes: a model that writes "  #导出  " puts the
    // marker after the spaces, and `^#+` would then match nothing.
    const tag = textOf(item.trim().replace(/^#+\s*/, ""), TAG_MAX_LENGTH);
    if (tag === "") continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= TAG_LIMIT) break;
  }
  return out;
}

/**
 * `2024-05-06` — a date in the prompt is context, not precision. The panel
 * formats dates for the user; the model only needs the day.
 *
 * @param {number|null} at epoch ms
 * @returns {string}
 */
function formatDay(at) {
  if (!Number.isFinite(at) || at <= 0) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

/**
 * @param {any} value
 * @param {number} limit
 * @returns {string}
 */
function textOf(value, limit) {
  if (typeof value !== "string") return "";
  return clip(value.trim().replace(/\s+/g, " "), limit);
}

/**
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function clip(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * @param {any} value
 * @returns {number}
 */
function countOf(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
