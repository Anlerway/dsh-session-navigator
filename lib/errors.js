/**
 * dsh-session-navigator — the one table of error codes.
 *
 * A code used to have three lives: the throw site picked it, a 52-case `switch`
 * at the bottom of the dispatcher picked its HTTP status, and a chain of
 * `if (code === ...)` in the panel picked the sentence a human reads. Adding a
 * code meant editing three files in two languages and remembering which of them
 * already knew the spelling.
 *
 * One row here is the whole contract: the status it is answered with, and the
 * sentence for each language the plugin speaks. `statusFor` reads the table,
 * `messageFor` reads the same row, and the contract test in
 * test/routes-contract.test.mjs pins every row so a new code cannot ship with a
 * 500 by accident.
 *
 * Two spellings of the same failure still live in the vocabulary, and both have
 * to keep working: DSH's own domain layer says `session/not-found` and
 * `workspace/session-active`, while this plugin's helpers say
 * `session-not-found`. The status is a property of the failure, not of the layer
 * that named it — a table that knew only the slashed spelling answered 500 for
 * the hyphenated 404, which is the bug this table exists to stop. Both spellings
 * therefore get a row, and `normalizeCode` folds the two forms together for
 * lookups so a third spelling cannot reopen the hole.
 */

/**
 * @typedef {object} ErrorCode
 * @property {number} status HTTP status this code is answered with.
 * @property {string} zh sentence shown in a Chinese window.
 * @property {string} en sentence shown in an English window.
 */

/**
 * Every code the host can answer with.
 *
 * `zh` / `en` follow the panel's wording wherever the panel has one
 * (lib/client.js › describeError, and the 独立弹窗 hint), because those
 * sentences are the ones a user has already seen for that failure. A code the
 * panel has not named yet carries the sentence the host already shows for it, so
 * `messageFor` never returns a stack trace and never returns raw English inside
 * a Chinese window.
 *
 * @type {Record<string, ErrorCode>}
 */
export const ERROR_CODES = {
  // ── 400: the request itself is malformed; nothing was written ─────────────
  "bad-request": {
    status: 400,
    zh: "请求参数有误，请检查后重试",
    en: "The request was malformed; check it and try again",
  },
  "gateway/bad-request": {
    status: 400,
    zh: "DSH 拒绝了这个操作：参数不合法",
    en: "DSH refused the operation: the arguments are not valid",
  },
  "session/title-invalid": {
    status: 400,
    zh: "标题不可用：不能为空，也不能被 DSH 拒绝",
    en: "That title is not accepted: it cannot be blank",
  },
  "workspace/name-conflict": {
    status: 400,
    zh: "已有同名工作区",
    en: "A workspace with that name already exists",
  },
  "subagent-unsupported": {
    status: 400,
    zh: "子智能体跟随父会话，不能单独操作：请选择父会话",
    en: "Subagents follow their parent and cannot be acted on alone: pick the parent session",
  },
  // 清除数据 without, or with the wrong, confirmation word. A 400 says the
  // request itself was malformed, which is precisely true and costs nothing:
  // nothing was deleted.
  "confirm-required": {
    status: 400,
    zh: "确认词不正确，什么都没有删除",
    en: "The confirmation word did not match; nothing was deleted",
  },
  // The path handed in as `borrowed` is not a runtime this plugin can start
  // (or it is inside our own data directory, where borrowing makes no sense).
  "component-borrow-invalid": {
    status: 400,
    zh: "借用的运行时不可用：它不在别的插件里，或就在本插件的数据目录中",
    en: "That runtime cannot be borrowed: it is not another plugin\u2019s, or it sits inside this plugin\u2019s data directory",
  },

  // ── 404: the thing named does not exist (any more) ────────────────────────
  // The move/trash helpers raise the hyphenated spelling of the same two codes;
  // a client switching on the status cannot tell which layer answered, so both
  // spellings get the status the situation deserves.
  "session/not-found": {
    status: 404,
    zh: "这个会话不存在，或已经被永久删除",
    en: "This session does not exist, or was purged",
  },
  "session-not-found": {
    status: 404,
    zh: "这个会话不存在，或已经被永久删除",
    en: "This session does not exist, or was purged",
  },
  "workspace/not-found": {
    status: 404,
    zh: "目标工作区不存在，或它的目录已经失效",
    en: "That workspace is gone, or its folder no longer exists",
  },
  "workspace-not-found": {
    status: 404,
    zh: "目标工作区不存在，或它的目录已经失效",
    en: "That workspace is gone, or its folder no longer exists",
  },
  "node-not-found": {
    status: 404,
    zh: "这个位置已经不存在了，刷新后再试",
    en: "That place is gone \u2014 refresh and try again",
  },
  "trash-not-found": {
    status: 404,
    zh: "回收站里已经没有这个会话了",
    en: "That session is no longer in the trash",
  },
  "component-not-installed": {
    status: 404,
    zh: "独立弹窗需要先下载浏览器组件，已改用浮窗：设置 → 会话资源管理器 → 浏览器组件",
    en: "The separate window needs the browser component, so the panel is used instead: Settings → Session Navigator → Browser component",
  },

  // ── 409: the request was fine, the state it assumed was not ───────────────
  "target-exists": {
    status: 409,
    zh: "目标位置已有同名会话，未覆盖",
    en: "A session with that name is already there; nothing was overwritten",
  },
  "session-active": {
    status: 409,
    zh: "这个会话正在 DSH 中打开，无法移动或删除；可以先复制它，或重启 DSH 后再试",
    en: "This session is open in DSH, so it cannot be moved or deleted; copy it instead, or restart DSH and try again",
  },
  "session-corrupt": {
    status: 409,
    zh: "这个会话的文件读不出来，DSH 也打不开它",
    en: "This session\u2019s files cannot be read; DSH cannot open it either",
  },
  "revision-conflict": {
    status: 409,
    zh: "数据已被其他窗口修改，已重新载入，请再试一次",
    en: "Another window changed the data; reloaded \u2014 please try again",
  },
  // The shared tag vocabulary is full: the write was valid, the store had no
  // room, and the user has to free a slot first.
  "tag-library-full": {
    status: 409,
    zh: "标签库满了，先删掉一个标签再来",
    en: "The tag library is full; remove a tag first",
  },
  "datadir-same": {
    status: 409,
    zh: "目标目录就是当前数据目录，不需要迁移",
    en: "The target is already the data directory; there is nothing to migrate",
  },
  "datadir-not-empty": {
    status: 409,
    zh: "目标目录不是空的，迁移没有开始",
    en: "The target directory is not empty; the migration did not start",
  },
  "migration-in-progress": {
    status: 409,
    zh: "数据目录正在迁移，暂时不能写入",
    en: "A data-directory migration is running; writes are paused",
  },
  // The data directory is a drive root or sits on DSH's own tree, so the purge
  // was refused rather than half-applied.
  "reset-refused": {
    status: 409,
    zh: "这个目录是磁盘根目录或 DSH 自己的目录，已拒绝清空",
    en: "That directory is a drive root or inside DSH\u2019s own tree, so the purge was refused",
  },
  "component-busy": {
    status: 409,
    zh: "浏览器组件正在下载或安装，等它结束再来",
    en: "The browser component is busy downloading or installing; try again when it finishes",
  },
  "component-in-use": {
    status: 409,
    zh: "浏览器组件正在使用，先关掉独立窗口",
    en: "The browser component is in use; close the separate window first",
  },
  "workspace/session-active": {
    status: 409,
    zh: "这个工作区里还有开着的会话，先关掉它们",
    en: "That workspace still has open sessions; close them first",
  },
  // Nothing left to do is not a failure of the request, it is the answer.
  "nothing-pending": {
    status: 409,
    zh: "所有会话都已经有描述和标签了",
    en: "Every session already has a description and tags",
  },
  // Nothing was switched on, or there is no generated field to apply yet:
  // both are states of the configuration, not malformed requests.
  "ai/no-fields": {
    status: 409,
    zh: "没有勾选任何要生成的字段",
    en: "No field was selected to generate",
  },
  "nothing-to-apply": {
    status: 409,
    zh: "没有可应用的内容：生成结果还是空的",
    en: "Nothing to apply: the generated fields are still empty",
  },

  // ── 507: the write was right, the volume had no room ──────────────────────
  "component-disk-full": {
    status: 507,
    zh: "磁盘空间不够，浏览器组件下载不完",
    en: "Not enough disk space to finish downloading the browser component",
  },
  "disk-full": {
    status: 507,
    zh: "磁盘空间不够，写入没有完成",
    en: "The disk is full; the write did not complete",
  },

  // ── 501: this build has the route, not the capability behind it ────────────
  "capability-missing": {
    status: 501,
    zh: "这个 DSH 版本没有提供这项能力",
    en: "This DSH build does not provide that capability",
  },
  // `llm-unavailable` is a 501 for the same reason: the plugin can summarize,
  // this profile has nothing to summarize with.
  "llm-unavailable": {
    status: 501,
    zh: "没有可用的模型：先在设置里配置一个",
    en: "No model is available: configure one in Settings",
  },

  // ── 413: one batch is bounded ─────────────────────────────────────────────
  // Bounded so a 500-session library cannot queue a run that outlives the
  // window it was started from.
  "too-many": {
    status: 413,
    zh: "一次最多处理这么多会话，请分批",
    en: "Too many sessions in one batch; split it up",
  },

  // ── 401: the provider's credential is the thing to fix ────────────────────
  "llm/MISSING_CREDENTIAL": {
    status: 401,
    zh: "这个模型没有配置凭据",
    en: "No credential is configured for this model",
  },
  "llm/INVALID_CREDENTIAL": {
    status: 401,
    zh: "模型凭据无效",
    en: "The model credential is invalid",
  },
  "llm/AUTH": {
    status: 401,
    zh: "模型服务拒绝了这个凭据",
    en: "The model provider refused the credential",
  },

  // ── 429: the provider is throttling, not the plugin ───────────────────────
  "llm/RATE_LIMIT": {
    status: 429,
    zh: "模型正在限流，稍后再试",
    en: "The model provider is rate-limiting; try again later",
  },
  "llm/QUOTA": {
    status: 429,
    zh: "模型额度用完了",
    en: "The model quota is used up",
  },
  "llm/ACCOUNT_QUOTA": {
    status: 429,
    zh: "账号额度用完了",
    en: "The account quota is used up",
  },

  // ── 422: the request was understood, the answer cannot be used ────────────
  "llm/CONTEXT_WINDOW_EXCEEDED": {
    status: 422,
    zh: "这段会话比模型的上下文窗口还长",
    en: "This session is longer than the model\u2019s context window",
  },
  "llm/empty": {
    status: 422,
    zh: "模型没有返回任何内容",
    en: "The model returned nothing",
  },
  // The model tried to call a tool it was never given, twice, and never
  // produced a word: the answer is unusable for the same reason an empty one
  // is, so it gets the same status.
  "llm/tool-only": {
    status: 422,
    zh: "模型只调用了工具，没有写出内容",
    en: "The model only called tools and wrote nothing",
  },
  "llm/no-finish": {
    status: 422,
    zh: "模型没有正常结束这次回答",
    en: "The model did not finish its answer",
  },
  "nothing-to-summarize": {
    status: 422,
    zh: "没有可总结的内容",
    en: "There is nothing to summarize",
  },
  // The model answered, but not with the object it was told to answer with,
  // twice. 422: the request was understood and the answer cannot be used.
  "ai/bad-answer": {
    status: 422,
    zh: "模型返回的格式不对，不能用",
    en: "The model answered in a shape this plugin cannot use",
  },

  // ── 403 / 415: the request was not allowed to be a write at all ───────────
  "cross-site": {
    status: 403,
    zh: "这个写入来自别的网站，已拒绝",
    en: "The write came from another site and was refused",
  },
  "unsupported-media-type": {
    status: 415,
    zh: "写入请求必须使用 application/json",
    en: "Writes must be sent as application/json",
  },

  // ── 502: an upstream did not answer, not the plugin ───────────────────────
  "update-unreachable": {
    status: 502,
    zh: "连不上更新服务器，稍后再试",
    en: "The update server could not be reached; try again later",
  },
  "open-failed": {
    status: 502,
    zh: "系统没能打开这个位置",
    en: "The system could not open that location",
  },

  // ── 500: the plugin's own fault, said plainly ─────────────────────────────
  "move-incomplete": {
    status: 500,
    zh: "移动没有全部完成，没处理到的会话还在原处",
    en: "The move did not finish; the sessions it did not reach are unchanged",
  },
  "move-rollback-failed": {
    status: 500,
    zh: "移动失败，回滚也没能做完，请检查工作区目录",
    en: "The move failed and the rollback did not complete; check the workspace folders",
  },

  // ── 500: internal faults, named so they are not anonymous ────────────────
  // These are the codes the store, the component manager and the changelog
  // reader raise when something on disk contradicts what the plugin expects.
  //
  // They are in the table even though a 500 is the default, for two reasons:
  // `messageFor` can then say what happened in the user's language instead of
  // echoing an English internal sentence, and the contract test can tell a code
  // nobody mapped (a bug) from a code that is a server fault on purpose.
  "component-cancelled": {
    status: 500,
    zh: "浏览器组件的下载已取消",
    en: "The browser component download was cancelled",
  },
  "component-checksum": {
    status: 500,
    zh: "浏览器组件下载后校验不通过，请重试",
    en: "The downloaded browser component failed its checksum; try again",
  },
  "component-download-failed": {
    status: 500,
    zh: "浏览器组件下载失败",
    en: "The browser component could not be downloaded",
  },
  "component-download-too-large": {
    status: 500,
    zh: "浏览器组件的下载体积超出预期，已停止",
    en: "The browser component download exceeded the expected size and was stopped",
  },
  "component-extract-failed": {
    status: 500,
    zh: "浏览器组件解压失败",
    en: "The browser component could not be unpacked",
  },
  "fork-failed": {
    status: 500,
    zh: "DSH 没有返回复制出来的会话",
    en: "DSH did not return the forked session",
  },
  internal: {
    status: 500,
    zh: "插件内部状态不一致，操作没有完成",
    en: "The plugin\u2019s internal state is inconsistent; the operation did not complete",
  },
  "io-error": {
    status: 500,
    zh: "读写数据文件失败，请检查磁盘和权限",
    en: "A data file could not be read or written; check the disk and permissions",
  },
  "not-found": {
    status: 500,
    zh: "找不到需要的文件",
    en: "A required file is missing",
  },
  "sidecar-corrupt": {
    status: 500,
    zh: "数据文件内容已损坏，读不出来",
    en: "A data file is corrupt and cannot be parsed",
  },
  "sidecar-version": {
    status: 500,
    zh: "数据文件是更新版本写的，这个版本读不了",
    en: "A data file was written by a newer version than this build can read",
  },
  "too-large": {
    status: 500,
    zh: "文件太大，已拒绝读取",
    en: "The file is too large to read",
  },
  "ui-asset-missing": {
    status: 500,
    zh: "缺少独立窗口需要的文件",
    en: "A file the separate window needs is missing",
  },
};

/** The status a code has no row for. */
const FALLBACK_STATUS = 500;

/**
 * Fold the two spellings of a code into one lookup key.
 *
 * `session/not-found` and `session-not-found` are the same failure, so they must
 * answer the same status; normalising is how a third spelling — or a caller that
 * upper-cases what it passes — still lands on the right row instead of falling
 * through to 500.
 *
 * The result is a *lookup* key, not a code to send to a client: it is
 * lower-cased and hyphenated, so it is not what `fail()` should echo back.
 *
 * @param {unknown} code
 * @returns {string} the folded key, or "" when there is no code at all
 */
export function normalizeCode(code) {
  const text = typeof code === "string" ? code.trim() : "";
  if (text === "") return "";
  return text.replaceAll("/", "-").toLowerCase();
}

/**
 * Row per normalised key, built once.
 *
 * A collision would mean two rows that normalise the same way and disagree
 * about the status — exactly the drift this table removes — so the first row
 * wins and the build stays quiet: throwing here would turn a data mistake into a
 * plugin that cannot load at all, and the two known spellings agree. The
 * contract test pins that agreement.
 *
 * @type {Map<string, ErrorCode>}
 */
const ROW_BY_KEY = new Map(Object.entries(ERROR_CODES).map(([code, entry]) => [normalizeCode(code), entry]));

/**
 * The row for a code, whichever of the two spellings it arrives in.
 *
 * @param {unknown} code
 * @returns {ErrorCode | undefined}
 */
function rowFor(code) {
  if (typeof code !== "string") return undefined;
  const exact = ERROR_CODES[code];
  if (exact) return exact;
  return ROW_BY_KEY.get(normalizeCode(code));
}

/**
 * HTTP status for a plugin error code. Only codes a client can act on get a
 * non-500 status; anything unexpected is a server fault.
 *
 * A table lookup, deliberately: the old 52-case `switch` had to be edited by
 * hand for every new code, and the one time it was not, a 404 became a 500.
 *
 * @param {string} code
 * @returns {number}
 */
export function statusFor(code) {
  return rowFor(code)?.status ?? FALLBACK_STATUS;
}

/**
 * The sentence for a code, in the language the caller is drawing in.
 *
 * `fallback` is what the host's own message already says, usually the more
 * specific half (which field, which id). It is used when the code has no row, so
 * an unknown code still shows the reason instead of a generic line.
 *
 * @param {string} code
 * @param {string} [fallback]
 * @param {"zh" | "en"} [lang] defaults to Chinese, the plugin primary language
 * @returns {string}
 */
export function messageFor(code, fallback, lang = "zh") {
  const entry = rowFor(code);
  if (entry) return lang === "en" ? entry.en : entry.zh;
  const text = typeof fallback === "string" ? fallback.trim() : "";
  if (text !== "") return text;
  return lang === "en" ? "The action failed - please try again" : "操作失败，请重试";
}
