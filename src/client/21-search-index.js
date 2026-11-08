    // ── 搜索索引 ──────────────────────────────────────────────────
    // 搜索范围 lets the user search 会话内容, which is the one field the panel
    // cannot answer from a listing: those words are in the logs, so the host
    // reads them and keeps an index. That index is the only derived thing this
    // plugin stores besides caches, and both of its costs — disk and startup
    // time — are the user's to decide. Four rows: keep it, build it early,
    // rebuild it, drop it.
    //
    // 重新建立 / 删除 are actions, not settings, so they never go through save():
    // nothing about them belongs in the settings document, and a revision
    // conflict would refuse a delete that has nothing to do with it.
    function IndexGroup({ t, settings, saving, save }) {
      const [status, setStatus] = useState({ phase: "loading", data: null, error: "" });
      const [busy, setBusy] = useState("");
      const [following, setFollowing] = useState(false);
      const [outcome, setOutcome] = useState(null);

      const refresh = useCallback(async () => {
        try {
          const data = await apiGet("/search/index");
          setStatus({ phase: "ready", data, error: "" });
          return data;
        } catch (failure) {
          setStatus({ phase: "error", data: null, error: String(failure?.message ?? failure) });
          return null;
        }
      }, []);

      useEffect(() => {
        refresh();
      }, [refresh]);

      const pending = status.data?.pending ?? 0;
      const building = pending > 0;

      // Follow a build while there is one. The host spends a bounded slice per
      // request, so the page has to keep asking — but only while the answer says
      // there is more to do, otherwise this would poll a finished index forever.
      useEffect(() => {
        if (!building) return undefined;
        const timer = setTimeout(() => {
          refresh();
        }, 700);
        return () => clearTimeout(timer);
      }, [building, pending, refresh]);

      // 重新建立 finished: the queue drained, so report what is on disk now
      // instead of leaving 正在建立 on screen.
      useEffect(() => {
        if (!following || !status.data) return;
        if ((status.data.pending ?? 0) > 0) return;
        setFollowing(false);
        setOutcome({
          kind: "note",
          text: t("setIndexRebuildDone", {
            done: status.data.indexed ?? 0,
            total: status.data.total ?? 0,
            size: formatSize(status.data.cache?.bytes ?? 0),
          }),
        });
      }, [following, status.data, t]);

      const rebuild = useCallback(async () => {
        setBusy("rebuild");
        setOutcome(null);
        setFollowing(true);
        try {
          const data = await apiSend("POST", "/search/index/rebuild", {}, { ifMatch: false });
          setStatus({
            phase: "ready",
            data: {
              indexed: data?.indexed ?? 0,
              total: data?.total ?? 0,
              pending: data?.pending ?? 0,
              cache: data?.cache ?? null,
              building: true,
            },
            error: "",
          });
        } catch (failure) {
          setFollowing(false);
          setOutcome({ kind: "err", text: t("setIndexFailed", { reason: String(failure?.message ?? failure) }) });
        } finally {
          setBusy("");
        }
      }, [t]);

      const clear = useCallback(async () => {
        setBusy("clear");
        setOutcome(null);
        setFollowing(false);
        try {
          const data = await apiSend("POST", "/search/index/clear", {}, { ifMatch: false });
          // The host has just forgotten everything, so the page says so without
          // re-asking: a refresh here would report the same numbers one round
          // trip later, and could race a rebuild that started in between.
          setStatus({
            phase: "ready",
            data: { indexed: 0, total: status.data?.total ?? 0, pending: 0, cache: data?.cache ?? { bytes: 0 }, building: false },
            error: "",
          });
          const freed = data?.freedBytes ?? 0;
          setOutcome({
            kind: "note",
            text: freed > 0 ? t("setIndexCleared", { size: formatSize(freed) }) : t("setIndexClearedNone"),
          });
        } catch (failure) {
          setOutcome({ kind: "err", text: t("setIndexFailed", { reason: String(failure?.message ?? failure) }) });
        } finally {
          setBusy("");
        }
      }, [status.data, t]);

      // One switch is left. The index file itself has no switch: it is a derived
      // artefact in the plugin's own data directory and it is always kept — the
      // fast answer after a restart is the whole point. What is a choice is *when*
      // the reading happens, which is 允许空闲时自动建立.
      const idleOn = settings.search?.indexIdle === true;
      const bytes = status.data?.cache?.bytes ?? 0;
      const indexed = status.data?.indexed ?? 0;
      const total = status.data?.total ?? 0;
      const busyWith = busy !== "";

      return h(
        "div",
        { className: "se-set-grp" },
        h("div", { className: "se-set-h" }, t("setGroupSearch")),


        // 允许空闲时自动建立 — build it while the user is reading the list, in
        // slices, instead of in front of their first search.
        h(
          SetRow,
          { label: t("setIndexIdle"), hint: t("setIndexIdleHint") },
          h(SetSwitch, {
            on: idleOn,
            disabled: saving || busyWith,
            title: t("setIndexIdle"),
            onToggle: (value) => save({ search: { indexIdle: value } }),
          }),
        ),

        // Where the index stands: the numbers the host reports, so a rebuild can
        // be watched rather than guessed at.
        h(
          "div",
          { className: "se-set-row" },
          h(
            "div",
            { className: "se-set-main" },
            h(
              "div",
              { className: "se-set-lbl" },
              t("setIndexProgress", { done: indexed, total, size: formatSize(bytes) }),
            ),
          ),
        ),

        h(
          SetRow,
          { label: t("setIndexRebuild"), hint: t("setIndexRebuildHint") },
          h(
            "button",
            { type: "button", className: "se-set-chip", disabled: busyWith || saving, onClick: rebuild },
            busy === "rebuild" || following ? t("setIndexRebuilding") : t("setIndexRebuildGo"),
          ),
        ),

        h(
          SetRow,
          { label: t("setIndexClear"), hint: t("setIndexClearHint") },
          h(
            "button",
            { type: "button", className: "se-set-chip", disabled: busyWith || saving, onClick: clear },
            busy === "clear" ? t("setIndexClearing") : t("setIndexClearGo"),
          ),
        ),

        outcome
          ? h(
              "div",
              { className: "se-set-row" },
              h(
                "div",
                { className: "se-set-main" },
                h("div", { className: outcome.kind === "err" ? "se-set-err" : "se-set-note" }, outcome.text),
              ),
            )
          : null,
        status.phase === "error"
          ? h(
              "div",
              { className: "se-set-row" },
              h(
                "div",
                { className: "se-set-main" },
                h("div", { className: "se-set-err" }, t("setIndexFailed", { reason: status.error })),
              ),
            )
          : null,
      );
    }

    // AI 字段 — which model writes the fields, which fields it is asked
    // for, and the one button that fills in everything still missing them.
    //
    // The model pickers are driven by the host's own catalogue (GET
    // /summarize/catalog), never by a list this page keeps: those ids belong to
    // the llm service, and a hard-coded model name would go stale without
    // saying so. 强度 appears only for models that describe efforts, because an
    // adapter that has none cannot accept one.
    function SummaryGroup({ t, settings, saving, save }) {
      const store = useSummaries();
      const [catalog, setCatalog] = useState({ phase: "loading", data: null, error: "" });
      const [note, setNote] = useState(null);
      const [busy, setBusy] = useState("");
      const lang = t("aiLang") === "en" ? "en" : "zh";
      const wasRunning = useRef(false);

      const loadCatalog = useCallback(async (refresh) => {
        try {
          const data = await apiGet("/summarize/catalog" + (refresh ? "?refresh=1" : ""));
          setCatalog({ phase: "ready", data, error: "" });
          return data;
        } catch (failure) {
          setCatalog({ phase: "error", data: null, error: String(failure?.message ?? failure) });
          return null;
        }
      }, []);

      useEffect(() => {
        loadCatalog(false);
      }, [loadCatalog]);

      const state = store.state;
      const running = state?.running === true;

      // The batch just ended while this page was watching: say what happened
      // instead of leaving a stalled "正在生成 12/12" on screen.
      useEffect(() => {
        if (wasRunning.current && !running) {
          setNote(
            state && (state.done ?? 0) + (state.failed ?? 0) > 0
              ? { kind: state.failed > 0 ? "err" : "note", text: t("aiRunDone", { done: formatCount(state.done ?? 0), failed: formatCount(state.failed ?? 0) }) }
              : null,
          );
        }
        wasRunning.current = running;
      }, [running, state, t]);

      const providers = catalog.data?.providers ?? [];
      // A document written by an older host (or a fixture) has no summary
      // section yet, and the page must still render: every read below goes
      // through this one normalized view rather than through `settings.summary`.
      const summarySettings = settings.summary ?? {};
      const fields = { title: true, description: true, tags: true, ...(summarySettings.fields ?? {}) };
      const chosenProvider = providers.find((entry) => entry.id === summarySettings.provider) ?? providers[0] ?? null;
      const models = chosenProvider?.models ?? [];
      const chosenModel = models.find((entry) => entry.id === summarySettings.model) ?? models[0] ?? null;
      const efforts = chosenModel?.efforts ?? [];
      const chosenEffort = efforts.some((entry) => entry.id === summarySettings.effort) ? summarySettings.effort : "";
      const pending = store.pending.length;
      const spend = store.spend;
      const stored = Object.keys(store.sessions ?? {}).length;

      const runPending = useCallback(async () => {
        setBusy("run");
        setNote(null);
        summaryStore.clearError();
        try {
          const next = await summaryStore.startPending(lang);
          setNote(
            next?.total > 0
              ? { kind: "note", text: t("aiQueued", { count: formatCount(next.total) }) }
              : null,
          );
        } catch (failure) {
          // 所有会话都已经有描述和标签了 is an answer, not a fault: it is what the
          // button is for on a library that is already covered.
          const message = String(failure?.message ?? failure);
          setNote({ kind: /nothing-pending|都已经有描述和标签/.test(message) ? "note" : "err", text: /nothing-pending|都已经有描述和标签/.test(message) ? t("aiNothingPending") : t("aiFailed", { reason: message }) });
        } finally {
          setBusy("");
        }
      }, [lang, t]);

      const stop = useCallback(async () => {
        setBusy("stop");
        try {
          await summaryStore.cancel();
          setNote({ kind: "note", text: t("aiStopped") });
        } catch (failure) {
          setNote({ kind: "err", text: t("aiFailed", { reason: String(failure?.message ?? failure) }) });
        } finally {
          setBusy("");
        }
      }, [t]);

      const showError = (store.error || state?.lastError || catalog.error || "") !== "";

        // 模型 — one dropdown listing every provider's models under that
        // provider's name. A model id only means something inside its
        // provider, so a single control carries both halves; splitting it into
        // a provider row and a model row asked the user to make the same
        // decision twice (and chips stop being readable at 20 models).
        // "Is the stored route still on the menu?" A model id only means
        // something inside its provider, so the pair has to match together.
        const storedRoute = summarySettings.provider !== "" || summarySettings.model !== "";
        const storedKnown = providers.some(
          (provider) => provider.id === summarySettings.provider && provider.models.some((model) => model.id === summarySettings.model),
        );
        // When the stored route is gone the control shows a placeholder, not the
        // first model on the list — a select that silently re-points at another
        // model looks like a choice the user made, and the next save would make
        // it one.
        const modelValue =
          chosenProvider && chosenModel ? (storedRoute && !storedKnown ? "" : `${chosenProvider.id}\u001f${chosenModel.id}`) : "";
        const modelOptions = [];
        if (storedRoute && !storedKnown) {
          // The stored route is not in this catalogue — the profile changed, or
          // that provider is down right now. Show what is stored instead of
          // letting the select jump to the first model on the list and look
          // like a choice the user made.
          modelOptions.push(h("option", { key: "stale", value: "" }, `${summarySettings.provider || "?"} / ${summarySettings.model || "?"}`));
        }
        for (const provider of providers) {
          modelOptions.push(
            h(
              "optgroup",
              { key: provider.id, label: provider.name },
              provider.models.map((model) =>
                h("option", { key: `${provider.id}\u001f${model.id}`, value: `${provider.id}\u001f${model.id}` }, model.name || model.id),
              ),
            ),
          );
        }
        if (modelOptions.length === 0) modelOptions.push(h("option", { key: "none", value: "" }, t("aiModelNone")));

        return h(
          "div",
          { className: "se-set-grp" },
          h("div", { className: "se-set-h" }, t("setGroupAi")),

          h(
            SetRow,
            {
              label: t("aiModel"),
              hint: models.length === 0 ? t("aiModelNone") : chosenModel?.description || t("aiModelHint"),
            },
            h(
              "select",
              {
                className: "se-set-select",
                "aria-label": t("aiModel"),
                value: modelOptions.length === 0 ? "" : modelValue,
                disabled: saving || providers.length === 0,
                onChange: (event) => {
                  const [provider, model] = String(event.target.value).split("\u001f");
                  if (!provider || !model) return;
                  // Effort is dropped on purpose: the words belong to the
                  // adapter that defined them, and "high" on one model is not
                  // "high" on another. 默认 is the honest answer after a switch.
                  save({ summary: { provider, model, effort: "" } });
                },
              },
              modelOptions,
            ),
          ),

          // 强度 — the adapter's own effort list, plus 默认 as the empty
          // string. Offering a word this model does not define would be a lie
          // the host then has to drop on the way in.
          efforts.length > 0
            ? h(
                SetRow,
                { label: t("aiEffort"), hint: t("aiEffortHint") },
                h(
                  "select",
                  {
                    className: "se-set-select",
                    "aria-label": t("aiEffort"),
                    value: chosenEffort,
                    disabled: saving,
                    onChange: (event) => save({ summary: { effort: String(event.target.value) } }),
                  },
                  h("option", { key: "default", value: "", title: t("aiEffortDefaultHint") }, t("aiEffortDefault")),
                  efforts.map((effort) => h("option", { key: effort.id, value: effort.id }, effort.name || effort.id)),
                ),
              )
            : null,
        // 生成哪几项 — what the model is asked to *produce*. The conversation is
        // not a switch: it is the input, always. 标题 is the one field that can be
        // off for the sweep and still be generated per row from the context menu.
        h(
          SetRow,
          { label: t("aiFields"), hint: t("aiFieldsHint") },
          h(
            "div",
            { className: "se-set-choices" },
            [
              ["title", t("aiFieldTitle")],
              ["description", t("aiFieldDescription")],
              ["tags", t("aiFieldTag")],
            ].map(([key, label]) =>
              h(
                "button",
                {
                  key,
                  type: "button",
                  className: "se-set-chip" + (fields[key] ? " on" : ""),
                  "aria-pressed": fields[key] === true,
                  disabled: saving,
                  onClick: () => save({ summary: { fields: { [key]: !fields[key] } } }),
                },
                label,
              ),
            ),
          ),
        ),

        // 一键补齐缺的字段 — the count is on the button, so pressing it is
        // never a guess about how much work it means.
        h(
          SetRow,
          { label: t("aiRunPending"), hint: t("aiRunPendingHint", { pending: formatCount(pending), summaries: formatCount(stored) }) },
          h(
            "div",
            { className: "se-set-choices" },
            running
              ? h("button", { type: "button", className: "se-set-chip", disabled: busy !== "", onClick: stop }, t("aiStop"))
              : h(
                  "button",
                  {
                    type: "button",
                    className: "se-set-chip",
                    disabled: saving || busy !== "" || pending === 0,
                    title: pending === 0 ? t("aiNothingPending") : "",
                    onClick: runPending,
                  },
                  t("aiRunNow", { count: formatCount(pending) }),
                ),
            h(
              "button",
              { type: "button", className: "se-set-chip", disabled: saving, onClick: () => loadCatalog(true) },
              t("aiRefreshModels"),
            ),
          ),
        ),

        // Progress, live, from the same host queue the status bar reads.
        running
          ? h(
              "div",
              { className: "se-set-row" },
              h(
                "div",
                { className: "se-set-main" },
                h("div", { className: "se-set-lbl" }, t("aiRunning", { done: formatCount(state?.done ?? 0), total: formatCount(state?.total ?? 0) })),
                state?.current
                  ? h("div", { className: "se-set-hint" }, t("aiRunningCurrent", { title: state.current.title || state.current.id }))
                  : null,
              ),
            )
          : null,

        // 累计花费 — the lifetime ledger, on the same page as the switch that
        // causes it. Tokens, not money: the price of a token is the provider's
        // business and this plugin does not know it.
        h(
          "div",
          { className: "se-set-row" },
          h(
            "div",
            { className: "se-set-main" },
            h(
              "div",
              { className: "se-set-lbl" },
              t("aiSpend", {
                tokens: formatCompact(spend?.totalTokens ?? 0),
                input: formatCompact(spend?.inputTokens ?? 0),
                output: formatCompact(spend?.outputTokens ?? 0),
              }),
            ),
            h("div", { className: "se-set-hint" }, t("aiSpendHint", { runs: formatCount(spend?.runs ?? 0), failed: formatCount(spend?.failures ?? 0) })),
          ),
        ),

        note
          ? h(
              "div",
              { className: "se-set-row" },
              h("div", { className: "se-set-main" }, h("div", { className: note.kind === "err" ? "se-set-err" : "se-set-note" }, note.text)),
            )
          : null,
        showError
          ? h(
              "div",
              { className: "se-set-row" },
              h(
                "div",
                { className: "se-set-main" },
                h("div", { className: "se-set-err" }, t("aiFailed", { reason: store.error || state?.lastError || catalog.error })),
              ),
            )
          : null,
      );
    }

    function SettingsSection(props) {
      const t = typeof props.t === "function" ? props.t : identityT;
      const [boot, setBoot] = useState({ phase: "loading", data: null, error: null });
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState("");
      const [note, setNote] = useState("");
      // 占用大小 is drawn by the data-directory group, but a component install
      // (~150 MB) and 清理缓存 both write into that same directory from other
      // groups. They bump this counter instead of each fetching /datadir: one
      // reader, one number, refreshed the moment something moved.
      const [dataTick, setDataTick] = useState(0);
      const bumpData = useCallback(() => setDataTick((count) => count + 1), []);

      const load = useCallback(async () => {
        try {
          const data = await apiGet("/settings");
          // The settings page can be the *first* surface a user opens, so it
          // learns the settings counter here instead of waiting for /bootstrap.
          if (Number.isFinite(data?.revision)) revisions.settings = data.revision;
          // 界面语言 — the page itself is drawn in the language it is choosing,
          // and this is the read that tells it which one that is.
          applyUiLang(data?.settings);
          setBoot({ phase: "ready", data, error: null });
        } catch (failure) {
          setBoot({ phase: "error", data: null, error: String(failure?.message ?? failure) });
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      // Every control writes immediately: there is no OK button, so a setting
      // never sits in a half-applied state the user cannot see.
      const save = useCallback(
        async (patch) => {
          setSaving(true);
          setError("");
          setNote("");
          try {
            const result = await apiSend("PUT", "/settings", patch);
            setBoot((previous) =>
              previous.data
                ? { ...previous, data: { ...previous.data, settings: result.settings, revision: result.revision } }
                : previous,
            );
            // 会话界面按钮样式 is drawn by a surface outside this page (the
            // header strip), so the saved choice is pushed to its store now
            // instead of waiting for the strip's next mount.
            headerStyle.set(result.settings?.shell?.header?.style);
            headerStyle.readAt = Date.now();
            // 界面语言 — every label on this page comes from T(), so taking the
            // saved choice here repaints the page in place, before the reply
            // even finishes the state update.
            applyUiLang(result.settings);
            setNote(t("setSaved"));
            return true;
          } catch (failure) {
            setError(String(failure?.message ?? failure));
            // Another surface wrote settings while this page was open: the
            // revision this page holds is dead, so every later control would
            // 409 with the same stale If-Match. Re-read it, exactly like
            // `mutate` does for the panel's own writes.
            if (failure?.code === "revision-conflict") await load();
            return false;
          } finally {
            setSaving(false);
          }
        },
        [t],
      );

      const settings = boot.data?.settings ?? null;
      const actualDir = boot.data?.dataDir ?? "";
      // Whether 独立窗口 is selectable; refreshed by the component group below.
      const componentReady = (boot.data?.capabilities?.component ?? "absent") === "ready";

      if (!settings) {
        return h(
          "div",
          { className: "se-set" },
          h(
            "div",
            { className: "se-set-grp" },
            h("div", { className: "se-set-h" }, boot.phase === "error" ? t("setFailed") : t("setLoading")),
            boot.error ? h("div", { className: "se-set-row" }, h("div", { className: "se-set-err" }, boot.error)) : null,
          ),
        );
      }

      const shell = settings.shell;
      const modal = shell.modal;
      // 折叠子智能体 — a switch, read through one normaliser so it never sits on
      // an unknown value an older settings file could carry.
      const collapseSubagents = settings.list.collapseSubagents !== false;
      const hideBlank = settings.list.hideBlank !== false;
      // Absent on a document written before 默认打开方式 existed; 浮窗 is the
      // default everywhere else, so it is the default shown here too.
      const openChoice = shell.open?.mode === "detached" ? "detached" : "panel";
      // 会话界面按钮样式 — `auto` on a document that predates the key, which is
      // exactly what those builds did.
      const headerChoice = shell.header?.style === "icon" ? "icon" : "auto";
      // 界面语言 — "auto" when the document says so (or predates the key); a
      // code this build cannot draw normalizes to "" and shows 跟随 DSH, which is
      // what the panel is actually doing in that case.
      const uiChoice = normalizeLang(settings.ui?.lang) || "auto";

      return h(
        "div",
        { className: "se-set" },
        // 打开方式 — the first thing the page answers, because it is what the
        // user feels every time they press the sidebar entry. 独立弹窗 is a
        // window this plugin owns; it needs the Electron component, so that chip
        // is offered-but-off until the component group below reports ready.
        h(
          "div",
          { className: "se-set-grp" },
          h("div", { className: "se-set-h" }, t("setGroupOpen")),
          h(
            SetRow,
            { label: t("setOpenMode"), hint: t("setOpenModeHint") },
            h(SetChips, {
              value: openChoice,
              disabled: saving,
              options: [
                { value: "panel", label: t("setOpenPanel"), title: t("setOpenPanelHint") },
                {
                  value: "detached",
                  label: t("setOpenDetached"),
                  title: componentReady ? t("setOpenDetachedHint") : t("setOpenDetachedBlocked"),
                  disabled: !componentReady,
                },
              ],
              onPick: (mode) => save({ shell: { open: { mode } } }),
            }),
          ),
          openChoice === "detached" && !componentReady
            ? h("div", { className: "se-set-warn" }, t("setOpenDetachedBlocked"))
            : null,
        ),

        // 列表 — the two switches the 更多 menu also toggles. They live here as
        // the full explanation; the menu is a shortcut to the same document.
        h(
          "div",
          { className: "se-set-grp" },
          h("div", { className: "se-set-h" }, t("setGroupList")),
          h(
            SetRow,
            { label: t("setAutoCollapse"), hint: t("setAutoCollapseHint") },
            h(SetSwitch, {
              on: settings.list.autoCollapse,
              disabled: saving,
              title: t("setAutoCollapse"),
              onToggle: (autoCollapse) => save({ list: { autoCollapse } }),
            }),
          ),
          h(
            SetRow,
            { label: t("setShowArchived"), hint: t("setShowArchivedHint") },
            h(SetSwitch, {
              on: settings.list.showArchived,
              disabled: saving,
              title: t("setShowArchived"),
              onToggle: (showArchived) => save({ list: { showArchived } }),
            }),
          ),
          // 过滤空会话 — a session that never started a turn is not a
          // conversation: it is what closing the window before typing leaves
          // behind, and it only pads the list. On by default.
          h(
            SetRow,
            { label: t("setHideBlank"), hint: t("setHideBlankHint") },
            h(SetSwitch, {
              on: hideBlank,
              disabled: saving,
              title: t("setHideBlank"),
              onToggle: (value) => save({ list: { hideBlank: value } }),
            }),
          ),
          // 折叠子智能体 — the children of a delegation are not sessions the user
          // can act on, so they fold under the parent by default. Off keeps the
          // whole subtree visible for a reader who wants to watch the run.
          h(
            SetRow,
            { label: t("setSubagents"), hint: t("setSubagentsHint") },
            h(SetSwitch, {
              on: collapseSubagents,
              disabled: saving,
              title: t("setSubagents"),
              onToggle: (value) => save({ list: { collapseSubagents: value } }),
            }),
          ),
        ),

        // 显示 — how a row spells what it already knows: a timestamp and a size.
        // Neither setting changes what the panel reads, only how it is written,
        // so they sit together and stay out of the 列表 group.
        h(
          "div",
          { className: "se-set-grp" },
          h("div", { className: "se-set-h" }, t("setGroupDisplay")),
          // 界面语言 — the one display choice that is about the words rather than
          // the numbers. It sits first because every other row on this page is
          // drawn in it. A select, not chips: ten languages plus 跟随 DSH would
          // push a chip row past the dialog's width.
          h(
            SetRow,
            { label: t("setUiLang"), hint: t("setUiLangHint") },
            h(
              "select",
              {
                className: "se-set-select",
                "aria-label": t("setUiLang"),
                value: uiChoice,
                disabled: saving,
                onChange: (event) => save({ ui: { lang: String(event.target.value) } }),
              },
              h("option", { key: "auto", value: "auto" }, t("setUiLangAuto")),
              // A picker lists a language in its own words: that is what
              // settings.langName carries in every dictionary, so the names
              // travel with the tables instead of sitting as literals here.
              LANGS.map((code) =>
                h("option", { key: code, value: code }, DICTS[code]?.settings?.langName ?? code),
              ),
            ),
          ),
          h(
            SetRow,
            { label: t("setDateFormat"), hint: t("setDateFormatHint") },
            h(SetChips, {
              value: settings.list.dateFormat === "relative" ? "relative" : "date",
              disabled: saving,
              options: [
                { value: "date", label: t("setDateDetail"), title: t("setDateDetailHint") },
                { value: "relative", label: t("setDateRelative"), title: t("setDateRelativeHint") },
              ],
              onPick: (dateFormat) => save({ list: { dateFormat } }),
            }),
          ),
          h(
            SetRow,
            { label: t("setSizeFormat"), hint: t("setSizeFormatHint") },
            h(SetChips, {
              value: settings.list.sizeFormat === "kb" ? "kb" : "auto",
              disabled: saving,
              options: [
                { value: "auto", label: t("setSizeAuto"), title: t("setSizeAutoHint") },
                { value: "kb", label: t("setSizeKb"), title: t("setSizeKbHint") },
              ],
              onPick: (sizeFormat) => save({ list: { sizeFormat } }),
            }),
          ),
        ),

        // 搜索索引 — 会话内容的 index: whether it is kept, built while idle, rebuilt
        // now, or dropped. Placed with 显示 because both are about the reading
        // of the list rather than about the shell it sits in.
        h(IndexGroup, { t, settings, saving, save }),

        // AI 字段 — sits next to 搜索索引 because both are about
        // reading the library rather than about how the panel looks: one reads
        // the logs to search them, the other reads them to write a summary.
        h(SummaryGroup, { t, settings, saving, save }),

        // 会话界面 — how the five buttons this plugin adds to DSH's conversation
        // header are labelled. 自动 is the shipped responsive rule (words while
        // they fit); 仅显示图标 is for users who know the glyphs.
        h(
          "div",
          { className: "se-set-grp" },
          h("div", { className: "se-set-h" }, t("setGroupHeader")),
          h(
            SetRow,
            { label: t("setHeaderStyle"), hint: t("setHeaderStyleHint") },
            h(SetChips, {
              value: headerChoice,
              disabled: saving,
              options: [
                { value: "auto", label: t("setHeaderAuto"), title: t("setHeaderAutoHint") },
                { value: "icon", label: t("setHeaderIcon"), title: t("setHeaderIconHint") },
              ],
              onPick: (style) => save({ shell: { header: { style } } }),
            }),
          ),
        ),

        h(
          "div",
          { className: "se-set-grp" },
          h("div", { className: "se-set-h" }, t("setGroupModal")),
          h(
            SetRow,
            { label: t("setSizing"), hint: t("setSizingHint") },
            h(SetChips, {
              value: modal.sizing,
              disabled: saving,
              options: [
                { value: "fixed", label: t("setSizingFixed"), title: t("setSizingFixedHint") },
                { value: "percent", label: t("setSizingPercent"), title: t("setSizingPercentHint") },
              ],
              onPick: (sizing) => save({ shell: { modal: { sizing } } }),
            }),
          ),
          h(
            SetRow,
            { label: t("setSize"), hint: modal.sizing === "percent" ? t("setSizePercentHint") : t("setSizeHint") },
            h(SetChips, {
              value: modal.sizing === "percent" ? modal.percent : modal.size,
              disabled: saving,
              options: modal.sizing === "percent"
                ? [
                    { value: "p50", label: t("setSizeP50") },
                    { value: "p70", label: t("setSizeP70") },
                    { value: "p85", label: t("setSizeP85") },
                    { value: "p100", label: t("setSizeP100") },
                  ]
                : [
                    { value: "sm", label: t("setSizeSm") },
                    { value: "md", label: t("setSizeMd") },
                    { value: "lg", label: t("setSizeLg") },
                    { value: "xl", label: t("setSizeXl") },
                  ],
              onPick: (value) =>
                save({ shell: { modal: modal.sizing === "percent" ? { percent: value } : { size: value } } }),
            }),
          ),
          h(
            SetRow,
            { label: t("setDim"), hint: t("setDimHint") },
            h(DimSlider, {
              value: modal.dim,
              disabled: saving,
              onCommit: (dim) => save({ shell: { modal: { dim } } }),
            }),
          ),
          h(
            SetRow,
            { label: t("setCloseOnBackdrop") },
            h(SetSwitch, {
              on: modal.closeOnBackdrop,
              disabled: saving,
              title: t("setCloseOnBackdrop"),
              onToggle: (closeOnBackdrop) => save({ shell: { modal: { closeOnBackdrop } } }),
            }),
          ),
        ),

        // Electron 组件 — the optional Electron runtime 独立窗口 needs. Its own
        // section, because it carries weight and a progress bar that must not be
        // mixed into the presentation switches.
        h(ComponentGroup, {
          t,
          component: null,
          onDataChanged: bumpData,
          onChanged: (next) => {
            // The mode chips above were rendered from the first snapshot; a
            // component that just became ready must enable 独立窗口 without a
            // reload, so the readiness is folded into the same boot state.
            setBoot((previous) =>
              previous.data
                ? {
                    ...previous,
                    data: {
                      ...previous.data,
                      capabilities: { ...(previous.data.capabilities ?? {}), component: next.phase },
                    },
                  }
                : previous,
            );
          },
        }),

        h(DataDirGroup, { t, current: actualDir, onMigrated: load, saving, refreshToken: dataTick }),

        // 关于 — which build this is, whether a newer one exists, what can be
        // freed, and where the project lives. Last, because it is the only group
        // that is not about how the panel behaves.
        h(AboutGroup, { t, version: boot.data?.version ?? "", onDataChanged: bumpData }),

        // 危险操作 — its own section, last, because it is the only thing on this
        // page that cannot be undone and it must not sit next to a chip that
        // merely frees some cache.
        h(DangerGroup, {
          t,
          onReset: () => {
            // 清除数据 empties the directory the size row is describing.
            load();
            bumpData();
          },
        }),

        h(
          "div",
          { className: "se-set-foot" },
          saving ? h("span", { className: "se-set-note" }, t("setSaving")) : null,
          error ? h("span", { className: "se-set-err" }, error) : null,
          !saving && !error && note ? h("span", { className: "se-set-note" }, note) : null,
        ),
      );
    }

