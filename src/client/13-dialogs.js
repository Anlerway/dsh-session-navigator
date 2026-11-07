    // ── Dialogs ────────────────────────────────────────────────────────────
    // Confirmations and text prompts cannot use window.confirm / window.prompt.
    // window.prompt does not exist in Electron at all (it is disabled in the
    // renderer and returns null), which is why 新建文件夹 would silently do
    // nothing; window.confirm works but it is a browser box that ignores the DSH
    // theme and blocks the renderer while it is open.
    //
    // Every dialog goes through `useDialogs`, which resolves a promise and
    // renders one local component. It is deliberately *not* DSH's Modal: that
    // primitive paints at the app's dialog tier, which is below this panel, so
    // a confirmation opened from here would land underneath the window that
    // opened it. The local layer sits above the panel and above the context
    // menu instead (see .fmodal in the stylesheet).

    /** A tiny imperative queue owner: one dialog at a time, promise-based. */
    /**
     * The plugin's one dialog channel.
     *
     * Every question resolves through this store rather than through the panel's
     * own state, because a dialog can be opened from a subtree that is about to
     * unmount: 删除 in DSH's row menu closes the menu it was clicked in, and the
     * question has to outlive it. Exactly one host draws the dialog — the
     * sidebar entry's, mounted with the plugin and above every surface — so two
     * dialogs can never stack.
     */
    const dialogStore = (() => {
      /** @type {any} */
      let current = null;
      const listeners = new Set();
      const emit = () => {
        for (const listener of listeners) listener();
      };
      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        getSnapshot: () => current,
        /** Ask. Whatever was pending is answered "no" and replaced. */
        open(request) {
          const replaced = current;
          current = request;
          emit();
          if (replaced) replaced.resolve?.(replaced.kind === "prompt" ? null : false);
        },
        /** Answer the pending request, if there still is one. */
        settle(value) {
          const answered = current;
          if (!answered) return;
          current = null;
          emit();
          answered.resolve?.(value);
        },
      };
    })();

    /**
     * Ask one yes/no question. React-free on purpose: the row menu asks from a
     * click handler that is already tearing its own subtree down.
     *
     * @returns {Promise<boolean>}
     */
    function askConfirm(options) {
      return new Promise((resolve) => {
        dialogStore.open({
          kind: "confirm",
          title: options?.title ?? T("确认"),
          message: options?.message ?? "",
          confirmLabel: options?.confirmLabel ?? T("确定"),
          cancelLabel: options?.cancelLabel ?? T("取消"),
          danger: options?.danger === true,
          // `acknowledge` turns a destructive confirm into DSH's
          // RiskConfirmation shape, which requires ticking a box first.
          acknowledge:
            options?.acknowledge === true ? options.acknowledgeLabel ?? T("我明白此操作不可撤销") : null,
          resolve,
        });
      });
    }

    /** The panel's view of the same channel. */
    function useDialogs() {
      const dialog = useSyncExternalStore(
        dialogStore.subscribe,
        dialogStore.getSnapshot,
        dialogStore.getSnapshot,
      );
      const confirm = useCallback((options) => askConfirm(options), []);

      const ask = useCallback(
        (options) =>
          new Promise((resolve) => {
            dialogStore.open({
              kind: "prompt",
              title: options?.title ?? T("输入"),
              message: options?.message ?? "",
              placeholder: options?.placeholder ?? "",
              value: options?.value ?? "",
              confirmLabel: options?.confirmLabel ?? T("确定"),
              cancelLabel: options?.cancelLabel ?? T("取消"),
              maxLength: Number.isFinite(options?.maxLength) ? options.maxLength : 64,
              validate: typeof options?.validate === "function" ? options.validate : null,
              resolve,
            });
          }),
        [],
      );

      // `open` lets the panel stand its own shortcuts down while a dialog owns
      // the keyboard. The host itself is DialogChannel's, mounted with the
      // sidebar entry so a question outlives whatever asked it.
      // The object is memoised on the three facts it carries: callers pass
      // dialogs straight into dependency arrays, so a fresh literal per render
      // would rebuild every one of them on every frame.
      return useMemo(() => ({ confirm, ask, open: dialog !== null }), [confirm, ask, dialog]);
    }

    /**
     * The channel's own host: it lives beside the sidebar entry, so it is mounted
     * whether or not the panel is, and it draws whichever dialog is pending.
     *
     * The dialog rules (and the token bridge) are scoped to `.se-shell`, so the
     * host renders inside one — with `display: contents` the scope is inherited
     * without painting the shell's own frame.
     */
    function DialogChannel() {
      const dialog = useSyncExternalStore(
        dialogStore.subscribe,
        dialogStore.getSnapshot,
        dialogStore.getSnapshot,
      );
      if (!dialog) return null;
      return portalFragment([
        h(
          "div",
          { className: "se-shell", style: { display: "contents" } },
          h(DialogHost, { dialog, promptRef: null, onSettle: (value) => dialogStore.settle(value) }),
        ),
      ]);
    }

    /**
     * The dialog itself.
     *
     * Three shapes, in order of preference:
     *   1. destructive with a native RiskConfirmation — a typed acknowledgement
     *      in the app's own warning layout;
     *   2. native Modal — the app's mask, focus trap, Escape and stacking;
     *   3. the local fallback, for a host that exposes no primitives.
     */
    function DialogHost({ dialog, promptRef, onSettle }) {
      const [acknowledged, setAcknowledged] = useState(false);
      const [value, setValue] = useState("");
      const [error, setError] = useState("");

      useEffect(() => {
        // A new dialog always starts clean: a stale acknowledgement or a
        // half-typed name must never leak from the previous one.
        setAcknowledged(false);
        setValue(dialog?.kind === "prompt" ? dialog.value ?? "" : "");
        setError("");
      }, [dialog]);

      if (!dialog) return null;

      const close = () => onSettle(dialog.kind === "prompt" ? null : false);
      const submit = () => {
        if (dialog.kind === "prompt") {
          const text = value.trim();
          if (dialog.validate) {
            const verdict = dialog.validate(text);
            if (verdict !== true) {
              setError(typeof verdict === "string" ? verdict : T("输入不合法"));
              return;
            }
          }
          onSettle(text);
          return;
        }
        onSettle(true);
      };

      // Every confirmation and prompt is drawn here, by the plugin, on the
      // dialog layer of the stylesheet — never by DSH's Modal primitive. That
      // primitive lives at the app's dialog tier, which this panel sits above,
      // so a "higher" dialog rendered through it ends up *under* the panel that
      // opened it. One local implementation means one predictable layer, and
      // destructive actions get the same 我明白此操作不可撤销 acknowledgement.
      return h(
        "div",
        {
          className: "fmodal open",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": dialog.title,
          onMouseDown: (event) => {
            // Only a press that starts on the backdrop dismisses: a drag that
            // ends outside the card (selecting text, moving the pointer) must
            // not throw the dialog away.
            if (event.target === event.currentTarget) close();
          },
        },
        h(
          "div",
          { className: dialog.wide ? "fdlg wide" : "fdlg" },
          h(
            "div",
            { className: "fhead" },
            h("span", { className: "ftitle" }, dialog.title),
            h("span", { className: "spacer" }),
            h("button", { type: "button", className: "wbtn", title: T("关闭"), onClick: close }, h(Icon, { name: "x", size: 13 })),
          ),
          h(
            "div",
            { className: "fbody" },
            dialog.message ? h("p", { className: "se-dlg-msg" }, dialog.message) : null,
            // A panel brings its own body: closing is the only verb this layer
            // still owns, and the body keeps its own buttons and state.
            dialog.kind === "panel" ? h("div", { className: "se-dlg-body" }, dialog.render?.()) : null,
            dialog.kind === "prompt"
              ? h("input", {
                  ref: promptRef,
                  className: "se-dlg-input",
                  value,
                  placeholder: dialog.placeholder,
                  maxLength: dialog.maxLength,
                  autoFocus: true,
                  spellCheck: false,
                  onChange: (event) => {
                    setValue(event.target.value);
                    setError("");
                  },
                  onKeyDown: (event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submit();
                    }
                  },
                })
              : null,
            error ? h("p", { className: "se-dlg-err" }, error) : null,
            dialog.acknowledge
              ? h(
                  "label",
                  { className: "se-dlg-ack" },
                  h("input", {
                    type: "checkbox",
                    checked: acknowledged,
                    onChange: (event) => setAcknowledged(event.target.checked),
                  }),
                  h("span", null, dialog.acknowledge),
                )
              : null,
          ),
          h(
            "div",
            { className: "ffoot" },
            h("span", { className: "spacer" }),
            dialog.kind === "panel"
              ? h("button", { type: "button", className: "act", onClick: close }, dialog.closeLabel ?? T("关闭"))
              : [
                  h("button", { key: "cancel", type: "button", className: "act", onClick: close }, dialog.cancelLabel),
                  h(
                    "button",
                    {
                      key: "confirm",
                      type: "button",
                      className: "act" + (dialog.danger ? " danger-solid" : " primary"),
                      disabled: dialog.acknowledge ? !acknowledged : false,
                      onClick: submit,
                    },
                    dialog.confirmLabel,
                  ),
                ],
          ),
        ),
      );
    }

