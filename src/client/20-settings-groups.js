    // ── Electron 组件 ────────────────────────────────────────────────────
    // The detached window needs an optional Electron runtime. It is installed
    // explicitly — the plugin itself is a few dozen KB and most users never
    // need a separate window — so the section leads with size and consequence
    // rather than a download button that appears out of nowhere.
    /**
     * Whether the panel has to keep asking /component/status.
     *
     * install() only answers once the runtime is on disk, so the status this
     * component holds reads `absent` for the whole download. The host flushes
     * `downloading` before the stream opens and rewrites the partial file's
     * size once a second, so polling from the click is what turns that request
     * into a bar. Polling also covers a download started before this panel
     * existed — the first status read already says `downloading`.
     */
    function componentPolling(phase, busy) {
      if (busy === "install") return true;
      return phase === "downloading" || phase === "verifying" || phase === "extracting";
    }

    function ComponentPanel({ t, component, onChanged, onDataChanged, onOpened }) {
      const [status, setStatus] = useState(component ?? null);
      const [busy, setBusy] = useState("");
      const [note, setNote] = useState("");
      const [error, setError] = useState("");
      // Result of the last manual scan for other plugins' runtimes. `null` means
      // "not asked yet", which is different from "asked, none found".
      const [scan, setScan] = useState(null);

      const apply = useCallback((next) => {
        if (!next) return;
        setStatus(next);
        onChanged?.(next);
      }, [onChanged]);

      const load = useCallback(async () => {
        try {
          apply(await apiGet("/component/status"));
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        }
      }, [apply]);

      useEffect(() => {
        load();
      }, [load]);

      // Poll while a phase can still change; SSE is optional and a background
      // tab throttles it, so polling is the source of truth for the final state.
      const phase = status?.phase ?? "absent";
      const settling = phase === "downloading" || phase === "verifying" || phase === "extracting";
      const polling = componentPolling(phase, busy);
      useEffect(() => {
        if (!polling) return undefined;
        const timer = setInterval(() => { void load(); }, 500);
        return () => clearInterval(timer);
      }, [polling, load]);

      const act = useCallback(async (kind) => {
        setBusy(kind);
        setError("");
        setNote("");
        try {
          const path = kind === "install" ? "/component/install" : `/component/${kind}`;
          const result = await apiSend("POST", path, {});
          apply(result);
          // An install lands ~150 MB inside the data directory and a remove takes
          // it away; the 占用大小 row in the next group has to stop saying the old
          // number.
          onDataChanged?.();
          // A remove can succeed as an uninstall while a locked file survives on
          // disk — a scanner or an indexer can hold one for a moment. That is not
          // an error: the leftovers are swept on the next start, and a reinstall
          // reuses them instead of downloading again. Say so, rather than sending
          // the user to run a script.
          if (kind === "remove" && result?.leftover) {
            setNote(t("setCompLeftover"));
            return;
          }
          setNote(kind === "install" ? t("setCompInstalled") : kind === "remove" ? t("setCompRemoved") : t("setCompCancelled"));
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          await load();
        } finally {
          setBusy("");
        }
      }, [apply, load, onDataChanged, t]);

      const openDetached = useCallback(async () => {
        setBusy("open");
        setError("");
        try {
          await apiSend("POST", "/detached/open", { lang: uiLang() });
          setNote(t("setCompOpened"));
          // A caller that is not the settings page has something to do next —
          // close this dialog, step the in-app panel aside. The settings window
          // passes nothing and stays exactly where it was.
          onOpened?.();
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy("");
        }
      }, [t, onOpened]);

      // Finding an Electron another plugin already installed is the whole point
      // of the scan: 150 MB is a lot to ask for twice on one machine.
      const scanNow = useCallback(async () => {
        setBusy("scan");
        setError("");
        setNote("");
        try {
          const result = await apiGet("/component/scan");
          setScan(result);
          if (!result?.candidates?.length) setNote(t("setCompScanNone"));
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy("");
        }
      }, [t]);

      const borrow = useCallback(async (root) => {
        setBusy("borrow");
        setError("");
        setNote("");
        try {
          apply(await apiSend("POST", "/component/install", { borrowed: root }));
          // A borrowed runtime writes nothing here, but the ones a remove left
          // behind are swept on the way in, so the number moved anyway.
          onDataChanged?.();
          setScan(null);
          setNote(t("setCompBorrowNote"));
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          await load();
        } finally {
          setBusy("");
        }
      }, [apply, load, onDataChanged, t]);

      // Same formatter as the list columns (TB cap, honouring the size-unit
      // setting); the em dash keeps the blank-cell convention of this group.
      const bytes = (value) => formatSize(value) || "—";

      const received = Number(status?.receivedBytes) || 0;
      const total = Number(status?.totalBytes) || 0;
      const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;

      return h(
        React.Fragment,
        null,
        h(
          "div",
          { className: "se-set-row" },
          h(
            "div",
            { className: "se-set-main" },
            h("div", { className: "se-set-lbl" }, `${t("setCompStatus")} · ${
              phase === "ready" ? t("setCompReady") : phase === "error" ? t("setCompError") : phase === "absent" ? t("setCompAbsent") : t("setCompWorking")
            }`),
            h("div", { className: "se-set-hint" }, t("setCompSize", {
              download: bytes(status?.approxDownloadBytes),
              disk: bytes(status?.approxDiskBytes),
            })),
            phase === "ready" && status?.sizeBytes
              ? h("div", { className: "se-set-hint" }, `${t("setCompInstalledSize")} ${bytes(status.sizeBytes)}`)
              : null,
            // A borrowed runtime has no size of ours to report, so the path is
            // the useful fact: it says whose tree is being started.
            status?.borrowed
              ? h("div", { className: "se-set-hint" }, t("setCompBorrowedFrom", { path: status.borrowed }))
              : null,
            status?.error ? h("div", { className: "se-set-err" }, status.error) : null,
          ),
          h(
            "div",
            { className: "se-set-choices" },
            phase === "ready"
              ? [
                  h("button", { key: "open", type: "button", className: "se-set-chip on", disabled: Boolean(busy), onClick: openDetached }, t("setCompOpen")),
                  h("button", { key: "remove", type: "button", className: "se-set-chip", disabled: Boolean(busy), onClick: () => act("remove") }, status?.borrowed ? t("setCompForget") : t("setCompRemove")),
                ]
              : phase === "downloading"
                ? [h("button", { key: "cancel", type: "button", className: "se-set-chip", disabled: Boolean(busy), onClick: () => act("cancel") }, t("setCompCancel"))]
                : [
                    h("button", { key: "install", type: "button", className: "se-set-chip on", disabled: Boolean(busy), onClick: () => act("install") }, phase === "error" ? t("setCompRetry") : t("setCompDownload")),
                    // The cheap alternative to 150 MB: start an Electron another
                    // plugin already installed. Nothing is written into it.
                    h("button", { key: "scan", type: "button", className: "se-set-chip", disabled: Boolean(busy), onClick: () => { void scanNow(); } }, t("setCompScan")),
                  ],
          ),
        ),
        busy === "install" || settling || phase === "error"
          ? h(
              "div",
              { className: "se-set-row" },
              h(
                "div",
                { className: "se-set-main" },
                // The bar is drawn by hand: a native <progress> has no
                // visible indeterminate run in this theme, and the first
                // second of a download has no byte count yet.
                phase === "downloading" || (busy === "install" && phase === "absent")
                  ? h(
                      "div",
                      {
                        className: "se-set-progress" + (percent === null ? " indeterminate" : ""),
                        role: "progressbar",
                        "aria-valuemin": 0,
                        "aria-valuemax": 100,
                        "aria-valuenow": percent ?? undefined,
                      },
                      h("span", {
                        className: "se-set-progress-fill",
                        style: percent === null ? null : { width: percent + "%" },
                      }),
                    )
                  : null,
                h(
                  "div",
                  { className: "se-set-hint" },
                  phase === "downloading"
                    ? total > 0
                      ? t("setCompDownloading", { percent: String(percent ?? 0), done: bytes(received), total: bytes(total) })
                      : t("setCompDownloadingUnknown", { done: bytes(received) })
                    : phase === "verifying"
                      ? t("setCompVerifying")
                      : phase === "extracting"
                        ? t("setCompExtracting")
                        : busy === "install"
                          ? t("setCompWorking")
                          : status?.error ?? "",
                ),
              ),
            )
          : null,
        // Scan hits, one row each: the version tells a user which one is newer,
        // and the path tells them whose plugin it came from.
        (scan?.candidates ?? []).map((candidate) =>
          h(
            "div",
            { className: "se-set-row", key: `borrow:${candidate.root}` },
            h(
              "div",
              { className: "se-set-main" },
              h("div", { className: "se-set-lbl" }, candidate.electronVersion ? `Electron ${candidate.electronVersion}` : "Electron"),
              h("div", { className: "se-set-hint" }, candidate.root),
            ),
            h(
              "div",
              { className: "se-set-choices" },
              h(
                "button",
                { type: "button", className: "se-set-chip on", disabled: Boolean(busy), onClick: () => { void borrow(candidate.root); } },
                t("setCompBorrow"),
              ),
            ),
          ),
        ),
        note ? h("div", { className: "se-set-row" }, h("div", { className: "se-set-note" }, note)) : null,
        error ? h("div", { className: "se-set-row" }, h("div", { className: "se-set-err" }, error)) : null,
      );
    }

    /** The settings page's card: the installer under its own caption. */
    function ComponentGroup({ t, component, onChanged, onDataChanged }) {
      return h(
        "div",
        { className: "se-set-grp" },
        h(
          "div",
          { className: "se-set-h" },
          t("setGroupComponent"),
          h("span", { className: "se-set-note", style: { marginLeft: "8px", fontWeight: 400 } }, t("setComponentFor")),
        ),
        h(ComponentPanel, { t, component, onChanged, onDataChanged }),
      );
    }

    /**
     * The installer, asked for from where it is needed.
     *
     * 独立窗口 is one click away, and the answer to that click used to be a
     * sentence pointing at 设置 → 会话资源管理器 → Electron 组件 — three steps for
     * something the panel can hand over inline. The dialog draws the same
     * ComponentPanel the settings page draws, against the same endpoints and the
     * same copy, so there is one installer, not a second one that drifts.
     *
     * `onOpened` is what the caller does when 打开独立窗口 inside the panel
     * succeeds: the window is the thing the user asked for, and the dialog plus
     * the in-app panel have both been answered by it.
     *
     * @param {{ onChanged?: (status: any) => void, onOpened?: () => void }} [options]
     */
    function openComponentDialog(options) {
      dialogStore.open({
        kind: "panel",
        title: ST("setGroupComponent"),
        wide: true,
        closeLabel: T("关闭"),
        render: () =>
          h(
            "div",
            { className: "se-set-grp" },
            h(ComponentPanel, {
              t: ST,
              onChanged: options?.onChanged,
              // The window is open: the dialog has been answered, and leaving it
              // on top of a panel that is about to step aside would be a second
              // copy of a question the user already finished.
              onOpened: () => {
                dialogStore.settle(false);
                options?.onOpened?.();
              },
            }),
          ),
      });
    }

    // ── 更新说明 (release notes) ────────────────────────────────────────────
    // The notes are a document, not copy in this bundle: the host reads
    // docs/changelog/<language>.md (falling back to English, then Chinese) and
    // hands back blocks, so rewording a release note is a file edit, not a
    // rebuild of this module. See src/domain/notes.js for the subset of markdown
    // that becomes a block, and src/host/changelog.js for which file wins.
    //
    // Drawn through SeModal rather than DialogHost: this page is mounted by the
    // settings window, where the panel's dialog host is not mounted at all. The
    // frame is therefore the app's own Modal here too — the announcement is the
    // one dialog DSH shows without being asked, and it must not paint its own
    // layer over the app's dialog tier.
    function notesRuns(runs) {
      return (Array.isArray(runs) ? runs : []).map((run, index) => {
        if (run.bold) return h("strong", { key: index }, run.text);
        if (run.code) return h("code", { key: index, className: "se-notes-code" }, run.text);
        return run.text;
      });
    }

    /** One parsed block → one element. Kinds: h / p / list / hr. */
    function NotesBlock({ block }) {
      if (block.kind === "hr") return h("div", { className: "se-notes-rule" });
      if (block.kind === "h") {
        const level = Math.min(Math.max(Number(block.level) || 2, 2), 4);
        return h("div", { className: "se-notes-h" + level }, notesRuns(block.runs));
      }
      if (block.kind === "list") {
        const items = (Array.isArray(block.items) ? block.items : []).map((item, at) => h("li", { key: at }, notesRuns(item)));
        return block.ordered ? h("ol", { className: "se-notes-list" }, items) : h("ul", { className: "se-notes-list" }, items);
      }
      return h("p", { className: "se-notes-p" }, notesRuns(block.runs));
    }

    function NotesModal({ t, notes, phase, error, opening, linkError, onClose, onOpen }) {
      // Esc is what everyone presses to leave a dialog. DSH's Modal already owns
      // that key; the local fallback does not, and closing twice is a no-op, so
      // the listener stays. On window, like every other key handler in this
      // bundle: the settings page runs in its own window, so a window listener is
      // already the narrow scope.
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
      }, [onClose]);

      const blocks = Array.isArray(notes?.blocks) ? notes.blocks : [];

      // Star, issues and the close chip ride in the frame's footer, which is the
      // same footer every confirm gets — one dialog language, not two.
      const footer = [
        h(
          "button",
          { key: "star", type: "button", className: "se-set-chip se-notes-chip on", disabled: opening !== "", onClick: () => onOpen("star") },
          h(Icon, { name: "star", size: 13 }),
          t("setStarGo"),
        ),
        h(
          "button",
          { key: "issues", type: "button", className: "se-set-chip se-notes-chip", disabled: opening !== "", onClick: () => onOpen("issues") },
          h(Icon, { name: "chat", size: 13 }),
          t("setIssueGo"),
        ),
        linkError ? h("span", { key: "link", className: "se-set-err" }, t("setLinkFailed", { reason: linkError })) : null,
        h("span", { key: "gap", className: "se-notes-gap" }),
        h("button", { key: "close", type: "button", className: "se-set-chip", onClick: onClose }, t("setNotesClose")),
      ];

      // The document's own first line already carries the version
      // ("更新说明：V1.1.0"), so it titles the frame; the plain label is only the
      // fallback for a file that starts with something else.
      return h(
        SeModal,
        { title: notes?.title || t("setNotes"), wide: true, onClose, footer },
        h(
          "div",
          { className: "se-notes-body" },
          blocks.map((block, index) => h(NotesBlock, { key: index, block })),
          phase === "loading" && blocks.length === 0 ? h("div", { className: "se-set-hint" }, t("setNotesLoading")) : null,
          phase === "error" ? h("div", { className: "se-set-err" }, t("setNotesFailed", { reason: error })) : null,
        ),
      );
    }

    /**
     * 更新说明: say what changed, once per version, at DSH startup.
     *
     * Mounted with the sidebar entry (see FooterAction), because that is what
     * exists from the first moment: the notes are about the plugin, not about
     * the panel, and a user who never opens the explorer still updated it.
     *
     * The version rides on /release-notes itself, so deciding costs one small
     * file read and the notes are already in hand when the answer is "show".
     * A failed read is silent here — a startup modal about a broken local file
     * would be worse than the silence — and nothing is recorded, so the next
     * launch tries again.
     */
    function NotesGate({ t }) {
      const [shown, setShown] = useState(null);
      const [opening, setOpening] = useState("");
      const [linkError, setLinkError] = useState("");

      useEffect(() => {
        if (notesLayer.asked) return undefined;
        let cancelled = false;
        // Deliberately late: see NOTES_DELAY_MS. The timer is also what keeps a
        // sidebar remount in the first frames from starting a second request.
        const timer = setTimeout(() => {
          if (cancelled || notesLayer.asked) return;
          notesLayer.asked = true;
          apiGet("/release-notes")
            .then((data) => {
              if (cancelled) return;
              if (notesDecision(data?.version, data?.seen) === "idle") return;
              notesLayer.open = true;
              setShown(data);
            })
            .catch(() => {
              /* nothing recorded: the next launch asks again */
            });
        }, NOTES_DELAY_MS);
        return () => {
          cancelled = true;
          clearTimeout(timer);
        };
      }, []);

      /**
       * Close the layer, and mark this version as delivered.
       *
       * Only a read that produced blocks counts: an empty document or a parse
       * that yielded nothing would otherwise burn the announcement for good.
       * The write is fire-and-forget — a failure only costs one more
       * announcement on the next launch, which is not worth a message here.
       */
      const close = useCallback(() => {
        notesLayer.open = false;
        if (Array.isArray(shown?.blocks) && shown.blocks.length > 0) {
          apiSend("POST", "/release-notes/seen", { version: shown.version }, { ifMatch: false }).catch(() => {});
        }
        setShown(null);
      }, [shown]);

      /** Star / issue from inside the layer: the host owns the URLs (allowlist). */
      const openLink = useCallback(async (target) => {
        setOpening(target);
        setLinkError("");
        try {
          await apiSend("POST", "/about/open", { target }, { ifMatch: false });
        } catch (failure) {
          setLinkError(String(failure?.message ?? failure));
        } finally {
          setOpening("");
        }
      }, []);

      if (!shown) return null;
      return portalFragment([
        h(NotesModal, {
          t,
          notes: shown,
          phase: "ready",
          error: "",
          opening,
          linkError,
          onClose: close,
          onOpen: openLink,
        }),
      ]);
    }

    // ── 关于 ───────────────────────────────────────────────────────────
    // Three things that have nothing to do with how the panel looks: which build
    // this is, whether a newer one exists, and where the project lives. 清理缓存
    // used to live here; it moved to 数据目录, because the bytes it frees are the
    // ones that group measures. None of it touches the settings document.
    //
    // The update check and every link go through the host: api.github.com sends
    // no CORS headers, and the detached window's main process denies
    // window.open. The client only ever names a target — the host's allowlist
    // turns "star" into a URL.
    function AboutGroup({ t, version }) {
      const [check, setCheck] = useState({ phase: "idle", data: null, error: "" });
      const [opening, setOpening] = useState("");
      const [linkError, setLinkError] = useState("");
      const [notes, setNotes] = useState({ phase: "idle", data: null, error: "" });
      const [notesOpen, setNotesOpen] = useState(false);

      const checkUpdate = useCallback(async (force) => {
        setCheck((previous) => ({ ...previous, phase: "checking", error: "" }));
        try {
          const data = await apiGet("/update" + (force ? "?force=1" : ""));
          setCheck({ phase: "ready", data, error: "" });
        } catch (failure) {
          setCheck({ phase: "error", data: null, error: String(failure?.message ?? failure) });
        }
      }, []);


      const open = useCallback(async (target) => {
        setOpening(target);
        setLinkError("");
        try {
          await apiSend("POST", "/about/open", { target }, { ifMatch: false });
        } catch (failure) {
          setLinkError(String(failure?.message ?? failure));
        } finally {
          setOpening("");
        }
      }, []);

      // 更新说明 — read per open, not once per mount: the file is what the user
      // edits when the wording is wrong, and a dialog that kept showing the
      // parse from mount time would be the very bug the file exists to avoid.
      const showNotes = useCallback(async () => {
        setNotesOpen(true);
        setNotes((previous) => ({ phase: "loading", data: previous.data, error: "" }));
        try {
          const data = await apiGet("/release-notes");
          setNotes({ phase: "ready", data, error: "" });
        } catch (failure) {
          setNotes({ phase: "error", data: null, error: String(failure?.message ?? failure) });
        }
      }, []);

      const hideNotes = useCallback(() => setNotesOpen(false), []);

      const versionText = version ? "v" + String(version).replace(/^v/i, "") : "-";
      const update = check.data;


      return h(
        "div",
        { className: "se-set-grp" },
        h("div", { className: "se-set-h" }, t("setGroupAbout")),

        h(
          SetRow,
          { label: t("setVersion") },
          h("span", { className: "se-set-ver" }, versionText),
          h(
            "button",
            {
              type: "button",
              className: "se-set-chip",
              disabled: check.phase === "checking",
              onClick: () => checkUpdate(check.phase !== "idle"),
            },
            check.phase === "checking" ? t("setChecking") : t("setCheckUpdate"),
          ),
        ),

        h(
          SetRow,
          { label: t("setNotes"), hint: t("setNotesHint") },
          h("button", { type: "button", className: "se-set-chip", onClick: showNotes }, t("setNotesOpen")),
        ),

        update && update.hasUpdate
          ? h(
              "div",
              { className: "se-set-row" },
              h(
                "div",
                { className: "se-set-main" },
                h("div", { className: "se-set-lbl" }, t("setUpdateAvailable", { version: update.latest })),
                update.publishedAt
                  ? h("div", { className: "se-set-hint" }, formatDate(Date.parse(update.publishedAt) || 0, Date.now()))
                  : null,
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "se-set-chip on",
                  disabled: opening !== "",
                  onClick: () => open("releases"),
                },
                t("setDownload"),
              ),
            )
          : null,
        update && !update.hasUpdate
          ? h(
              "div",
              { className: "se-set-row" },
              h(
                "div",
                { className: "se-set-main" },
                h("div", { className: "se-set-note" }, update.latest === null ? t("setUpdateNone") : t("setUpdateLatest")),
              ),
            )
          : null,
        check.phase === "error"
          ? h(
              "div",
              { className: "se-set-row" },
              h("div", { className: "se-set-main" }, h("div", { className: "se-set-err" }, t("setUpdateFailed", { reason: check.error }))),
            )
          : null,


        h(
          SetRow,
          { label: t("setStar"), hint: t("setStarHint") },
          h(
            "button",
            { type: "button", className: "se-set-chip", disabled: opening !== "", onClick: () => open("star") },
            t("setStarGo"),
          ),
        ),

        h(
          SetRow,
          { label: t("setIssue") },
          h(
            "button",
            { type: "button", className: "se-set-chip", disabled: opening !== "", onClick: () => open("issues") },
            t("setIssueGo"),
          ),
        ),

        linkError
          ? h(
              "div",
              { className: "se-set-row" },
              h("div", { className: "se-set-main" }, h("div", { className: "se-set-err" }, t("setLinkFailed", { reason: linkError }))),
            )
          : null,

        notesOpen
          ? h(NotesModal, {
              t,
              notes: notes.data,
              phase: notes.phase,
              error: notes.error,
              opening,
              linkError,
              onClose: hideNotes,
              onOpen: open,
            })
          : null,
      );
    }

    // ── 清除数据 (danger) ──────────────────────────────────────────────────
    // The only irreversible action in the plugin, so it is not a chip that
    // acts on press: pressing opens a confirmation the user has to fill in,
    // and the word they typed rides along with the request. The gate is
    // enforced host-side as well (src/host/reset.js) — this is the shape of
    // the promise, not the lock on it.
    //
    // Deliberately not `dialogs.ask`: this page is mounted by the settings
    // window, where the panel's dialog host is not mounted at all, so a dialog
    // opened from here would have nothing to draw it.
    function DangerGroup({ t, onReset }) {
      const [open, setOpen] = useState(false);
      const [typed, setTyped] = useState("");
      const [busy, setBusy] = useState(false);
      const [done, setDone] = useState("");
      const [error, setError] = useState("");

      const start = () => {
        setOpen(true);
        setTyped("");
        setDone("");
        setError("");
      };

      const cancel = () => {
        setOpen(false);
        setTyped("");
      };

      // The host trims and compares the same way; here it only decides when the
      // red button wakes up.
      const confirmed = typed.trim() === "DELETE";

      const run = useCallback(async () => {
        setBusy(true);
        setError("");
        try {
          // Not a settings write: the settings document is about to stop
          // existing, so citing a revision would be a 409 waiting to happen.
          const data = await apiSend("POST", "/data/reset", { confirm: typed.trim() }, { ifMatch: false });
          setDone(formatSize(data?.freedBytes ?? 0));
          setOpen(false);
          setTyped("");
          // Every control above was rendered from the document that was just
          // deleted: re-read it so the page shows the defaults now on disk.
          onReset?.();
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(false);
        }
      }, [typed, onReset]);

      return h(
        "div",
        { className: "se-set-grp se-set-danger" },
        h("div", { className: "se-set-h" }, t("setGroupDanger")),
        h(
          SetRow,
          { label: t("setReset"), hint: t("setResetHint") },
          h(
            "button",
            { type: "button", className: "se-set-chip danger", disabled: busy || open, onClick: start },
            t("setResetGo"),
          ),
        ),
        open
          ? h(
              "div",
              { className: "se-set-reset" },
              h("div", { className: "se-set-hint" }, t("setResetTyped")),
              h("input", {
                className: "se-set-input",
                value: typed,
                placeholder: t("setResetPlaceholder"),
                maxLength: 32,
                spellCheck: false,
                autoFocus: true,
                "aria-label": t("setResetTyped"),
                onChange: (event) => {
                  setTyped(event.target.value);
                  setError("");
                },
                onKeyDown: (event) => {
                  if (event.key === "Enter" && confirmed && !busy) {
                    event.preventDefault();
                    run();
                  }
                },
              }),
              h(
                "button",
                { type: "button", className: "se-set-chip", disabled: busy, onClick: cancel },
                t("setResetCancel"),
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "se-set-chip danger" + (confirmed ? " on" : ""),
                  disabled: busy || !confirmed,
                  onClick: run,
                },
                busy ? t("setResetBusy") : t("setResetConfirm"),
              ),
            )
          : null,
        done
          ? h(
              "div",
              { className: "se-set-row" },
              h("div", { className: "se-set-main" }, h("div", { className: "se-set-note" }, t("setResetDone", { size: done }))),
            )
          : null,
        error
          ? h(
              "div",
              { className: "se-set-row" },
              h("div", { className: "se-set-main" }, h("div", { className: "se-set-err" }, t("setResetFailed", { reason: error }))),
            )
          : null,
      );
    }

