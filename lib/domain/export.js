/**
 * dsh-session-navigator — export one session as a conversation.
 *
 * A session log is the *truth* but not a conversation: it is a JSONL stream of
 * events (turns, steps, tool calls, tool results, compaction markers, surface
 * replacements), and several of them carry chat content in different places.
 * Four things make this module non-trivial, and the first three were wrong in
 * the version that shipped 1.0.4:
 *
 *   1. **Message shape.** Chat content does not live on `event.data.content`.
 *      A `user/message` carries it in `data.content` (a block list), but an
 *      `assistant/message` carries it in `data.message.content`, and a
 *      `tool/result` in `data.message.content` too. Reading the wrong field
 *      exported every user turn and *zero* assistant turns — the whole agent
 *      half of the session was silently missing.
 *
 *   2. **Tool calls are their own events.** A step logs the assistant message
 *      (text / reasoning / tool-call blocks), then a `tool/call` event that
 *      repeats the call with its arguments, then a `tool/result` that carries
 *      the output. A tool call belongs to the turn that made it, so both the
 *      block and the event are folded into that turn — deduplicated by call id,
 *      because they describe the same call.
 *
 *   3. **Not every `user/message` is the user.** DSH injects its own context as
 *      user messages: runtime context, time context, skill catalogues, goal
 *      reminders, approval notices, tool-job lists. In one real log only 635 of
 *      2098 user messages were typed by a human. `data.source.kind` says which
 *      is which; everything that is not `user` is counted and left out, so the
 *      export reads as a conversation instead of as a context dump.
 *
 *   4. **Surface operations.** A replaced event is not deleted from the log; a
 *      later event masks it with `surfaceOp`, and the span it covers can be
 *      thousands of events long (DSH condenses a long session into a checkpoint
 *      and marks everything it condensed as replaced). Honouring that mask by
 *      dropping the span is the other way the export came back incomplete — one
 *      real session lost 5 of its 26 human messages and 900 of its 1393 tool
 *      calls that way. So the mask is *reported*, not applied: the span stays,
 *      a one-line note marks where the original record gives way to DSH's
 *      summary, and the checkpoint that replaced it is exported as a checkpoint.
 *
 * The rule that follows from all four: **nothing that was said is dropped.**
 * What is dropped is what nobody said — injected context, system prompts, tool
 * manifests — and every count of it is printed in the document header so the
 * reader can check the arithmetic instead of trusting it.
 *
 * Pure on the event array: the caller does the I/O, so this is directly
 * testable and the route layer stays a thin adapter.
 */

/**
 * @typedef {object} ExportOptions
 * @property {"md" | "jsonl"} format
 * @property {boolean} [includeTools] tool calls in Markdown; on unless `false`
 * @property {boolean} [includeToolResults] tool output in Markdown; on unless `false`
 * @property {number} [toolResultLimit] characters of one result kept in Markdown
 * @property {boolean} [includeReasoning] reasoning blocks; off unless `true`
 */

/** The longest seq range one surface operation may claim. */
const MAX_MASKED_RANGE = 100_000;

/** Characters of one tool result kept in a Markdown export. */
const MD_RESULT_LIMIT = 4_000;

/** `data.source.kind` of a message a human actually typed. */
const HUMAN_SOURCE = "user";

/** `data.source.kind` values that carry DSH's condensation of earlier turns. */
const CHECKPOINT_SOURCES = new Set(["compact-checkpoint"]);

/** Surface operations that hide what they name. */
const MASKING_OPS = new Set(["replace", "hide", "mask", "delete"]);

/**
 * Which seqs are still visible after every surface operation.
 *
 * Two shapes are accepted because both exist in the wild:
 *
 *   `{op: "replace", startSeq, endSeq}` — what DSH v4 logs write. An inclusive
 *   range, usually one seq: the system prompt replacing its previous version.
 *   `{kind: "replace" | "hide", ranges: [{from, to}], seqs: [...]}` — the shape
 *   older code and its tests assume, kept so a log written by either build is
 *   read the same way.
 *
 * A later op can mask an earlier one, so the result is simply the union. The
 * ranges are not trusted: `to` is capped, because a log that says
 * `{"from": 1, "to": 1000000000}` used to iterate a billion times on the
 * request thread and build a billion-entry Set.
 *
 * @param {any[]} events
 * @returns {Set<number>} seqs a later replace-style op overwrote
 */
export function maskedSeqs(events) {
  /** @type {Set<number>} */
  const masked = new Set();

  const addRange = (from, to) => {
    const start = Number(from);
    if (!Number.isFinite(start)) return;
    // A range that names only its start hides that one seq. Requiring both ends
    // computed NaN and `continue`d, so the mask quietly did nothing.
    const last = Number.isFinite(Number(to)) ? Number(to) : start;
    if (last < start) return;
    const end = Math.min(last, start + MAX_MASKED_RANGE - 1);
    for (let seq = start; seq <= end; seq += 1) masked.add(seq);
  };

  const addSeqs = (seqs) => {
    if (!Array.isArray(seqs)) return;
    for (const seq of seqs) {
      const value = Number(seq);
      if (Number.isFinite(value)) masked.add(value);
    }
  };

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const op = event.surfaceOp;
    // A string op (`"append"`) is not a mask. Only objects are read.
    if (op && typeof op === "object") {
      const kind = op.kind ?? op.type ?? op.op;
      if (MASKING_OPS.has(kind)) {
        if (op.startSeq !== undefined || op.endSeq !== undefined) addRange(op.startSeq, op.endSeq);
        if (Array.isArray(op.ranges)) {
          for (const range of op.ranges) addRange(range?.from ?? range?.start ?? range?.startSeq, range?.to ?? range?.end ?? range?.endSeq);
        }
        addSeqs(op.seqs);
      }
    }
  }
  return masked;
}

/**
 * Seqs that compaction removed from the model's context.
 *
 * Reported, not applied: a pruned event is still part of what was said, and
 * hiding it is how an export ends up missing whole stretches of a long session.
 * The count goes into the export header so the reader knows the log had been
 * compacted.
 *
 * @param {any[]} events
 * @returns {Set<number>}
 */
export function prunedSeqs(events) {
  /** @type {Set<number>} */
  const pruned = new Set();
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type !== "compaction/prune" && event.type !== "compaction/summary") continue;
    const data = event.data ?? {};
    if (Array.isArray(data.shadowedSeqs)) {
      for (const seq of data.shadowedSeqs) if (Number.isFinite(Number(seq))) pruned.add(Number(seq));
    }
    const range = data.shadowedRange;
    if (range && typeof range === "object") {
      const from = Number(range.startSeq ?? range.from ?? range.start ?? NaN);
      const to = Number(range.endSeq ?? range.to ?? range.end ?? NaN);
      if (Number.isFinite(from) && Number.isFinite(to) && to >= from) {
        for (let seq = from; seq <= Math.min(to, from + MAX_MASKED_RANGE - 1); seq += 1) pruned.add(seq);
      }
    }
  }
  return pruned;
}

/**
 * Flatten one content block list into `{ text, reasoning, tools }`.
 *
 * @param {any} content
 * @returns {{ text: string, reasoning: string, tools: any[] }}
 */
export function blocksOf(content) {
  const parts = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
  let text = "";
  let reasoning = "";
  const tools = [];
  for (const block of parts) {
    if (!block || typeof block !== "object") continue;
    const type = block.type ?? block.kind ?? "";
    if (type === "text" || type === "output_text") text += String(block.text ?? "");
    else if (type === "reasoning" || type === "thinking") reasoning += String(block.text ?? block.reasoning ?? "");
    else if (type === "tool-call" || type === "tool_use" || type === "tool") tools.push(block);
    // Everything else used to be dropped, and a message whose only blocks were
    // images, tool results or a type this build does not know then vanished from
    // both formats entirely. Whatever the block can say in words is kept, and an
    // image leaves a marker so the turn is still visibly there.
    else if (typeof block.text === "string") text += block.text;
    else if (type === "image" || type === "input_image") text += "![图片]";
  }
  return { text, reasoning, tools };
}

/**
 * The content blocks of one message event, whichever field this build wrote.
 *
 * @param {any} data
 * @returns {any[]}
 */
function contentBlocksOf(data) {
  const content = data?.message?.content ?? data?.content ?? data?.text ?? null;
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  return [];
}

/**
 * The wall-clock stamp of one event.
 *
 * Real logs use `time`; the tests use `at`. Both are milliseconds.
 *
 * @param {any} event
 * @returns {number | null}
 */
function atOf(event) {
  for (const candidate of [event?.time, event?.at]) if (Number.isFinite(candidate)) return Number(candidate);
  return null;
}

/**
 * A tool call's arguments, parsed when the log stored JSON.
 *
 * `tool/call.arguments` is always a JSON *string*; the block inside an assistant
 * message carries the same string. Keeping the raw text as well means a log that
 * holds malformed JSON still exports what it holds.
 *
 * @param {any} raw
 * @returns {{ raw: any, value: any }}
 */
function argumentsOf(raw) {
  if (typeof raw !== "string") return { raw, value: raw ?? null };
  try {
    return { raw, value: JSON.parse(raw) };
  } catch {
    return { raw, value: raw };
  }
}

/**
 * A short human label for one tool call, taken from its arguments.
 *
 * A blocked list reading `工具调用 · ops_bash` forty times in a row says nothing
 * about what the agent was doing; the command or path does.
 *
 * @param {any} args
 * @param {number} [limit]
 * @returns {string}
 */
export function toolHint(args, limit = 72) {
  const value = args && typeof args === "object" ? args : null;
  if (!value) return "";
  for (const key of ["description", "command", "path", "file_path", "pattern", "query", "prompt", "url", "name"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim() !== "") return clip(candidate, limit);
  }
  for (const candidate of Object.values(value)) {
    if (typeof candidate === "string" && candidate.trim() !== "") return clip(candidate, limit);
  }
  return "";
}

/**
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function clip(text, limit) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  // By code point: `.slice` can split a surrogate pair and render as garbage.
  return points.length <= limit ? flat : `${points.slice(0, limit).join("")}…`;
}

/**
 * @param {string} role
 * @param {number | null} at
 * @param {number | null} seq
 * @returns {any}
 */
function blankTurn(role, at, seq) {
  return { role, at, seq, text: "", reasoning: "", images: 0, parts: [], tools: [] };
}

/**
 * Turn the event stream into the conversation, with the counters that let the
 * export say what it left out.
 *
 * Consecutive assistant messages belong to one turn: a step that only calls a
 * tool has no words of its own, and cutting a turn at every step turned one
 * answer into a dozen empty headers. A turn ends at the next user message.
 *
 * @param {any[]} events
 * @returns {{
 *   turns: any[],
 *   omitted: { system: number, developer: number, context: number, contextKinds: [string, number][], orphanResults: number },
 *   compacted: number,
 *   replaced: number,
 *   checkpoints: number,
 * }}
 */
export function collectTurns(events) {
  const masked = maskedSeqs(events);
  // Reported only: `masked` filters nothing out (see the module
  // comment) — it just marks where to write the "replaced by a summary" note.
  const pruned = prunedSeqs(events);
  /** @type {any[]} */
  const turns = [];
  /** @type {Map<string, any>} */
  const byCallId = new Map();
  /** @type {Map<string, number>} */
  const contextKinds = new Map();
  const omitted = { system: 0, developer: 0, context: 0, contextKinds: /** @type {[string, number][]} */ ([]), orphanResults: 0 };
  let compacted = 0;
  let replaced = 0;
  let checkpoints = 0;
  /** True while walking a span a later surface operation replaced. */
  let inReplaced = false;
  /** @type {any} */
  let current = null;

  const startAssistant = (at, seq) => {
    const turn = blankTurn("assistant", at, seq);
    turns.push(turn);
    current = turn;
    return turn;
  };
  const assistantTurn = (at, seq) => (current && current.role === "assistant" ? current : startAssistant(at, seq));
  const addText = (turn, text) => {
    const value = typeof text === "string" ? text : "";
    if (value.trim() === "") return;
    turn.parts.push({ kind: "text", text: value });
  };
  const addTool = (turn, source) => {
    const callId = source?.callId ?? source?.id ?? source?.toolCallId ?? null;
    if (typeof callId === "string" && callId !== "" && byCallId.has(callId)) return byCallId.get(callId);
    const args = argumentsOf(source?.arguments ?? source?.input ?? null);
    const entry = {
      kind: "tool",
      callId: typeof callId === "string" && callId !== "" ? callId : null,
      name: String(source?.name ?? source?.toolName ?? "tool"),
      raw: args.raw,
      args: args.value,
      result: null,
      isError: false,
    };
    turn.parts.push(entry);
    turn.tools.push(entry);
    if (entry.callId) byCallId.set(entry.callId, entry);
    return entry;
  };

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const seq = Number.isFinite(event.seq) ? Number(event.seq) : null;
    // A replaced event was condensed into a later checkpoint; it was not
    // deleted, and it is still part of what was said. It stays in the export,
    // behind one note that marks where the original record gives way to DSH's
    // compression of it — dropping it is how an export of a long session came
    // back with two thirds of its conversation missing.
    if (seq !== null && masked.has(seq)) {
      replaced += 1;
      if (!inReplaced) {
        inReplaced = true;
        current = null;
        const note = blankTurn("note", atOf(event), seq);
        note.parts.push({ kind: "text", text: "以下片段后来被上下文压缩摘要替换；原始记录仍保留在此。" });
        turns.push(note);
      }
    } else {
      inReplaced = false;
    }
    if (seq !== null && pruned.has(seq)) compacted += 1;

    const type = event.type ?? "";
    const data = event.data ?? {};
    const at = atOf(event);

    if (type === "user/message") {
      const kind = typeof data.source?.kind === "string" ? data.source.kind : "";
      // A checkpoint is DSH's own condensation of everything before it. Machine
      // written, but it is the only remaining record of that span in the
      // model's context, so it is exported and labelled as what it is.
      if (CHECKPOINT_SOURCES.has(kind)) {
        const turn = blankTurn("checkpoint", at, seq);
        const text = blocksOf(contentBlocksOf(data)).text;
        if (text.trim() !== "") turn.parts.push({ kind: "text", text });
        turns.push(turn);
        current = null;
        checkpoints += 1;
        continue;
      }
      // No `source` at all means an older log, where every user message was the
      // user. Everything else that is not `user` is DSH talking to itself:
      // runtime context, timestamps, skill catalogues, approval notices.
      if (kind !== "" && kind !== HUMAN_SOURCE) {
        omitted.context += 1;
        contextKinds.set(kind, (contextKinds.get(kind) ?? 0) + 1);
        continue;
      }
      const blocks = contentBlocksOf(data);
      const turn = blankTurn("user", at, seq);
      const { text } = blocksOf(blocks);
      for (const block of blocks) if (block && typeof block === "object" && (block.type === "image" || block.type === "input_image")) turn.images += 1;
      if (text.trim() !== "") turn.parts.push({ kind: "text", text });
      turns.push(turn);
      current = null;
      continue;
    }

    if (type === "assistant/message") {
      const turn = assistantTurn(at, seq);
      for (const block of contentBlocksOf(data)) {
        if (!block || typeof block !== "object") continue;
        const kind = block.type ?? block.kind ?? "";
        if (kind === "text" || kind === "output_text") addText(turn, String(block.text ?? ""));
        else if (kind === "reasoning" || kind === "thinking") turn.reasoning += String(block.text ?? block.reasoning ?? "");
        else if (kind === "tool-call" || kind === "tool_use" || kind === "tool") addTool(turn, block);
        else if (typeof block.text === "string") addText(turn, block.text);
        else if (kind === "image" || kind === "input_image") turn.images += 1;
      }
      continue;
    }

    // The same call, once as a block (above) and once as its own event: the
    // event is where a build that streams blocks leaves the final arguments.
    if (type === "tool/call") {
      addTool(assistantTurn(at, seq), data);
      continue;
    }

    if (type === "tool/result") {
      const callId = data.toolCallId ?? data.callId ?? data.message?.toolCallId ?? null;
      const entry = typeof callId === "string" ? byCallId.get(callId) : null;
      const result = blocksOf(contentBlocksOf(data)).text;
      if (entry) {
        entry.result = result;
        entry.isError = data.message?.isError === true || data.isError === true;
      } else if (result.trim() !== "") {
        // A result whose call was pruned away or written by another build: keep
        // the output on a turn of its own rather than dropping real content.
        const turn = assistantTurn(at, seq);
        turn.parts.push({ kind: "tool", callId: null, name: "(未知工具)", raw: null, args: null, result, isError: data.message?.isError === true });
        turn.tools.push(turn.parts[turn.parts.length - 1]);
        omitted.orphanResults += 1;
      }
      continue;
    }

    if (type === "system/message") omitted.system += 1;
    else if (type === "developer/message") omitted.developer += 1;
  }

  for (const turn of turns) {
    turn.text = turn.parts
      .filter((part) => part.kind === "text")
      .map((part) => part.text)
      .join("\n\n");
    turn.reasoning = turn.reasoning.trim();
  }
  omitted.contextKinds = [...contextKinds.entries()].sort((a, b) => b[1] - a[1]);
  return { turns, omitted, compacted, replaced, checkpoints };
}

/**
 * Turn the event stream into ordered turns.
 *
 * @param {any[]} events
 * @returns {any[]}
 */
export function turnsOf(events) {
  return collectTurns(events).turns;
}

/**
 * @param {any} value
 * @returns {string}
 */
function stamp(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The facts a reader needs in order to trust the rest of the document.
 *
 * An export that silently drops 1400 injected context messages looks identical
 * to one that lost them to a bug; saying the count out loud is what makes the
 * difference checkable.
 *
 * @param {{ system: number, developer: number, context: number, contextKinds: [string, number][], orphanResults: number }} omitted
 * @param {number} compacted
 * @param {number} replaced
 * @param {number} checkpoints
 * @returns {string[]}
 */
function omissionFacts(omitted, compacted, replaced, checkpoints) {
  const facts = [];
  if (omitted.context > 0) {
    const kinds = omitted.contextKinds
      .slice(0, 6)
      .map(([kind, count]) => `${kind} ${count}`)
      .join("、");
    facts.push(`- 已省略上下文注入：${omitted.context} 条（${kinds}${omitted.contextKinds.length > 6 ? "、…" : ""}）`);
  }
  if (omitted.system > 0) facts.push(`- 已省略系统提示：${omitted.system} 条`);
  if (omitted.developer > 0) facts.push(`- 已省略工具清单变更：${omitted.developer} 条`);
  if (checkpoints > 0) facts.push(`- 上下文压缩摘要：${checkpoints} 段（由 DSH 生成，非用户原话）`);
  if (replaced > 0) facts.push(`- 被压缩摘要替换的片段：${replaced} 个事件（原始记录仍按顺序保留在本导出中）`);
  if (compacted > 0) facts.push(`- 曾被剪出上下文：${compacted} 个事件（内容仍在）`);
  return facts;
}

/**
 * Render a session as Markdown.
 *
 * The title is a heading, every turn a labelled section, and tool calls become
 * collapsible detail blocks so a long agentic session stays readable. Tool
 * output is kept, cut at `toolResultLimit` characters per result: a real session
 * holds megabytes of command output, and a Markdown file nobody can scroll is
 * not an export. The JSONL format keeps it whole.
 *
 * @param {{ header: any, events: any[] }} artifact
 * @param {{ title?: string } & ExportOptions} options
 * @returns {string}
 */
export function toMarkdown(artifact, options) {
  const { turns, omitted, compacted, replaced, checkpoints } = collectTurns(artifact?.events ?? []);
  const header = artifact?.header ?? {};
  const title = options?.title || header.title || header.cwd || header.id || "session";
  const includeTools = options?.includeTools !== false;
  const includeResults = options?.includeToolResults !== false;
  const includeReasoning = options?.includeReasoning === true;
  const resultLimit = Number.isFinite(options?.toolResultLimit) ? Math.max(0, Number(options?.toolResultLimit)) : MD_RESULT_LIMIT;

  const userTurns = turns.filter((turn) => turn.role === "user").length;
  const assistantTurns = turns.filter((turn) => turn.role === "assistant").length;
  const toolCalls = turns.reduce((sum, turn) => sum + turn.tools.length, 0);

  const lines = [];
  lines.push(`# ${String(title).replace(/\r?\n/g, " ")}`);
  lines.push("");
  const facts = [];
  if (header.id) facts.push(`- 会话 id：\`${header.id}\``);
  if (header.cwd) facts.push(`- 工作目录：\`${header.cwd}\``);
  if (Number.isFinite(header.createdAt)) facts.push(`- 创建时间：${stamp(header.createdAt)}`);
  facts.push(`- 用户消息：${userTurns} 条 · 助手回合：${assistantTurns} 段 · 工具调用：${toolCalls} 次`);
  facts.push(...omissionFacts(omitted, compacted, replaced, checkpoints));
  lines.push(...facts);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const turn of turns) {
    if (turn.role === "note") {
      lines.push(`> ⚠ ${turn.text.trim()}`);
      lines.push("");
      continue;
    }
    const label = turn.role === "user" ? "用户" : turn.role === "checkpoint" ? "上下文压缩摘要" : "助手";
    const when = stamp(turn.at);
    lines.push(`## ${label}${when ? ` · ${when}` : ""}`);
    lines.push("");
    if (turn.role === "checkpoint") {
      lines.push("_（本段由 DSH 自动生成，不是用户原话）_");
      lines.push("");
    }
    if (includeReasoning && turn.reasoning) {
      lines.push("> 思考");
      for (const line of turn.reasoning.split(/\r?\n/)) lines.push(`> ${line}`);
      lines.push("");
    }
    for (const part of turn.parts) {
      if (part.kind === "text") {
        lines.push(part.text.trim());
        lines.push("");
        continue;
      }
      if (!includeTools) continue;
      const hint = toolHint(part.args);
      lines.push(`<details><summary>工具调用 · ${part.name}${hint ? ` — ${hint}` : ""}</summary>`);
      lines.push("");
      const shown = part.args === null || part.args === undefined ? part.raw : part.args;
      lines.push("~~~json");
      lines.push(typeof shown === "string" ? shown : (JSON.stringify(shown, null, 2) ?? "null"));
      lines.push("~~~");
      lines.push("");
      if (includeResults && typeof part.result === "string" && part.result !== "") {
        const body = part.result;
        const points = Array.from(body);
        const cut = points.length > resultLimit;
        lines.push(part.isError ? "**输出（错误）**" : "**输出**");
        lines.push("");
        lines.push("~~~");
        lines.push(cut ? points.slice(0, resultLimit).join("") : body);
        lines.push("~~~");
        if (cut) lines.push(`_（已截断：共 ${points.length} 字符，完整输出见 JSONL 导出）_`);
        lines.push("");
      }
      lines.push("</details>");
      lines.push("");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Render a session as JSONL: one turn per line, plus a header line.
 *
 * This is not the raw log — it is the *conversation*, which is what a JSONL user
 * wants to re-ingest. Every tool call keeps its full arguments and its full
 * output here: this format exists to be complete, not to be scrolled by eye.
 *
 * @param {{ header: any, events: any[] }} artifact
 * @param {ExportOptions} [options]
 * @returns {string}
 */
export function toJsonl(artifact, options) {
  const { turns, omitted, compacted, replaced, checkpoints } = collectTurns(artifact?.events ?? []);
  const header = artifact?.header ?? {};
  const includeTools = options?.includeTools !== false;
  const includeReasoning = options?.includeReasoning === true;
  const lines = [
    JSON.stringify({
      type: "session",
      id: header.id ?? null,
      title: header.title ?? null,
      cwd: header.cwd ?? null,
      createdAt: header.createdAt ?? null,
      turns: turns.filter((turn) => turn.role !== "note").length,
      tools: turns.reduce((sum, turn) => sum + turn.tools.length, 0),
      omitted: { ...omitted, compacted, replaced, checkpoints },
    }),
  ];
  for (const turn of turns) {
    // The replaced-span note is a reading aid for the Markdown file; a JSONL
    // consumer wants messages, and the counts above already tell it the story.
    if (turn.role === "note") continue;
    lines.push(
      JSON.stringify({
        type: "message",
        role: turn.role,
        at: turn.at,
        text: turn.text,
        ...(includeReasoning && turn.reasoning ? { reasoning: turn.reasoning } : {}),
        ...(includeTools && turn.tools.length > 0
          ? {
              tools: turn.tools.map((tool) => ({
                name: tool.name,
                arguments: tool.args ?? tool.raw,
                ...(typeof tool.result === "string" && tool.result !== "" ? { result: tool.result } : {}),
                ...(tool.isError ? { isError: true } : {}),
              })),
            }
          : {}),
      }),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * A filesystem-safe file name for one export.
 *
 * @param {any} header
 * @param {string} title
 * @param {"md" | "jsonl"} format
 * @returns {string}
 */
export function exportFileName(header, title, format) {
  const cleaned = String(title || header?.title || header?.id || "session")
    .replace(/[\\/:*?"<>|\r\n]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  // Truncate by code point, not by UTF-16 unit: `.slice(0, 80)` cut an emoji in
  // half and left a lone surrogate, which `encodeURIComponent` in the download
  // route then rejected as `URIError: URI malformed` — the export became a 500.
  const base = Array.from(cleaned).slice(0, 80).join("") || "session";
  return `${base}.${format === "jsonl" ? "jsonl" : "md"}`;
}
