    // ── HTTP ───────────────────────────────────────────────────────────────
    async function apiGet(path, init) {
      const response = await fetch(API + path, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
        ...init,
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!payload || payload.ok !== true) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      return payload.result;
    }

    /**
     * A mutating request. The envelope is unwrapped the same way, but a failure
     * carries the host's error code, so the panel can tell "conflict, reload"
     * apart from "bad input, tell the user".
     *
     * Every write cites the revision of the store it touches (`If-Match`); the
     * host answers `revision-conflict` when another window got there first.
     */
    /**
     * @param {string} method
     * @param {string} path
     * @param {any} [body]
     * @param {{ ifMatch?: boolean }} [options] `ifMatch: false` states no
     *   expectation — for callers that live outside the panel and never
     *   received a bootstrap snapshot, where the revision cache would be
     *   either empty or stale.
     */
    async function apiSend(method, path, body, options = {}) {
      /** @type {Record<string, string>} */
      const headers = { accept: "application/json", "content-type": "application/json; charset=utf-8" };
      const revision = options.ifMatch === false ? null : revisionOf(path);
      if (revision !== null) headers["if-match"] = `"${revision}"`;
      const response = await fetch(API + path, {
        method,
        credentials: "same-origin",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!payload || payload.ok !== true) {
        const error = new Error(payload?.error ?? `HTTP ${response.status}`);
        error.code = payload?.code ?? "bad-request";
        throw error;
      }
      // The answer carries the counter it wrote, so this panel never cites a
      // revision it has already left behind.
      const store = storeOf(path);
      const written = payload.result?.revision;
      if (store && Number.isFinite(written)) revisions[store] = written;
      // The other document holds a snapshot of the same library and has no
      // way to hear about this write. Telling it to re-read is the whole
      // cost of keeping two windows on one truth.
      // `needsDsh` asks the peer to do the half this document cannot: a window
      // with no host context cannot refresh DSH's session list, but the panel in
      // the main window can, and it is listening on the same channel.
      //
      // The channel is per-origin, and a window in its own process is not in
      // this document's process group, so the peer message alone only ever
      // reaches a second DSH page. The bridge command is the hop that survives
      // the process boundary — a no-op in the panel, which pulls for itself.
      if (method !== "GET" && method !== "HEAD") {
        publishPeer({ kind: "refresh", path, needsDsh: !canRefreshDsh() });
        // Only a detached window needs the bridge: the panel refreshes DSH
        // directly, and a document with no Host at all has nobody to ask.
        if (windowHost()) void sendBridgeCommand("refresh", {});
      }
      return payload.result;
    }

    // ── Formatting ─────────────────────────────────────────────────────────
    const DATE_SHORT = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const DATE_FULL = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const NUMBER = new Intl.NumberFormat("zh-CN");

    /**
     * How a row spells a date and a size (设置 › 显示 › 日期格式 / 大小单位).
     *
     * The formatters below are called from rows that receive no display props —
     * the list, the detail pane, the status bar — so the choice lives here and is
     * *mutated in place* by the panel on every render. Mutating rather than
     * replacing is what lets a call see the current value without threading a
     * prop through a dozen components.
     */
    const panelFormat = { date: "date", size: "auto" };

    /**
     * `1分钟` / `2小时` / `999天` — 距今时间, one number and one unit word.
     *
     * `Intl.RelativeTimeFormat` cannot render this column: its `numeric: "auto"`
     * names the day — 昨天, 上个月 — instead of counting it. The column's job is to
     * say how long ago in one unit, so the number is assembled here and the unit
     * word is looked up like every other label — Chinese runs them together,
     * English spaces them.
     */
    /**
     * Languages that keep the number and its unit word apart.
     *
     * By orthography, not by family: zh / ja / ko run them together (3天), the
     * Latin-script languages and Russian do not (3 Tage, 3 дня). A language added
     * to assets/i18n has to be put on one side of this set, which is why it is a
     * list of codes rather than a rule about scripts.
     */
    const SPACED_UNIT_LANGS = new Set(["en", "de", "fr", "es", "ru", "pt"]);

    function relativeText(value, unit) {
      const word = unit === "minute" ? T("分钟") : unit === "hour" ? T("小时") : T("天");
      const count = String(Math.max(1, Math.round(Math.abs(value))));
      return SPACED_UNIT_LANGS.has(panelLang) ? count + " " + word : count + word;
    }

    function padTwo(value) {
      return String(value).padStart(2, "0");
    }

    /** `1.2 MB` — empty string when the size is unknown (cache-only rows). */
    function formatSize(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return "";
      // 固定 KB — one unit per column: "18734 KB" reads worse than "18.3 MB",
      // but it compares at a glance, which is the whole reason to pick it.
      if (panelFormat.size === "kb") {
        const kb = bytes / 1024;
        return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
      }
      const units = ["B", "KB", "MB", "GB", "TB"];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
    }

    /** `10-18 06:55`, or `2025-10-18 06:55` outside the current year. */
    function formatDate(epochMs, now) {
      if (!Number.isFinite(epochMs) || epochMs <= 0) return "";
      const date = new Date(epochMs);
      const sameYear = new Date(now).getFullYear() === date.getFullYear();
      const text = sameYear ? DATE_SHORT.format(date) : DATE_FULL.format(date);
      return text.replace(/\//g, "-");
    }

    /**
     * `1分钟` / `2小时` / `1天` / `999天` — 距今时间.
     *
     * Three rungs and no more: the unit climbs 分钟 → 小时 → 天 and then stays on
     * 天, so a two-year-old session reads 730天 rather than 2年. Months and years
     * were approximations that hid the count — 60天 and 2个月 were the same row —
     * and the rule the panel wants is a count, not a calendar. A timestamp less
     * than a minute old still says 1分钟: a row that reads 0分钟 looks broken.
     */
    function formatRelative(epochMs, now) {
      if (!Number.isFinite(epochMs) || epochMs <= 0) return "";
      const minutes = Math.max(1, Math.round((now - epochMs) / 60000));
      if (minutes < 60) return relativeText(minutes, "minute");
      const hours = Math.max(1, Math.round(minutes / 60));
      if (hours < 24) return relativeText(hours, "hour");
      return relativeText(Math.max(1, Math.round(hours / 24)), "day");
    }

    /**
     * A timestamp as 设置 › 显示 › 日期格式 asked for it.
     *
     * Every surface that prints a session time goes through this one call, so the
     * two halves of the choice cannot drift: the list column and the detail rows
     * always agree.
     */
    function formatWhen(epochMs, now) {
      return panelFormat.date === "relative" ? formatRelative(epochMs, now) : formatDate(epochMs, now);
    }

    function formatCount(value) {
      return Number.isFinite(value) ? NUMBER.format(value) : "0";
    }

    function formatCompact(value) {
      if (!Number.isFinite(value) || value <= 0) return "—";
      if (value < 1000) return String(value);
      if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
      return `${(value / 1_000_000).toFixed(1)}M`;
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return "—";
      if (ms < 1000) return `${Math.round(ms)} ms`;
      if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
      const minutes = Math.floor(ms / 60_000);
      const seconds = Math.round((ms % 60_000) / 1000);
      return `${minutes}m ${padTwo(seconds)}s`;
    }

    // ── Icons ──────────────────────────────────────────────────────────────
    // Lifted verbatim from the prototype's icon table: 16x16, 1.3px stroke,
    // round caps. Markup is static local data, never user input.
    const ICONS = {
      back: '<path d="M10 3L5 8l5 5"/>',
      fwd: '<path d="M6 3l5 5-5 5"/>',
      up: '<path d="M8 12.5V4M4 7.5l4-4 4 4"/>',
      refresh: '<path d="M13.1 8a5.1 5.1 0 1 1-1.6-3.7"/><path class="accent" d="M13.1 2.6v2.9h-2.9"/>',
      search: '<circle cx="7" cy="7" r="4.4"/><path d="M10.4 10.4L13.6 13.6"/>',
      home: '<path d="M2.5 7.6L8 3l5.5 4.6V13h-4v-3h-3v3h-4z"/>',
      star: '<path class="accent" d="M8 2.4l1.79 3.63 4 .58-2.9 2.83.69 3.99L8 11.55l-3.58 1.88.69-3.99L2.21 6.61l4-.58z"/>',
      todo: '<rect x="2.4" y="3.3" width="11.2" height="9.4" rx="2.4"/><path class="accent" d="M5.2 8.1l1.85 1.85 3.75-3.75"/>',
      folder: '<path class="accent" d="M2.4 6.3V4.4h4.1l1.5 1.9"/><path d="M8 6.3h6V13H2.4V6.3"/>',
      folderplus: '<path d="M2.4 6.3V4.4h4.1l1.5 1.9h6V13H2.4z"/><path class="accent" d="M8 8.2v3.2M6.4 9.8h3.2"/>',
      monitor: '<rect x="2" y="3.4" width="12" height="7.2" rx="1"/><path d="M6 13h4M8 10.6V13"/>',
      chat: '<path d="M2.6 3.6h10.8v6.9H7.1L4.2 13v-2.5H2.6z"/>',
      // 删除 keeps one tone: a red command already says what it does, and a blue
      // lid on a grey bin split the glyph into two ideas (m0xxxx).
      trash: '<path d="M4.4 5.3l.6 7.4a1.7 1.7 0 0 0 1.7 1.6h2.6a1.7 1.7 0 0 0 1.7-1.6l.6-7.4"/><path d="M2.9 5.3h10.2M6.3 5.3V3.3h3.4v2"/>',
      archive: '<rect x="2.4" y="3.2" width="11.2" height="3" rx="1.2"/><path d="M3.7 6.2V13h8.6V6.2"/><path class="accent" d="M6.4 9.3h3.2"/>',
      restore: '<rect x="2.4" y="8.5" width="11.2" height="4.6" rx="1.7"/><path class="accent" d="M8 2.5v4.6M5.9 5.1L8 7.2l2.1-2.1"/>',
      pin: '<path d="M5.9 2.4h4.2l-.5 4 1.9 2v.9H4.5v-.9l1.9-2z"/><path class="accent" d="M8 9.3v4.2"/>',
  // 快速访问: a bookmark strip, not a pin — the glyph has to read differently at
  // 14px or the two commands look like the same one spelled twice.
  quick: '<path class="accent" d="M9.5 1.9L4.1 8.7h2.9l-.6 3.8 4.7-6.6H8.5z"/>',
      plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
      pencil: '<path d="M11.1 2.5l2.4 2.4-7.7 7.7-3.1.7.7-3.1z"/><path class="accent" d="M9.5 4.1l2.4 2.4"/>',
      // 剪切 / 复制 / 粘贴 / 重命名 are drawn in two tones: the outline that says
      // *what* the command works on is currentColor, and the accent class marks
      // the part that says *which* one it does. Same pair in both documents, and
      // both follow the palette, so nothing here hardcodes the blue.
      cut: '<g class="accent"><circle cx="3.9" cy="12.3" r="2.1"/><circle cx="12.1" cy="12.3" r="2.1"/></g><path d="M5.8 10.9L11.6 2.3M10.2 10.9L4.4 2.3"/>',
      // A sheet behind, a sheet in front: the front one is the copy you are
      // about to make, so it carries the accent and the one behind is cut where
      // it disappears underneath.
      copy: '<path d="M11 11.9A2.2 2.2 0 0 1 8.8 14H3.2A2.2 2.2 0 0 1 1 11.8V5.2A2.2 2.2 0 0 1 3.2 3H5.6"/><rect class="accent" x="5.6" y="1" width="9.2" height="11.4" rx="2.4"/>',
      paste: '<path d="M3.9 2.5H5.4M9.7 2.5h.9A2.4 2.4 0 0 1 13 4.9V5.4"/><path d="M5.4 2.5H3.9A2.4 2.4 0 0 0 1.5 4.9V12.2A2.4 2.4 0 0 0 3.9 14.6H6.3"/><rect x="5.5" y="1" width="4.2" height="2.9" rx="1.2"/><rect class="accent" x="6.3" y="5.5" width="7.8" height="9.9" rx="2.2"/>',
      // 重命名: a field with the letter in it and a caret beside it — the old
      // pencil said "edit", which is what F2 does to a note, not to a name.
      rename: '<rect x="1.2" y="2.6" width="11.6" height="10.8" rx="2.6"/><path class="accent" d="M3.2 10.5L5.6 4.2l2.4 6.3M4.2 8.4h2.8"/><path class="accent" d="M10.9 1.2v13.6M9.4 1.2h3M9.4 14.8h3"/>',
      sort: '<path d="M4.6 3.2v9.5M2.5 10.6l2.1 2.1 2.1-2.1"/><path class="accent" d="M11.4 12.8V3.4M9.3 5.4l2.1-2.1 2.1 2.1"/>',
      grid: '<rect class="accent" x="2.4" y="2.4" width="4.6" height="4.6" rx="1.2"/><rect x="9" y="2.4" width="4.6" height="4.6" rx="1.2"/><rect x="2.4" y="9" width="4.6" height="4.6" rx="1.2"/><rect x="9" y="9" width="4.6" height="4.6" rx="1.2"/>',
      list: '<path d="M3 4h10M3 8h10M3 12h10"/>',
      details: '<rect x="2.4" y="3.2" width="11.2" height="9.6" rx="2.2"/><path class="accent" d="M2.4 6.6h11.2"/><path d="M9.4 6.6v6.2"/>',
      more: '<circle cx="3.4" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="12.6" cy="8" r="1.15" fill="currentColor" stroke="none"/>',
      check: '<path d="M3.2 8.4l3.1 3.1 6.5-6.6"/>',
      x: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
      minus: '<path d="M4 8h8"/>',
      chevdown: '<path d="M4.5 6.2L8 9.7l3.5-3.5"/>',
      chevright: '<path d="M6.2 4.5L9.7 8l-3.5 3.5"/>',
      external: '<path d="M12.6 9.4V13a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 13V5.2a1.4 1.4 0 0 1 1.4-1.4H7"/><path class="accent" d="M9.4 1.9h4.7v4.7M13.8 2.2L8.5 7.5"/>',
      tag: '<path d="M2.6 8.2V3.1h5.1l5.7 5.7-5.1 5.1z"/><circle class="accent" cx="5.4" cy="5.8" r="1"/>',
      settings: '<path d="M8 1.9v1.7M8 12.4v1.7M14.1 8h-1.7M3.6 8H1.9M12.3 3.7l-1.2 1.2M4.9 11.1l-1.2 1.2M12.3 12.3l-1.2-1.2M4.9 4.9L3.7 3.7"/><circle class="accent" cx="8" cy="8" r="2.2"/>',
      // 分叉 is not 复制: a copy is a second identical file, a fork is a branch
      // that continues from a point. The git-branch glyph says that in one
      // glance, where reusing the copy icon made the two commands look alike.
      branch: '<circle cx="4.6" cy="3.6" r="1.5"/><circle cx="4.6" cy="12.4" r="1.5"/><path d="M4.6 5.1v5.8"/><circle class="accent" cx="11.4" cy="6.2" r="1.5"/><path class="accent" d="M9.9 6.9c-.6 2.1-2.1 3-3.7 3.3"/>',
      // 快捷方式 shares 外部打开's glyph on purpose: both mean "this row points
      // somewhere else", and a shortcut row in the tree is exactly that. The
      // markup is spelled out rather than aliased so the icon table stays a flat
      // literal (tools read it as data).
      shortcut: '<path d="M12.6 9.4V13a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 13V5.2a1.4 1.4 0 0 1 1.4-1.4H7"/><path class="accent" d="M9.4 1.9h4.7v4.7M13.8 2.2L8.5 7.5"/>',
      // 定位: crosshair-in-frame, used by 在文件管理器中显示.
      locate: '<path d="M3 6.2V3.4h2.8M10.2 3.4H13v2.8M13 9.8v2.8h-2.8M5.8 12.6H3V9.8"/><circle class="accent" cx="8" cy="8" r="2"/>',
      // 导出: an arrow out of a page.
      download: '<path d="M2.8 12.8h10.4"/><path class="accent" d="M8 2.8v6.4M5.4 6.6L8 9.2l2.6-2.6"/>',
      // 快捷方式容器 (收藏 / 待办) in the tree rail.
      // 搜索范围: a funnel. The search box has no room for the word, and a funnel
      // is the one glyph that reads as "narrow what this looks at" at 13px.
      filter: '<path d="M2.7 3.5h10.6L9.2 8.2v4.1L6.8 13.7V8.2z"/>',
      // AI 总结: a sparkle. It is the one glyph that reads as "a model wrote
      // this" without drawing a robot, and it stays legible at 14px.
      spark: '<path d="M7.1 2.2l1.3 3 3 1.3-3 1.3-1.3 3-1.3-3-3-1.3 3-1.3z"/><path class="accent" d="M12.1 9.9l.55 1.25 1.25.55-1.25.55-.55 1.25-.55-1.25-1.25-.55 1.25-.55z"/>',
    };

    function Icon({ name, size = 16, className }) {
      const markup = ICONS[name];
      if (!markup) return null;
      return h("svg", {
        viewBox: "0 0 16 16",
        width: size,
        height: size,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.3,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        className,
        "aria-hidden": "true",
        dangerouslySetInnerHTML: { __html: markup },
      });
    }

    // ── Panel copy ─────────────────────────────────────────────────────────
    // Every label the panel and the detached window draw goes through T().
    // The lookup key is the Chinese source text itself rather than a made-up
    // name: these are a few hundred short labels scattered across the render
    // tree, and a source-text key keeps the call site readable. If a string is
    // edited, the dictionary misses and the Chinese shows through — never a raw
    // key. The settings page keeps named DSH dictionary keys (see ZH / EN at
    // the end of this file) because it is one screen with a fixed label set.
    let panelLang = "zh";

    // 界面语言 — the language the user picked for this plugin alone, as a code in
    // LANGS. "" follows DSH, which is what every surface did before the setting
    // existed. A detached window has no settings page of its own, so its copy of
    // the choice travels through uiLang() and the launch route.
    let uiLangOverride = "";

    /**
     * Take the saved 界面语言 out of a settings document.
     *
     * Called wherever a settings payload lands — the panel's bootstrap, the
     * settings page's own read and its write reply — so the choice repaints the
     * labels on that same render instead of waiting for a restart. An empty or
     * unknown value clears the override and lets the host's language win again.
     *
     * @param {any} settings
     * @returns {string} the code now in force, "" when following DSH
     */
    function applyUiLang(settings) {
      uiLangOverride = normalizeLang(settings?.ui?.lang);
      if (uiLangOverride) panelLang = uiLangOverride;
      return uiLangOverride;
    }

    /**
     * Which language a surface that cannot ask DSH itself should draw in.
     *
     * A detached window is a separate process with no view of DSH's locale, so
     * the panel has to *tell* the Host which language to open it in. `langCode`
     * exists in every dictionary for exactly this kind of question: asking the
     * bound translator needs no second locale API.
     *
     * The answer is normalized, not compared to "en": DSH hands out `zh-CN` and
     * `en-GB` as readily as the bare codes, and a host that binds nothing answers
     * with the key itself, which normalizes to "" and keeps the panel's own
     * language.
     *
     * @returns {string} one of LANGS
     */
    function uiLang() {
      // The plugin's own choice outranks DSH's: a user who picked 日本語 for the
      // explorer wants a Japanese detached window even while DSH speaks 中文.
      if (uiLangOverride) return uiLangOverride;
      try {
        const bound = hostCtx?.locale?.bind?.(NS);
        if (typeof bound === "function") {
          const lang = normalizeLang(bound("langCode"));
          if (lang) return lang;
        }
      } catch {
        /* a host without a locale service */
      }
      return normalizeLang(panelLang) || "zh";
    }

    /**
     * The language the *summariser* is asked to write in — not the UI language.
     *
     * The Host builds its prompt from a two-way branch (zh or en) in
     * src/host/summarize.js, so a request in any other language would be answered
     * in English anyway. Sending "ja" would only make the server guess; the UI
     * can be Japanese while the summary comes back in English, and that is the
     * truth the dictionaries record: every non-Chinese table sets aiLang to "en".
     *
     * @returns {"zh" | "en"}
     */
    function aiLang() {
      // Same precedence as the labels: the summary should read in the language
      // the user chose to read this panel in, not in the host's.
      if (uiLangOverride) {
        const picked = DICTS[uiLangOverride]?.settings;
        return picked && picked.aiLang === "zh" ? "zh" : "en";
      }
      try {
        const bound = hostCtx?.locale?.bind?.(NS);
        if (typeof bound === "function") {
          const value = bound("aiLang");
          if (value === "zh" || value === "en") return value;
        }
      } catch {
        /* a host without a locale service */
      }
      const table = DICTS[panelLang]?.settings;
      return table && table.aiLang === "zh" ? "zh" : "en";
    }

    function T(zh, params) {
      // Every language reads its own table, Chinese included: its table repeats
      // the key as the value, so the source language takes the same path as the
      // rest and can be re-worded in zh.json without touching a call site. A key
      // a table has not caught up with falls back to English — except in 中文,
      // where the Chinese source is already the answer.
      const own = panelTable(panelLang);
      const english = panelLang === "zh" ? null : panelDict();
      let text = (own && own[zh]) ?? (english && english[zh]) ?? zh;
      if (params) {
        text = text.replace(/\{(\w+)\}/g, (whole, key) => {
          const value = params[key];
          return value === undefined || value === null ? whole : String(value);
        });
      }
      return text;
    }

