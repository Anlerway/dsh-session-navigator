    // ── Settings page ──────────────────────────────────────────────────────
    // Registered on the `settings.section` list slot. The label is a thunk so a
    // language switch re-renders the nav entry without re-registering the slot;
    // that is what DSH's own sections do (packages/client/ui-agent-preset).
    //
    // The page reads its own copy of the settings document instead of sharing
    // the panel's /bootstrap: it mounts in the settings window, which may be open
    // while the panel is closed, and it must not pay for a session scan.

    // Client-side service lookup. DSH exposes services both as `ctx.get(name)`
    // and as `ctx[name]`; the settings page needs `uiWorkspace` for the native
    // directory picker, and it must degrade to a message (not a crash) on a build
    // that does not provide it.
    let hostCtx = null;

    /**
     * The panel's side of the bridge.
     *
     * The handler lives at module scope because the subscription is created once
     * in `apply`; the panel publishes the actual functions here while it is
     * mounted and clears them on unmount. A command that arrives in between is
     * acted on by *opening* the panel first, which mounts it and re-publishes —
     * so the only case this loses is a command racing the mount, and the store
     * already asked for the panel by then.
     */
    const bridgeActions = { openSession: null, newSession: null, windowClosed: null, windowOpened: null, reveal: null };

    /**
     * Follow a token's `var()` references down to a colour the window can use.
     *
     * DSH does not store colours in `--dsw-alias-*`: it stores references into
     * its own palette (`--dsw-alias-label-primary: var(--dsw-static-neutral-bluish-50)`).
     * The detached window has no `--dsw-static-*` stylesheet, so a reference
     * copied there resolves to nothing and the property ends up *invalid*, not
     * *missing* — which the window cannot fall back from. Resolve here, where
     * the palette is visible, and hand over the concrete value.
     *
     * Returns `""` when a reference cannot be resolved, so the Host drops the
     * token and the window keeps its own fallback instead of getting a dud.
     *
     * @param {CSSStyleDeclaration} computed style of the element that owns the palette
     * @param {string} value the raw custom-property value
     * @returns {string}
     */
    function resolveThemeValue(computed, value) {
      let current = String(value ?? "").trim();
      // Depth-bounded: a palette that references itself must not spin.
      for (let depth = 0; depth < 8; depth += 1) {
        if (!current.includes("var(")) return current;
        let resolved = false;
        const next = current.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name, fallback) => {
          const referenced = computed.getPropertyValue(name);
          if (referenced && referenced.trim()) {
            resolved = true;
            return referenced.trim();
          }
          if (fallback && fallback.trim()) {
            resolved = true;
            return fallback.trim();
          }
          return whole;
        });
        if (!resolved) return "";
        current = next;
      }
      return current.includes("var(") ? "" : current;
    }

    /**
     * Read the tokens the window's stylesheets actually use and hand them to the Host.
     *
     * Only those tokens are read (not a scrape of the app's whole custom-property
     * set), and the value is taken from the *shell*, so a theme scoped to the app
     * surface is reflected exactly as the panel sees it.
     *
     * Which element that is matters: DSH declares its palette on `body`, so a
     * read from `documentElement` sees an empty palette, and at apply time the
     * panel is not mounted yet either. `body` is therefore the fallback, and
     * the panel reports again once its shell exists (see Panel).
     *
     * @returns {Promise<void>}
     */
    async function reportTheme() {
      if (typeof document === "undefined" || typeof getComputedStyle !== "function") return;
      try {
        const element = typeof document.querySelector === "function" ? document.querySelector(".se-shell") : null;
        const source = element ?? document.body ?? document.documentElement;
        if (!source) return;
        const computed = getComputedStyle(source);
        const tokens = {};
        for (const name of THEME_TOKENS) {
          const value = resolveThemeValue(computed, computed.getPropertyValue(name));
          if (value) tokens[name] = value;
        }
        const mode = document.documentElement?.getAttribute("data-theme") === "light" ? "light" : "dark";
        await fetch(API + "/theme", {
          method: "POST",
          credentials: "same-origin",
          headers: { accept: "application/json", "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ mode, tokens }),
        });
      } catch {
        /* the window keeps its fallbacks when this does not land */
      }
    }

    function serviceOf(name) {
      if (!hostCtx) return null;
      try {
        const viaGet = typeof hostCtx.get === "function" ? hostCtx.get(name) : null;
        if (viaGet) return viaGet;
      } catch {
        /* `ctx.get` is not universal; fall through to the property accessor */
      }
      try {
        return hostCtx[name] ?? null;
      } catch {
        // A service that is declared but not yet activated throws on access.
        return null;
      }
    }

    function SetRow({ label, hint, children }) {
      return h(
        "div",
        { className: "se-set-row" },
        h(
          "div",
          { className: "se-set-main" },
          h("div", { className: "se-set-lbl" }, label),
          hint ? h("div", { className: "se-set-hint" }, hint) : null,
        ),
        children,
      );
    }

    function SetChips({ options, value, onPick, disabled }) {
      return h(
        "div",
        { className: "se-set-choices" },
        options.map((option) =>
          h(
            "button",
            {
              key: option.value,
              type: "button",
              className: "se-set-chip" + (option.value === value ? " on" : ""),
              title: option.title,
              disabled: disabled === true || option.disabled === true,
              onClick: () => onPick(option.value),
            },
            option.label,
          ),
        ),
      );
    }

    function SetSwitch({ on, onToggle, disabled, title }) {
      return h("button", {
        type: "button",
        className: "se-set-switch" + (on ? " on" : ""),
        title,
        "aria-pressed": on === true,
        disabled: disabled === true,
        onClick: () => onToggle(!on),
      });
    }

    // The data-directory group owns its own request cycle: a migration is a
    // long operation with a pre-flight the rest of the page has no business
    // knowing about, and a failure here must not blank the other settings.
    function DataDirGroup({ t, current, onMigrated, saving, refreshToken }) {
      const [state, setState] = useState({ phase: "loading", data: null, error: "" });
      const [plan, setPlan] = useState(null);
      const [busy, setBusy] = useState("");
      const [error, setError] = useState("");
      const [note, setNote] = useState("");

      const load = useCallback(async () => {
        try {
          const data = await apiGet("/datadir");
          setState({ phase: "ready", data, error: "" });
        } catch (failure) {
          setState({ phase: "error", data: null, error: String(failure?.message ?? failure) });
        }
      }, []);

      // `refreshToken` is the page saying something under this directory moved —
      // a component install, 清理缓存, 清除数据. The size row is this group's, so the
      // re-read happens here rather than in every group that can move bytes.
      useEffect(() => {
        load();
      }, [load, refreshToken]);

      // The picker is a Host primitive on `uiWorkspace`; the desktop build routes
      // it to the native dialog through `__DSH_DIRECTORY_PICKER__`. Resolved at
      // click time so a plugin loaded before that service still works.
      const choose = useCallback(async () => {
        const workspace = serviceOf("uiWorkspace");
        if (!workspace || typeof workspace.pickDirectory !== "function") {
          setError(t("setPickUnavailable"));
          return;
        }
        setError("");
        setNote("");
        let target;
        try {
          target = await workspace.pickDirectory();
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          return;
        }
        // A dismissed dialog is a no-op, not an error.
        if (typeof target !== "string" || target === "") return;
        setBusy("inspect");
        try {
          setPlan(await apiSend("POST", "/datadir/inspect", { target }));
        } catch (failure) {
          setPlan(null);
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy("");
        }
      }, [t]);

      // 还原至默认位置 rides the same inspect → plan → migrate cycle; only the
      // target differs, and the client never builds that path itself — the home
      // directory is the host's business.
      const restore = useCallback(async () => {
        const target = state.data?.defaultDir;
        if (typeof target !== "string" || target === "") return;
        setBusy("inspect");
        setError("");
        setNote("");
        try {
          setPlan(await apiSend("POST", "/datadir/inspect", { target }));
        } catch (failure) {
          setPlan(null);
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy("");
        }
      }, [state.data]);

      const migrate = useCallback(async () => {
        if (!plan) return;
        const restoring = plan.isDefault === true;
        setBusy("migrate");
        setError("");
        setNote("");
        try {
          const result = await apiSend("POST", "/datadir/migrate", { target: plan.target, mode: plan.mode });
          setPlan(null);
          setNote(
            t(restoring ? "setDataDirRestored" : result.mode === "move" ? "setDataDirMoved" : "setDataDirCopied"),
          );
          await load();
          onMigrated?.();
        } catch (failure) {
          // The host rolls back on its own; the message says what was kept.
          setError(t("setDataDirFailed") + " " + String(failure?.message ?? failure));
        } finally {
          setBusy("");
        }
      }, [plan, load, onMigrated, t]);

      const data = state.data;
      const sizeText = data ? formatSize(data.sizeBytes) : "";
      // The confirmation under the row speaks the action the user asked for:
      // coming home is a restore, going anywhere else is a migration.
      const restoring = plan?.isDefault === true;

      return h(
        "div",
        { className: "se-set-grp" },
        h("div", { className: "se-set-h" }, t("setGroupData")),
        h(
          SetRow,
          { label: t("setDataDir"), hint: t("setDataDirHint") },
          h("span", { className: "se-set-path" }, current || t("setDataDirDefault")),
          h(
            "div",
            { className: "se-set-choices" },
            // 还原至默认位置 only when there is somewhere to go back to: already
            // at the default path, or pinned by DSH_SE_DATA_DIR, and the button
            // would either be a no-op or a lie.
            data?.restorable
              ? h(
                  "button",
                  { type: "button", className: "se-set-chip", disabled: busy !== "" || saving, onClick: restore },
                  t("setDataDirRestore"),
                )
              : null,
            h(
              "button",
              {
                type: "button",
                className: "se-set-chip",
                // A migration moves the directory every setting is written to, so
                // it may not start while a settings write is still in flight: the
                // two orders leave a settings file in the old directory and a
                // "已迁移" hint that says it went with the rest.
                disabled: busy !== "" || saving || state.phase === "loading",
                onClick: choose,
              },
              busy === "inspect" ? t("setDataDirInspecting") : t("setDataDirChange"),
            ),
          ),
        ),
        data
          ? h(
              SetRow,
              { label: t("setDataDirSize") },
              h("span", { className: "se-set-path" }, sizeText || "-"),
              data.fromEnv ? h("span", { className: "se-set-hint" }, t("setEnvOverride")) : null,
            )
          : null,
        plan
          ? h(
              "div",
              { className: "se-set-row" },
              h(
                "div",
                { className: "se-set-main" },
                h("div", { className: "se-set-lbl" }, t(restoring ? "setDataDirRestoreConfirm" : "setDataDirConfirm")),
                h("div", { className: "se-set-path" }, plan.target),
                h(
                  "div",
                  { className: "se-set-hint" },
                  t(plan.mode === "move" ? "setDataDirPlanMove" : "setDataDirPlanCopy"),
                ),
              ),
              h(
                "div",
                { className: "se-set-choices" },
                h(
                  "button",
                  { type: "button", className: "se-set-chip", disabled: busy !== "" || saving, onClick: () => setPlan(null) },
                  t("setCancel"),
                ),
                h(
                  "button",
                  { type: "button", className: "se-set-chip on", disabled: busy !== "" || saving, onClick: migrate },
                  busy === "migrate"
                    ? t(restoring ? "setDataDirRestoring" : "setDataDirMoving")
                    : t(restoring ? "setDataDirRestoreGo" : "setDataDirGo"),
                ),
              ),
            )
          : null,
        error ? h("div", { className: "se-set-row" }, h("div", { className: "se-set-err" }, error)) : null,
        state.error ? h("div", { className: "se-set-row" }, h("div", { className: "se-set-err" }, state.error)) : null,
        note ? h("div", { className: "se-set-row" }, h("div", { className: "se-set-note" }, note)) : null,
      );
    }


