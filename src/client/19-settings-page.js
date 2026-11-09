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

    function SetRow({ label, hint, children, stack }) {
      return h(
        "div",
        { className: "se-set-row" + (stack ? " se-set-row-stack" : "") },
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

    // A face picker, not a chip row: the choice is a picture, and five words in
    // a row would make the user read the file names to know what they get.
    function SetBallStyles({ options, value, onPick, disabled }) {
      return h(
        "div",
        { className: "se-set-balls" },
        options.map((option) =>
          h(
            "button",
            {
              key: option.value,
              type: "button",
              className: "se-set-ball" + (option.value === value ? " on" : ""),
              "aria-pressed": option.value === value,
              title: option.label,
              disabled: disabled === true,
              onClick: () => onPick(option.value),
            },
            h("img", { src: option.src, alt: "", "aria-hidden": "true", draggable: false }),
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
    // 清理缓存 lives here too: it frees bytes under this directory, so the size
    // row right above it is the only honest place to report the result.
    function DataDirGroup({ t, current, onMigrated, saving, refreshToken }) {
      const [state, setState] = useState({ phase: "loading", data: null, error: "" });
      const [plan, setPlan] = useState(null);
      const [busy, setBusy] = useState("");
      const [error, setError] = useState("");
      const [note, setNote] = useState("");
      const [cache, setCache] = useState({ phase: "idle", data: null, error: "" });
      const [cleaning, setCleaning] = useState(false);

      const load = useCallback(async () => {
        try {
          const data = await apiGet("/datadir");
          setState({ phase: "ready", data, error: "" });
        } catch (failure) {
          setState({ phase: "error", data: null, error: String(failure?.message ?? failure) });
        }
      }, []);

      // `refreshToken` is the page saying something under this directory moved —
      // a component install or 清除数据. The size row is this group's, so the
      // re-read happens here rather than in every group that can move bytes.
      useEffect(() => {
        load();
      }, [load, refreshToken]);

      // 清理缓存 — the plugin's derived caches only; sessions, logs and the
      // component download stay. Not a settings write, so no revision is cited:
      // citing one would 409 a clear just because a switch was toggled in
      // another window.
      const clearCache = useCallback(async () => {
        setCleaning(true);
        setCache({ phase: "idle", data: null, error: "" });
        try {
          const data = await apiSend("POST", "/cache/clear", {}, { ifMatch: false });
          setCache({ phase: "ready", data, error: "" });
          // The size row above is the number this button changes; read it again.
          await load();
        } catch (failure) {
          setCache({ phase: "error", data: null, error: String(failure?.message ?? failure) });
        } finally {
          setCleaning(false);
        }
      }, [load]);

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
      const freed = cache.data?.freedBytes ?? 0;
      const skipped = Array.isArray(cache.data?.skipped) ? cache.data.skipped : [];
      // Spelled out rather than counted: "1.2 MB" is what the user came for, and
      // "0 B" reads as a failure when in fact there was nothing to clear.
      const freedText = freed > 0 ? formatSize(freed) : "";
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
        h(
          SetRow,
          { label: t("setCacheClear"), hint: t("setCacheClearHint") },
          h(
            "button",
            { type: "button", className: "se-set-chip", disabled: cleaning, onClick: clearCache },
            cleaning ? t("setCacheClearing") : t("setCacheGo"),
          ),
        ),
        cache.phase === "ready"
          ? h(
              "div",
              { className: "se-set-row" },
              h(
                "div",
                { className: "se-set-main" },
                h("div", { className: "se-set-note" }, freedText ? t("setCacheFreed", { size: freedText }) : t("setCacheFreedNone")),
                skipped.includes("component-busy") ? h("div", { className: "se-set-hint" }, t("setCacheSkipped")) : null,
                skipped.includes("window-open") ? h("div", { className: "se-set-hint" }, t("setCacheWindowOpen")) : null,
              ),
            )
          : null,
        cache.phase === "error"
          ? h(
              "div",
              { className: "se-set-row" },
              h("div", { className: "se-set-main" }, h("div", { className: "se-set-err" }, t("setCacheFailed", { reason: cache.error }))),
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


    // 独立窗口美化 — one limit the client knows about: 模糊度, 磨砂度 and 壁纸暗度
    // are percentages, 0–100 (src/domain/settings.js MAX_WALLPAPER_PERCENT). The
    // file itself has no ceiling here: how large a wallpaper may be is a fact
    // about the disk, and only the host can read that (src/routes/wallpaper.js
    // RESERVE_BYTES).
    const WALLPAPER_MAX_PERCENT = 100;

    // Where the three sliders start: the picture sharp, the panel two-thirds
    // solid, a touch of shade under the text. Mirrors defaultSettings().wallpaper
    // in src/domain/settings.js — the panel and the window must agree on what
    // "untouched" looks like.
    const WALLPAPER_DEFAULT_BLUR = 0;
    const WALLPAPER_DEFAULT_FROST = 60;
    const WALLPAPER_DEFAULT_DIM = 10;

    // ── 独立窗口美化 ─────────────────────────────────────────────────────
    // The picture under the panel in the detached window. Three things decide
    // what is drawn, in this order: 美化 off means nothing at all; a custom file
    // wins over whatever DSH's wallpaper plugin selected; otherwise the window
    // mirrors that plugin, and 跟随壁纸插件 off leaves the window without one.
    //
    // The upload is not a settings write: a picture is megabytes and a video is
    // more, so the file is the body of its own request and the host streams it
    // to disk (see src/routes/wallpaper.js). The row keeps its own copy of the
    // file's name and size, because /settings only carries the name and a name
    // whose file was deleted answers "nothing" — which is what GET /wallpaper
    // asks, instead of trusting the document.
    function WallpaperGroup({ t, settings, save, saving, onChanged }) {
      const wallpaper =
        settings?.wallpaper ??
        {
          enabled: true,
          blur: WALLPAPER_DEFAULT_BLUR,
          frost: WALLPAPER_DEFAULT_FROST,
          dim: WALLPAPER_DEFAULT_DIM,
          sync: true,
          custom: "",
          customName: "",
        };
      // "checking" until the wallpaper plugin answers: a switch that appears on
      // and then goes dead is worse than one that arrives a moment late.
      const [probe, setProbe] = useState("checking");
      const [file, setFile] = useState(null);
      const [busy, setBusy] = useState("");
      const [error, setError] = useState("");
      const [note, setNote] = useState("");

      const loadFile = useCallback(async () => {
        try {
          const data = await apiGet("/wallpaper");
          setFile(data?.file ?? null);
        } catch {
          // No file, no row: not worth an error banner.
          setFile(null);
        }
      }, []);

      useEffect(() => {
        void loadFile();
      }, [loadFile]);

      useEffect(() => {
        // dsh-plugin-wallpaper-engine owns /wallpaper-engine/*. This plugin does
        // not depend on it, so absence is a normal answer and 跟随壁纸插件 is
        // simply not offered.
        let alive = true;
        (async () => {
          try {
            const response = await fetch("/wallpaper-engine/settings", {
              credentials: "same-origin",
              cache: "no-store",
              headers: { accept: "application/json" },
            });
            if (alive) setProbe(response.ok ? "present" : "absent");
          } catch {
            if (alive) setProbe("absent");
          }
        })();
        return () => {
          alive = false;
        };
      }, []);

      const upload = useCallback(
        async (chosen) => {
          setBusy("upload");
          setError("");
          setNote("");
          try {
            const name = typeof chosen?.name === "string" && chosen.name !== "" ? chosen.name : "wallpaper";
            /** @type {Record<string, string>} */
            const headers = { accept: "application/json" };
            // The browser sends the file's own type; the host needs it only as a
            // fallback for a file name without an extension.
            if (typeof chosen?.type === "string" && chosen.type !== "") headers["content-type"] = chosen.type;
            if (Number.isFinite(revisions.settings)) headers["if-match"] = '"' + revisions.settings + '"';
            const response = await fetch(API + "/wallpaper/custom?name=" + encodeURIComponent(name), {
              method: "POST",
              credentials: "same-origin",
              headers,
              body: chosen,
            });
            const payload = await response.json().catch(() => null);
            if (!payload || payload.ok !== true) {
              const failure = new Error(payload?.error ?? "HTTP " + response.status);
              failure.code = payload?.code ?? "bad-request";
              throw failure;
            }
            const written = payload.result?.revision;
            if (Number.isFinite(written)) revisions.settings = written;
            setFile(payload.result?.file ?? null);
            setNote(t("setWallpaperUploaded"));
            // The document now names a file, so re-read it: the switch next door
            // must not save a stale copy back over this change.
            await onChanged?.();
          } catch (failure) {
            setError(String(failure?.message ?? failure));
          } finally {
            setBusy("");
          }
        },
        [onChanged, t],
      );

      const pick = useCallback(() => {
        setError("");
        setNote("");
        const doc = typeof document !== "undefined" ? document : null;
        if (!doc || typeof doc.createElement !== "function") return;
        const input = doc.createElement("input");
        input.type = "file";
        input.accept = "image/*,video/*";
        input.style.display = "none";
        const done = () => {
          if (typeof input.remove === "function") input.remove();
        };
        input.addEventListener("change", () => {
          const chosen = input.files && input.files[0];
          done();
          // A dismissed dialog is not an error.
          if (!chosen) return;
          void upload(chosen);
        });
        if (doc.body && typeof doc.body.appendChild === "function") doc.body.appendChild(input);
        if (typeof input.click === "function") input.click();
      }, [t, upload]);

      const remove = useCallback(async () => {
        setBusy("clear");
        setError("");
        setNote("");
        try {
          const result = await apiSend("DELETE", "/wallpaper/custom", undefined);
          if (Number.isFinite(result?.revision)) revisions.settings = result.revision;
          setFile(null);
          setNote(t("setWallpaperCleared"));
          await onChanged?.();
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy("");
        }
      }, [onChanged, t]);

      const enabled = wallpaper.enabled !== false;
      const mirroring = wallpaper.sync !== false;
      return h(
        "div",
        { className: "se-set-grp" },
        h("div", { className: "se-set-h" }, t("setGroupWallpaper")),
        h(
          SetRow,
          { label: t("setWallpaperOn"), hint: t("setWallpaperOnHint") },
          h(SetSwitch, {
            on: enabled,
            disabled: saving,
            title: t("setWallpaperOn"),
            onToggle: (next) => save({ wallpaper: { enabled: next } }),
          }),
        ),
        h(
          SetRow,
          { label: t("setWallpaperBlur"), hint: t("setWallpaperBlurHint") },
          h(RangeControl, {
            t,
            label: "setWallpaperBlur",
            min: 0,
            max: WALLPAPER_MAX_PERCENT,
            step: 1,
            suffix: " %",
            value: Number.isFinite(wallpaper.blur) ? wallpaper.blur : WALLPAPER_DEFAULT_BLUR,
            fallback: WALLPAPER_DEFAULT_BLUR,
            // A slider keeps working while a write is out: it owns its own
            // number, and disabling it mid-drag would drop the gesture.
            disabled: !enabled,
            onCommit: (blur) => save({ wallpaper: { blur } }),
          }),
        ),
        h(
          SetRow,
          { label: t("setWallpaperFrost"), hint: t("setWallpaperFrostHint") },
          h(RangeControl, {
            t,
            label: "setWallpaperFrost",
            min: 0,
            max: WALLPAPER_MAX_PERCENT,
            step: 1,
            suffix: " %",
            value: Number.isFinite(wallpaper.frost) ? wallpaper.frost : WALLPAPER_DEFAULT_FROST,
            fallback: WALLPAPER_DEFAULT_FROST,
            disabled: !enabled,
            onCommit: (frost) => save({ wallpaper: { frost } }),
          }),
        ),
        h(
          SetRow,
          { label: t("setWallpaperDim"), hint: t("setWallpaperDimHint") },
          h(RangeControl, {
            t,
            label: "setWallpaperDim",
            min: 0,
            max: WALLPAPER_MAX_PERCENT,
            step: 1,
            suffix: " %",
            value: Number.isFinite(wallpaper.dim) ? wallpaper.dim : WALLPAPER_DEFAULT_DIM,
            fallback: WALLPAPER_DEFAULT_DIM,
            disabled: !enabled,
            onCommit: (dim) => save({ wallpaper: { dim } }),
          }),
        ),
        h(
          SetRow,
          {
            label: t("setWallpaperSync"),
            hint: probe === "absent" ? t("setWallpaperSyncMissing") : t("setWallpaperSyncHint"),
          },
          h(SetSwitch, {
            on: mirroring,
            disabled: saving || !enabled || probe !== "present",
            title: t("setWallpaperSync"),
            onToggle: (next) => save({ wallpaper: { sync: next } }),
          }),
        ),
        h(
          SetRow,
          { label: t("setWallpaperCustom"), hint: t("setWallpaperCustomHint") },
          h(
            "div",
            { className: "se-set-choices" },
            h(
              "button",
              { type: "button", className: "se-set-chip", disabled: saving || busy !== "", onClick: pick },
              busy === "upload" ? t("setWallpaperUploading") : file ? t("setWallpaperReplace") : t("setWallpaperPick"),
            ),
            file
              ? h(
                  "button",
                  { type: "button", className: "se-set-chip", disabled: saving || busy !== "", onClick: remove },
                  busy === "clear" ? t("setWallpaperClearing") : t("setWallpaperClear"),
                )
              : null,
          ),
        ),
        file
          ? h(
              "div",
              { className: "se-set-row" },
              h("div", { className: "se-set-path" }, file.name + " · " + formatSize(file.bytes)),
            )
          : null,
        error ? h("div", { className: "se-set-row" }, h("div", { className: "se-set-err" }, error)) : null,
        note ? h("div", { className: "se-set-row" }, h("div", { className: "se-set-note" }, note)) : null,
      );
    }
    // A percentage control you can read, not just drag.
    //
    // A bare <input type=range> is a poor way to land on one number out of a
    // hundred: at 150 px a step is under two pixels, the thumb is nine wide,
    // and the only feedback is where the knob sits. So the track carries the
    // accent colour up to the current value, the thumb is a 14 px target with
    // an accent ring, and the number beside it is a field — click it, type 72,
    // press Enter, the way a design tool works. The 回退 chip is always on the
    // row — dimmed while the number already is the default — because a chip that
    // comes and goes changes the row's width under the hand, and because "back to
    // the default" is otherwise a pixel hunt.
    //
    // Writing stays one write per gesture: a drag moves the local number only,
    // and the host hears about it on release — or 300 ms after the last move,
    // for the drags that never send a pointerup. 遮罩黑度 is the same control
    // with its own range, which is why `percent` exists: that setting holds
    // 0–0.8 and reads 0–80 %.
    const RANGE_COMMIT_MS = 300;

    /** 遮罩黑度's ceiling — 0–0.8, the same number as src/domain/settings.js MAX_DIM. */
    const DIM_MAX = 0.8;

    /** Snap to a step and stay inside the range — 0.05 steps land on float noise. */
    function snapRange(min, max, step, raw) {
      if (!Number.isFinite(raw)) return min;
      const snapped = Math.round((raw - min) / step) * step + min;
      return Math.min(max, Math.max(min, Number(snapped.toFixed(6))));
    }

    /**
     * @param {{
     *   t: (key: string) => string, label: string, min: number, max: number,
     *   step: number, suffix: string, percent?: boolean, value: number,
     *   fallback?: number, disabled?: boolean,
     *   onCommit: (value: number) => Promise<boolean> | boolean | undefined,
     * }} props
     */
    function RangeControl({ t, label, min, max, step, suffix, percent, value, fallback, onCommit, disabled }) {
      const [draft, setDraft] = useState(value);
      // The field's own text while it is being typed into. `null` means "follow
      // the slider", which is what every re-render between gestures shows.
      const [typing, setTyping] = useState(null);
      const timer = useRef(null);
      // The number the host is known to hold for this setting.
      const lastSent = useRef(value);
      // The number under the handle, readable from a callback that outlived its
      // render — a pointerup that fires before React re-rendered would otherwise
      // write the previous number back over the one the finger is on.
      const shown = useRef(value);
      // A finger is on the handle: the gesture owns the number, not the host.
      const holding = useRef(false);
      // Writes this control started that have not answered yet.
      const waiting = useRef(0);

      const move = useCallback((next) => {
        shown.current = next;
        setDraft(next);
      }, []);

      // Between gestures the host is the truth, so another surface's write lands
      // here. An answer that arrives mid-drag, or while a newer write is still
      // out, is older than the handle and must not move it — that is what used
      // to make a released slider jump to a number nobody asked for.
      useEffect(() => {
        if (holding.current || waiting.current > 0) return;
        lastSent.current = value;
        move(value);
      }, [value, move]);

      const stop = useCallback(() => {
        if (timer.current !== null) {
          clearTimeout(timer.current);
          timer.current = null;
        }
      }, []);

      const flush = useCallback(
        async (next) => {
          stop();
          if (!Number.isFinite(next)) return;
          if (Math.abs(next - lastSent.current) < 1e-9) return;
          waiting.current += 1;
          let saved;
          try {
            saved = await onCommit(next);
          } finally {
            waiting.current -= 1;
          }
          // A rejected write must not look applied: the number falls back to what
          // the host holds, and the next gesture starts from there.
          if (saved === false) {
            lastSent.current = value;
            move(value);
            return;
          }
          lastSent.current = next;
        },
        [onCommit, value, stop, move],
      );

      useEffect(() => () => stop(), [stop]);

      const shownOf = (raw) => (percent ? raw * 100 : raw);
      const valueOf = (raw) => (percent ? raw / 100 : raw);
      const amount = typing === null ? String(Math.round(shownOf(draft))) : typing;

      const commitTyped = useCallback(
        (text) => {
          setTyping(null);
          const written = String(text ?? "").trim();
          // Backspacing to an empty field is not a request for zero.
          if (written === "") return;
          const typed = Number(written);
          if (!Number.isFinite(typed)) return;
          const next = snapRange(min, max, step, valueOf(typed));
          move(next);
          flush(next);
        },
        [flush, max, min, percent, step, move],
      );

      const fill = Math.max(0, Math.min(100, ((draft - min) / (max - min)) * 100));
      const fillText = Math.round(fill * 10) / 10 + "%";
      const canRevert = Number.isFinite(fallback) && Math.abs(draft - fallback) > 1e-9;

      return h(
        "div",
        { className: "se-set-slider" },
        h("input", {
          type: "range",
          className: "se-set-range",
          min,
          max,
          step,
          value: draft,
          disabled: Boolean(disabled),
          // The accent segment of the track: the one thing that says where the
          // handle is without measuring two pixels against a hairline.
          style: { "--se-fill": fillText },
          "aria-label": t(label),
          onChange: (event) => {
            const next = Number(event.target.value);
            move(next);
            stop();
            timer.current = setTimeout(() => {
              timer.current = null;
              // A drag ends on pointerup, not on a pause. Writing mid-gesture
              // sends a number the finger is about to leave behind, and the
              // release write then carries the same If-Match — which the host
              // answers with revision-conflict, reloading the page onto the
              // older value. The timer is only for the keyboard.
              if (holding.current) return;
              flush(next);
            }, RANGE_COMMIT_MS);
          },
          onPointerDown: () => {
            holding.current = true;
          },
          // Release, key and blur all end a gesture; each is a no-op when the
          // trailing timer already wrote the same number.
          onPointerUp: () => {
            holding.current = false;
            flush(shown.current);
          },
          onPointerCancel: () => {
            holding.current = false;
            flush(shown.current);
          },
          onKeyUp: () => flush(shown.current),
          onBlur: () => {
            holding.current = false;
            flush(shown.current);
          },
        }),
        h("input", {
          type: "number",
          className: "se-set-num",
          min: Math.round(shownOf(min)),
          max: Math.round(shownOf(max)),
          step: percent ? Number((step * 100).toFixed(6)) : step,
          value: amount,
          disabled: Boolean(disabled),
          "aria-label": t(label),
          onChange: (event) => setTyping(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") commitTyped(typing);
            else if (event.key === "Escape") setTyping(null);
          },
          onBlur: () => {
            if (typing !== null) commitTyped(typing);
          },
        }),
        h("span", { className: "se-set-unit" }, suffix),
        h(
          "button",
          {
            type: "button",
            className: "se-set-revert",
            title: t("setRevertDefault"),
            "aria-label": t("setRevertDefault"),
            // Always here, so every row is the same width; inert at the default.
            disabled: disabled === true || !canRevert,
            onClick: () => {
              if (!Number.isFinite(fallback)) return;
              move(fallback);
              flush(fallback);
            },
          },
          "↺",
        ),
      );
    }