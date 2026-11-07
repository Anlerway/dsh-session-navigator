    // ── Panel dictionary ───────────────────────────────────────────────────
    // Every label T() draws — the panel and the detached window — in each
    // language under assets/i18n/*.json. The key is the Chinese source text, so
    // a table reads as a glossary rather than a key list, and {0}, {1} … stand in
    // for what the call site interpolates. 中文's values are its keys, so its
    // table is a copy of the source rather than a translation. A function, not a
    // const, so it can sit below its callers and still be built on first use.
    let panelEnCache = null;

    /** English — what a language without a table of its own falls back to. */
    function panelDict() {
      if (!panelEnCache) panelEnCache = panelTable("en") ?? {};
      return panelEnCache;
    }

    /**
     * One language's panel table, or null when it ships none.
     *
     * The tables are data — assets/i18n/<code>.json, inlined by the build — and
     * every language has one, 中文 included: its values repeat the keys, so the
     * Chinese copy lives in zh.json like any other and can be edited there. A
     * code with no table answers null, so a caller falls back to English instead
     * of drawing Chinese to someone who does not read it.
     *
     * @param {string} lang one of LANGS
     * @returns {Record<string, string> | null}
     */
    function panelTable(lang) {
      const entry = DICTS[lang];
      return entry && entry.panel ? entry.panel : null;
    }

    // ── DSH's own session surfaces ─────────────────────────────────────────
    // 归档 / 收藏 / 待办 / 在会话资源管理器查看 / 删除, offered where the user
    // already looks at a session: the conversation header (all five) and the
    // sidebar row's own "…" menu (the last two).
    //
    // None of this duplicates the panel. Each button calls the host route that
    // already owns the write, so DSH's sidebar, the panel and the detached
    // window cannot drift apart over one session's flags; the panel only gets
    // *handed* the session the user asked to see, through the same store the
    // footer button uses.
    //
    // These surfaces mount outside the panel, so they have no /bootstrap
    // snapshot: one row's state is one GET /session-state/:id, and every write
    // re-reads it — a toggle the host refuses (a trashed session has no payload
    // left to annotate) shows as the state it really is.

    /**
     * The session the panel should land on, queued because opening the panel
     * mounts it a tick later — the store flips first, the panel's callback
     * exists only after its first render.
     */
    let pendingReveal = null;

    /**
     * A 打开 or 新建会话 the window asked for while this page had no panel.
     *
     * 独立弹窗 mode leaves the panel unmounted on this page, and the panel is
     * where the only readable refusal lives (a trashed session, a DSH build
     * without the navigation service). A request that cannot be served
     * directly is therefore queued for the panel that the request itself brings
     * up, rather than being dropped.
     *
     * @type {{ kind: "open-session", sessionId: string }
     *   | { kind: "new-session", workspaceId?: string } | null}
     */
    let pendingBridgeRequest = null;

    /**
     * Ask whichever surface is listening to reveal one session.
     *
     * The reveal kind is on the bus already (it is how the detached window's
     * rows ask for one), so this is only a publish; a listener that is not
     * there simply means nobody was listening, and the caller opens a window or
     * the panel next.
     */
    async function publishReveal(sessionId) {
      try {
        await apiSend("POST", "/bridge/commands", { kind: "reveal", payload: { sessionId } }, { ifMatch: false });
      } catch {
        /* no bus (older host): the panel below is still a place to land */
      }
    }

    /**
     * Show one session in the explorer — from DSH's header strip or row menu.
     *
     * 默认打开方式 decides which surface comes up, the same way it decides it
     * for the sidebar entry: a panel that is already on screen is revealed in
     * place (that is the surface the user is looking at), otherwise 独立弹窗
     * gets the window and the panel only opens when the window cannot.
     */
    async function revealInExplorer(sessionId) {
      if (typeof sessionId !== "string" || !sessionId) return;
      if (panelStore.getSnapshot() && typeof bridgeActions.reveal === "function") {
        bridgeActions.reveal(sessionId);
        return;
      }
      if ((await refreshOpenMode()) === "detached" && !windowHost()) {
        // The window is its own document, so it has to be *told* which session
        // once it exists: publish first (a window already on screen acts at
        // once) and the ring buffer carries the command to one still starting.
        await publishReveal(sessionId);
        try {
          await apiSend("POST", "/detached/open", { lang: uiLang() }, { ifMatch: false });
          panelStore.set(false);
          return;
        } catch {
          /* no Electron component: the panel is the other place to land */
        }
      }
      pendingReveal = sessionId;
      panelStore.set(true);
    }

    /**
     * 打开 asked for by the detached window, on a page that has no panel.
     *
     * In 独立弹窗 mode the panel is never mounted here — the window *is* the
     * explorer — so the bridge handler cannot lean on `bridgeActions`, which
     * only exists while the panel does. Navigation does not need the panel:
     * `uiWorkspace.openSession` is the very call the panel makes, so it is made
     * directly. The panel is raised only when it is the thing that can explain
     * a refusal, which is why an unservable request is queued for it.
     */
    function openSessionFromBridge(sessionId) {
      const uiWorkspace = serviceOf("uiWorkspace");
      if (!uiWorkspace || typeof uiWorkspace.openSession !== "function") {
        pendingBridgeRequest = { kind: "open-session", sessionId };
        panelStore.set(true);
        return;
      }
      try {
        uiWorkspace.openSession(sessionId);
      } catch (error) {
        pendingBridgeRequest = { kind: "open-session", sessionId };
        panelStore.set(true);
        console.warn?.("session-navigator: open-session failed", error);
      }
    }

    /** 新建会话 asked for by the detached window, on a page that has no panel. */
    function newSessionFromBridge(workspaceId) {
      const uiWorkspace = serviceOf("uiWorkspace");
      if (!uiWorkspace || typeof uiWorkspace.startSession !== "function") {
        pendingBridgeRequest = { kind: "new-session", workspaceId };
        panelStore.set(true);
        return;
      }
      try {
        uiWorkspace.startSession(workspaceId);
      } catch (error) {
        pendingBridgeRequest = { kind: "new-session", workspaceId };
        panelStore.set(true);
        console.warn?.("session-navigator: new-session failed", error);
      }
    }

    /**
     * One session's explorer state (favorite, todo, archived, trashed).
     * @returns {[any, () => Promise<void>]} the state and a reload
     */
    function useSessionState(sessionId) {
      const [state, setState] = useState(null);
      // The buttons read this state to decide what they will *do*, so a value
      // carried over from the previous session is not "stale" — it is the wrong
      // answer. Switching from a favorited session to another one otherwise leaves
      // 取消收藏 on screen, and clicking it unfavorites the new session.
      useEffect(() => {
        setState(null);
      }, [sessionId]);
      const reload = useCallback(async () => {
        if (typeof sessionId !== "string" || !sessionId) {
          setState(null);
          return;
        }
        try {
          setState(await apiGet(`/session-state/${encodeURIComponent(sessionId)}`));
        } catch {
          setState(null);
        }
      }, [sessionId]);
      useEffect(() => {
        void reload();
      }, [reload]);
      return [state, reload];
    }

    /**
     * The write half of the same five actions.
     *
     * `busy` is a single key, not a per-button flag: the buttons toggle against
     * the state this hook re-read, so a second click landing before the first
     * re-read would toggle from a stale value. One write at a time is what
     * makes "收藏 → 取消收藏" mean what it says.
     */
    function useSessionActions(sessionId) {
      const [state, reload] = useSessionState(sessionId);
      const [busy, setBusy] = useState("");
      const [error, setError] = useState("");
      const id = typeof sessionId === "string" ? sessionId : "";
      const path = `/sessions/${encodeURIComponent(id)}`;
      const run = useCallback(
        async (key, work) => {
          if (!id) return;
          setBusy(key);
          setError("");
          try {
            await work();
            await reload();
          } catch (failure) {
            setError(String(failure?.message ?? failure));
          } finally {
            setBusy("");
          }
        },
        [id, reload],
      );
      const actions = useMemo(
        () => ({
          archive: () => run("archive", () => apiSend("POST", `${path}/archive`, {}, { ifMatch: false })),
          unarchive: () => run("archive", () => apiSend("POST", `${path}/unarchive`, {}, { ifMatch: false })),
          // 收藏 / 待办 are shortcut containers, so these two write a shortcut
          // node: adding one puts the session on the page, deleting the one the
          // state reported takes it off. The session file is untouched either
          // way — that is what 取消收藏 promises.
          //
          // No revision is sent: this surface never received a bootstrap
          // snapshot, so any cached revision it could name would be a guess. The
          // re-read after the write is what keeps the strip honest instead.
          favorite: (on) =>
            run("favorite", async () => {
              if (on) {
                await apiSend(
                  "POST",
                  "/shortcuts",
                  { parent: FIXED.favorites, kind: "session", targetId: id },
                  { ifMatch: false },
                );
                return;
              }
              const shortcutId = state?.favoriteShortcut;
              if (!shortcutId) return;
              await apiSend("DELETE", `/shortcuts/${encodeURIComponent(shortcutId)}`, undefined, { ifMatch: false });
            }),
          todo: (on) =>
            run("todo", async () => {
              if (on) {
                await apiSend("POST", "/shortcuts", { parent: FIXED.todos, kind: "session", targetId: id }, { ifMatch: false });
                return;
              }
              const shortcutId = state?.todoShortcut;
              if (!shortcutId) return;
              await apiSend("DELETE", `/shortcuts/${encodeURIComponent(shortcutId)}`, undefined, { ifMatch: false });
            }),
          // 删除 is the panel's soft delete: the log moves to this plugin's own
          // bin, so DSH's list drops it and 回收站 can put it back. A hard
          // delete from the shell would leave nothing for 回收站 to restore.
          remove: () => run("delete", () => binWrite("POST", "/trash", { ids: [id] }, { ifMatch: false })),
          reveal: () => void revealInExplorer(id),
        }),
        [id, path, run, state],
      );
      return { state, busy, error, actions };
    }

    /**
     * The header strip's buttons as data: which label each shows, whether it
     * reads "already on", and whether this session's state lets it fire.
     *
     * Split from the component so the toggle wording (归档/取消归档,
     * 收藏/取消收藏, 待办/取消待办) and the disabled rule can be asserted
     * without a renderer. A trashed session has no payload left to annotate, so
     * every write but 在会话资源管理器查看 is off; `busy` is passed in because
     * two writes would race the annotations revision.
     */
    /**
     * The strip's icons, drawn inline.
     *
     * A client slot must not require a Harness package, so the host's own icon
     * set is out of reach; each glyph is therefore one or two paths on a 16x16
     * grid, stroked with `currentColor` so the button's colour (brand when on,
     * red for 删除) paints them too.
     */
    const HDR_ICONS = {
      archive: ["M2.2 3.1h11.6v2.5H2.2z", "M3.5 5.6h8.1v7.3H3.5z", "M6.3 8.3h3.4"],
      favorite: ["M8 2.1l1.86 3.83 4.24.59-3.09 2.98.75 4.2L8 11.75l-3.76 1.95.75-4.2L1.9 6.52l4.24-.59z"],
      todo: ["M3 3h10v10H3z", "M5.4 8.2l1.85 1.85L10.8 6.5"],
      // 在会话资源管理器查看 opens a folder-shaped place, so it wears the
      // explorer's own folder glyph instead of an eye: the eye read as
      // "preview / show", not "open the manager".
      reveal: ["M2 4.4h4l1.2 1.6H14V13H2z"],
      delete: [
        "M2.6 4.2h10.8",
        "M6.1 4.2V2.8h3.8v1.4",
        "M4.1 4.2l.7 9.4h6.4l.7-9.4",
        "M6.7 6.7v4.4",
        "M9.3 6.7v4.4",
      ],
    };

    /** One header icon, keyed by the action it belongs to. */
    function hdrIcon(name) {
      return h(
        "svg",
        {
          className: "se-hdrIco se-hdrIco-" + name,
          viewBox: "0 0 16 16",
          width: 14,
          height: 14,
          "aria-hidden": "true",
          focusable: "false",
        },
        (HDR_ICONS[name] ?? []).map((d, index) => h("path", { key: index, d })),
      );
    }

    function headerActionsFor(state, t, busy = "") {
      const archived = state?.archived === true;
      const trashed = state?.trashed === true;
      const favorite = state?.favorite === true;
      const todo = state?.todo === true;
      // "Not known yet" is not "off": until this session's own state arrives
      // (or if reading it failed) the strip must not invite a write that was
      // decided from nothing.
      const unknown = !state;
      const dead = trashed || busy !== "" || unknown;
      return [
        { key: "archive", label: t(archived ? "hdrUnarchive" : "hdrArchive"), on: archived, pressed: archived, disabled: dead },
        { key: "favorite", label: t(favorite ? "hdrUnfavorite" : "hdrFavorite"), on: favorite, pressed: favorite, disabled: dead },
        { key: "todo", label: t(todo ? "hdrUntodo" : "hdrTodo"), on: todo, pressed: todo, disabled: dead },
        { key: "reveal", label: t("hdrReveal"), on: false, pressed: false, disabled: busy !== "" || unknown },
        { key: "delete", label: t("hdrDelete"), on: false, pressed: false, disabled: dead },
      ];
    }

    /**
     * The translator a slot component should use.
     *
     * DSH binds `t` into the props of a component registered with `locale`, but
     * these surfaces also mount in hosts that do not, so a missing prop falls
     * back to this plugin's own binding and then to the key itself.
     */
    function slotT(props) {
      if (typeof props?.t === "function") return props.t;
      try {
        const bound = hostCtx?.locale?.bind?.(NS);
        if (typeof bound === "function") return bound;
      } catch {
        /* a host without a locale service */
      }
      return (key) => key;
    }

    /** The conversation header strip: the five buttons. */
    function SessionHeaderActions(props) {
      const t = slotT(props);
      const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
      const { state, busy, error, actions } = useSessionActions(sessionId);
      // 会话界面按钮样式 (设置 → 会话界面): `auto` keeps the words while they
      // fit and drops them when the bar is narrow; `icon` drops them always.
      // The store is module-level because the strip remounts per conversation,
      // and a choice saved in the settings window must reach the strip that is
      // already on screen — hence the subscription, not a one-shot read.
      const style = useSyncExternalStore(headerStyle.subscribe, headerStyle.snapshot, headerStyle.snapshot);
      useEffect(() => {
        void refreshHeaderStyle();
      }, []);
      if (!sessionId) return null;
      // A subagent is part of its parent's run: 归档/收藏/待办 are the parent's to
      // press and the host refuses them on a child (`subagent-unsupported`), so
      // the strip keeps only 显示 and 删除. 删除 stays because binning a child
      // only moves its own payload — restore puts it back, and nothing about the
      // parent's run changes.
      const isSubagent = state?.subagent === true;
      const stripActions = headerActionsFor(state, t, busy).filter(
        (action) => !isSubagent || action.key === "reveal" || action.key === "delete",
      );
      const handlers = {
        archive: () => (state?.archived === true ? actions.unarchive() : actions.archive()),
        favorite: () => actions.favorite(state?.favorite !== true),
        todo: () => actions.todo(state?.todo !== true),
        reveal: () => actions.reveal(),
        // 删除 asks before it acts: the one destructive button in the strip
        // opens the plugin's confirm dialog (solid red confirm) and only the
        // answered "yes" reaches the host.
        delete: async () => {
          const confirmed = await askConfirm({
            title: t("hdrDeleteTitle"),
            message: t("hdrDeleteMessage"),
            confirmLabel: t("hdrDelete"),
            cancelLabel: t("hdrCancel"),
            danger: true,
          });
          if (confirmed === true) await actions.remove();
        },
      };
      return h(
        "div",
        {
          className: "se-hdrActions" + (style === "icon" ? " se-hdrActions-icons" : ""),
          "data-busy": busy || undefined,
          title: error || undefined,
        },
        state?.trashed === true ? h("span", { className: "se-hdrNote" }, t("hdrTrashed")) : null,
        isSubagent ? h("span", { className: "se-hdrNote" }, t("hdrSubagent")) : null,
        stripActions.map((action) =>
          h(
            "button",
            {
              type: "button",
              key: action.key,
              "data-action": action.key,
              className: "se-hdrBtn" + (action.on ? " is-on" : ""),
              title: action.label,
              "aria-pressed": action.pressed === true ? true : undefined,
              "aria-label": action.label,
              disabled: action.disabled,
              onClick: () => void handlers[action.key](),
            },
            hdrIcon(action.key),
            h("span", { className: "se-hdrLabel" }, action.label),
          ),
        ),
      );
    }

    /** Close the row menu a click came from, whichever host shape it has. */
    function useMenuClose(props) {
      const hook = typeof props?.useMenuOpenState === "function" ? props.useMenuOpenState : null;
      let pair = null;
      if (hook) {
        try {
          pair = hook();
        } catch {
          pair = null;
        }
      }
      const setOpen = Array.isArray(pair) && typeof pair[1] === "function" ? pair[1] : null;
      return () => {
        try {
          if (setOpen) setOpen(false);
        } catch {
          /* the menu is already gone */
        }
      };
    }

    /**
     * One row of DSH's session menu, drawn by the plugin itself.
     *
     * The host's own rows come from `@deepseek-ai/dsh-client-ui-primitives`, but
     * a client slot must not require a Harness package (it may not resolve, and
     * the contract forbids it), so the row is a plain `role="menuitem"` button
     * with the host's type scale and hover surface. `separatorBefore` draws the
     * hairline a group start gets from the host's own rows, and `icon` names a
     * glyph from the panel's own table: the host's rows lead with an icon, so a
     * row without one sat a few pixels off the grid its neighbours use.
     */
    function menuEntry(label, onSelect, options = {}) {
      return h(
        "button",
        {
          type: "button",
          role: "menuitem",
          className:
            "se-menuItem" +
            (options.separatorBefore ? " se-menuItem-sep" : "") +
            (options.danger ? " se-menuItem-danger" : ""),
          onClick: onSelect,
        },
        options.icon ? h("span", { className: "se-menuItemIcon" }, h(Icon, { name: options.icon, size: 14 })) : null,
        label,
      );
    }

    /**
     * The sidebar row menu's two entries: 在会话资源管理器查看 and 删除.
     *
     * One component for both, because the slot registers one component per
     * injection: two separate injections of the same slot name would depend on
     * inject ordering, while one element with two rows cannot be reordered.
     *
     * 删除 is the panel's soft delete, so the row leaves DSH's list and lands in
     * 回收站 rather than being unlinked from disk.
     */
    function SessionMenuItems(props) {
      const t = slotT(props);
      const close = useMenuClose(props);
      const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
      const [busy, setBusy] = useState(false);
      // The hook has to run before the early return below (rules of hooks); it is
      // a no-op without an id. Its `state` does not gate 删除 for a subagent — the
      // bin takes a child's own payload — so the row is offered for every session
      // and only the destructive verbs above stay the parent's.
      useSessionActions(sessionId);
      // DSH mounts the row menu only for a session; without an id there is
      // nothing to reveal or delete, so the menu must not grow rows.
      if (!sessionId) return null;
      const remove = async () => {
        if (!sessionId || busy) return;
        // The menu closes first: the question is drawn by the channel's own
        // host, which outlives this row.
        close();
        const confirmed = await askConfirm({
          title: t("hdrDeleteTitle"),
          message: t("hdrDeleteMessage"),
          confirmLabel: t("hdrDelete"),
          cancelLabel: t("hdrCancel"),
          danger: true,
        });
        if (confirmed !== true) return;
        setBusy(true);
        try {
          await binWrite("POST", "/trash", { ids: [sessionId] }, { ifMatch: false });
        } catch (failure) {
          console.warn?.("session-navigator: delete failed", failure);
        } finally {
          setBusy(false);
        }
      };
      return h(
        React.Fragment,
        null,
        menuEntry(
          t("hdrReveal"),
          () => {
            close();
            void revealInExplorer(sessionId);
          },
          { separatorBefore: true, icon: "locate" },
        ),
        menuEntry(t(busy ? "hdrDeleting" : "hdrDelete"), () => void remove(), { danger: true, icon: "trash" }),
      );
    }
