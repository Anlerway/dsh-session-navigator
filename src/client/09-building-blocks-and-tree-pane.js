    // ── Small building blocks ──────────────────────────────────────────────
    function Btn({ className, title, onClick, disabled, children, icon, iconOnly }) {
      return h(
        "button",
        {
          type: "button",
          className: className + (iconOnly ? " icon-only" : ""),
          title,
          disabled: disabled === true,
          onClick,
        },
        icon ? h("span", { className: "ic", "data-i": icon }, h(Icon, { name: icon })) : null,
        iconOnly ? null : h("span", null, children),
      );
    }

    /**
     * Inline editor for a row's name.
     *
     * The row keeps its geometry and swaps only the label for an input, so a
     * rename never opens a dialog and never moves the list under the pointer.
     * Enter commits, Escape cancels, and leaving the field commits — the same
     * contract Explorer uses. `done` guards the commit against running twice:
     * committing unmounts the input, and the unmount fires `blur` in some
     * browsers right after Enter already committed.
     */
    function RenameInput({ className, value, onChange, onCommit, onCancel }) {
      const ref = useRef(null);
      const done = useRef(false);
      useEffect(() => {
        const element = ref.current;
        if (!element) return;
        element.focus();
        if (typeof element.select === "function") element.select();
      }, []);
      const finish = (run) => {
        if (done.current) return;
        done.current = true;
        run();
      };
      return h("input", {
        ref,
        className,
        value,
        spellCheck: false,
        autoComplete: "off",
        onClick: (event) => event.stopPropagation(),
        onMouseDown: (event) => event.stopPropagation(),
        onDoubleClick: (event) => event.stopPropagation(),
        onChange: (event) => onChange(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            finish(onCommit);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(onCancel);
          }
        },
        onBlur: () => finish(onCommit),
      });
    }

    function Trow({ scope, icon, label, count, active, tone, depth = 0, hasKids = false, expanded = false, pinned = false, onToggle, onSelect, draggable, onDragStart, onDrop, onDropNode, canDropNode, dropRefusal, onRefuse, dropActive, rename, onBeginRename, onContextMenu }) {
      // Native drag feedback: "ok" paints the accent drop outline, "bad" greys
      // the row and refuses the drop. The browser has no notion of our tree
      // rules, so the row has to say "this target is illegal" itself — that is
      // what makes an impossible move visible *before* the pointer is released.
      const [dropState, setDropState] = useState(null);
      // The sentence already shown for the payload hovering this row. dragover
      // fires on every pointer frame, and a row that explained itself on each
      // frame would repaint the status bar sixty times a second.
      const [refused, setRefused] = useState(null);
      // A row answers a hover when it can *decide* about it, even if it cannot
      // take the drop: 所有会话 and 回收站 refuse by greying out and saying why,
      // instead of staying silent and letting the gesture look broken.
      const answersDrag =
        typeof onDrop === "function" ||
        typeof onDropNode === "function" ||
        typeof canDropNode === "function" ||
        typeof dropRefusal === "function";
      return h(
        "div",
        {
          className:
            "trow" +
            (tone === "ws" ? " ws" : "") +
            (tone === "shortcut" ? " sc" : "") +
            (active ? " sel" : "") +
            (pinned ? " pinned" : "") +
            (dropState === "ok" || dropActive ? " drop" : "") +
            (dropState === "bad" ? " bad" : ""),
          "data-scope": scope,
          "data-drop": dropState ?? undefined,
          style: { paddingLeft: 6 + depth * 14 },
          // A row that is being renamed must not start a drag: the pointer is
          // in the input, and a stray drag would move the very node the user
          // is renaming.
          draggable: draggable === true && !rename,
          onDragStart: draggable && !rename ? onDragStart : undefined,
          onDragEnd: () => {
            // The drag source owns the shared payload; clearing it here covers
            // both "dropped" and "aborted" without a window-level listener.
            setDropState(null);
            dragPayload = null;
          },
          onDragOver: answersDrag
            ? (event) => {
                // Two payloads arrive here: a bare tree node id ("text/plain")
                // from a container drag, and the JSON id list on
                // SESSION_DRAG_TYPE from a session drag. The validator decides
                // per payload; anything it refuses is a greyed "no drop".
                const types = Array.from(event.dataTransfer?.types ?? []);
                const sessionDrag = types.includes(SESSION_DRAG_TYPE);
                if (!sessionDrag && !types.includes("text/plain")) return;
                // Reading data during dragover is forbidden for custom types in
                // most browsers, so the source id comes from the shared drag
                // state the row set when the drag began.
                const kind = sessionDrag ? "session" : "node";
                const verdict = canDropNode ? canDropNode(scope, kind) : true;
                // A row that can decide but owns no handler for this half (a
                // fixed view, a folder the rules keep apart) must still refuse:
                // accepting a drop nothing acts on would lose the payload.
                const handler = sessionDrag ? onDrop : onDropNode;
                if (verdict && typeof handler === "function") {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  if (dropState !== "ok") setDropState("ok");
                } else {
                  // Refusing the default is what makes the browser show 🚫 and
                  // the row grey out instead of pretending the drop will work.
                  event.dataTransfer.dropEffect = "none";
                  if (dropState !== "bad") setDropState("bad");
                  // Grey is a verdict, not an explanation: say which rule
                  // refused the payload, once per hover.
                  const reason = typeof dropRefusal === "function" ? dropRefusal(scope, kind) : null;
                  if (reason && reason !== refused) {
                    setRefused(reason);
                    onRefuse?.(reason);
                  }
                }
              }
            : undefined,
          onDragLeave: answersDrag
            ? () => {
                setDropState(null);
                setRefused(null);
              }
            : undefined,
          onDrop: answersDrag
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                setDropState(null);
                setRefused(null);
                const types = Array.from(event.dataTransfer?.types ?? []);
                const sessionDrag = types.includes(SESSION_DRAG_TYPE);
                const verdict = canDropNode ? canDropNode(scope, sessionDrag ? "session" : "node") : true;
                if (!verdict) return;
                const handler = sessionDrag ? onDrop : onDropNode;
                if (typeof handler === "function") handler(scope, event);
              }
            : undefined,
          onClick: (event) => {
            event.stopPropagation();
            if (!rename) onSelect(scope);
          },
          // A double click on a tree row enters it, the same as a single click:
          // without this the browser selected the label text instead, which is
          // what "双击打不开工作区" looked like.
          onDoubleClick: (event) => {
            event.stopPropagation();
            if (!rename) onSelect(scope);
          },
          onContextMenu,
        },
        h(
          "span",
          {
            className: "caret" + (hasKids ? "" : " hidden"),
            onClick: (event) => {
              if (!hasKids) return;
              event.stopPropagation();
              onToggle(scope);
            },
          },
          hasKids ? h(Icon, { name: expanded ? "chevdown" : "chevright", size: 14 }) : null,
        ),
        h("span", { className: "ic" }, h(Icon, { name: icon, size: 14 })),
        rename
          ? h(RenameInput, {
              className: "lbl-edit",
              value: rename.value,
              onChange: rename.onChange,
              onCommit: rename.onCommit,
              onCancel: rename.onCancel,
            })
          : h("span", { className: "lbl" }, label),
        // The mark for 置顶: the row stays where it lives and only sorts first,
        // so this glyph is the whole visible difference (see the .tpin rule).
        pinned ? h("span", { className: "tpin", title: T("已置顶") }, h(Icon, { name: "pin", size: 10 })) : null,
        // A shortcut is a reference, and says so in words: the row keeps the
        // target's own type glyph, so the label is what marks it as a pointer.
        // The hint also carries the lifecycle rule — the shortcut is a second
        // row for something that lives elsewhere, so deleting it is refused
        // and unlinking is the only way out.
        tone === "shortcut"
          ? h(
              "span",
              { className: "sctag", title: T("快捷方式 · 删除只移除标注，原文件保留") },
              T("快捷方式"),
            )
          : null,
        // Same affordance as a list row: the pencil appears on hover/selection
        // only, so the tree does not sprout a control on every line.
        !rename && onBeginRename
          ? h(
              "span",
              {
                className: "nm-editbtn",
                title: T("重命名"),
                onClick: (event) => {
                  event.stopPropagation();
                  onBeginRename();
                },
              },
              h(Icon, { name: "pencil", size: 10 }),
            )
          : null,
        Number.isFinite(count) ? h("span", { className: "cnt" }, formatCount(count)) : null,
      );
    }

    function Empty({ icon, title, hint }) {
      return h(
        "div",
        { className: "empty" },
        h("div", { className: "big" }, h(Icon, { name: icon, size: 34 })),
        h("div", { className: "t" }, title),
        hint ? h("div", { className: "s" }, hint) : null,
      );
    }

    // ── Tree pane ──────────────────────────────────────────────────────────
    function TreePane({
      tree,
      scope,
      onSelect,
      expanded,
      onToggle,
      width,
      onMove,
      onDropSessions,
      onPlaceSessions,
      onDropShortcut,
      // Hints leave the tree through a prop: TreePane is a module-level
      // component, so Panel's `setHint` is not in its scope.
      onHint,
      rename,
      onBeginRename,
      onNodeContextMenu,
      onDropOnFixed,
      canDropOnFixed,
      onShortcutContextMenu,
      // 空白处 in the rail: 刷新 / 粘贴 / 新建文件夹, the same three commands the
      // list offers, because the rail has no other background to stand on. Rows
      // stop their own event; this only fires in the gaps between them.
      onBlankContextMenu,
      onHighlight,
      // Activating a *reference* has to land on what it points at: the tree used
      // to hand the shortcut id to the same onSelect a folder uses, so the panel
      // stood inside an empty node and the list went blank.
      onOpenShortcut,
      pins,
      // 快速访问 is the host's bookmark list, not a derived view of `pins`:
      // pinning orders a row inside 目录, this keeps a container one click away
      // from anywhere.
      quickAccess,
      // A drop on the 快速访问 *label* parks the dragged container there: that
      // label is the only part of the strip that is about the strip. Its rows
      // are the folders themselves, so a drop on one goes inside it.
      onDropOnQuick,
      sessionsById,
    }) {
      const counts = tree?.counts ?? {};
      const nodes = tree?.nodes ?? {};
      const children = tree?.children ?? {};
      // A shortcut to a session points outside the tree, so resolving its label
      // and glyph needs the session table too. Without it the row could only
      // ever say 失效的快捷方式 — the bug that made new shortcuts look dead.
      const sessionOf = (id) => sessionsById?.get?.(id) ?? null;
      // The rail is navigation only, but the 目录 band still skips its containers:
      // 收藏 / 待办 / 未分组 are pages, not directories, and a shortcut inside one
      // is listed in the right pane for that page rather than in a tree branch.
      const railOwned = new Set([FIXED.favorites, FIXED.todos, FIXED.ungrouped]);

      /**
       * What a drop on a container row means — one definition, every row.
       *
       * A 目录 row and a 快速访问 row are the same kind of target: whatever you
       * drag ends up *inside* it. The strip lists folders and workspaces, so a
       * drop on one of its rows has to do exactly what that same folder does one
       * level down in 目录. Reading it as a strip gesture instead made a
       * bookmarked folder refuse a file it happily took in the tree.
       */
      const containerDrop = (targetId) => {
        const target = nodes[targetId];
        const acceptsDrop = Boolean(target?.accepts?.folder || target?.accepts?.shortcut);
        // The verdict half is wired for every row, the acting half only for the
        // rows the host says can take something. A row that stayed silent about
        // an impossible drop (a session dragged onto 所有会话) left the gesture
        // with no cue at all — the target has to say no out loud.
        const answers = {
          canDropNode: (id, draggedKind) => {
            if (draggedKind === "session") {
              // A workspace or 未分组 re-homes the session; any other reference
              // container takes it as a shortcut. Without this the row never
              // highlights and the browser refuses the drop before `onDrop` runs.
              const node = nodes[id];
              if (!node) return false;
              if (node.accepts?.session) return true;
              return Boolean(node.accepts?.shortcut && typeof onDropShortcut === "function");
            }
            // The row lights up when *something* in the set may land in it; the
            // drop itself moves the legal half and says so for the rest.
            const sources = draggedNodeIds();
            return sources.some((source) => source !== id && canDropInTree(source, id, nodes, children));
          },
          dropRefusal: (id, draggedKind) => dropRefusalFor(id, draggedKind, { nodes, children }),
          onRefuse: onHint ? (message) => onHint(message) : undefined,
        };
        if (!acceptsDrop) return answers;
        return {
          ...answers,
          // A whole check-set can arrive here: every ticked container
          // moves, and the ones the tree rules refuse are dropped from the batch
          // with one hint rather than cancelling the whole gesture.
          onDropNode: (id) => {
            const sources = draggedNodeIds().filter((source) => source !== id);
            if (sources.length === 0) return;
            const legal = sources.filter((source) => canDropInTree(source, id, nodes, children));
            if (legal.length === 0) {
              onHint?.(T("这里放不下：工作区不能放进工作区，含工作区的文件夹也不能再放一个工作区"));
              return;
            }
            if (legal.length < sources.length) {
              onHint?.(T("这里放不下：工作区不能放进工作区，含工作区的文件夹也不能再放一个工作区"));
            }
            onMove?.(legal, id);
          },
          // Dropping *sessions* on a row re-homes them. A workspace gets a real
          // move; 未分组 is a virtual placement, because the payload still belongs
          // to its workspace on disk (hard constraint 1). A user folder can only
          // hold a *reference*: dropping one here leaves a shortcut and moves
          // nothing — the same rule the list rows follow.
          onDrop:
            onDropSessions || onPlaceSessions || onDropShortcut
              ? (id, event) => {
                  const ids = draggedSessionIds(event);
                  if (ids.length === 0) return;
                  const node = nodes[id];
                  if (!node) return;
                  const copy = event.ctrlKey || event.metaKey;
                  if (node.accepts?.session && node.workspaceId) {
                    onDropSessions?.(ids, node.workspaceId, copy);
                  } else if (node.accepts?.session) {
                    onPlaceSessions?.(ids, id);
                  } else if (node.accepts?.shortcut && onDropShortcut) {
                    onDropShortcut(id, ids);
                    onHint?.(T("已创建快捷方式（原位置不变）"));
                  }
                }
              : undefined,
        };
      };

      // The fixed band is a rail of always-reachable entries, and 目录 is where
      // things really live. They are not duplicates: the rail is a shortcut that
      // stays in view while 目录 is expanded three levels deep.
      //
      //   1. 固定入口 — 根目录, 所有会话, 未分组, 回收站, 待办, 收藏
      //   2. 快速访问 — the user's pinned containers (folders / workspaces)
      //   3. 目录     — the real hierarchy, 根目录 first
      //
      // Every entry shows its count, the bin included: a rail whose numbers only
      // sometimes appear reads as broken.
      const rows = [];
      // Highlight for the 快速访问 drop zone: one flag for the whole band, because
      // the caption and the empty placeholder are the same target.
      const [quickOver, setQuickOver] = useState(false);
      // A caller that predates pins (a test harness, an older host) still gets a
      // working tree: 置顶 is decoration, not a precondition.
      const pinnedMap = pins ?? {};
      const trashCount = counts[FIXED.trash] ?? 0;
      const fixedEntries = [
        { id: FIXED.root, icon: "folder", get label() { return T("根目录"); }, count: counts[FIXED.root] ?? 0 },
        { id: FIXED.all, icon: "details", get label() { return T("所有会话"); }, count: counts[FIXED.all] ?? 0 },
        { id: FIXED.ungrouped, icon: "chat", get label() { return T("未分组"); }, count: counts[FIXED.ungrouped] ?? 0 },
        { id: FIXED.trash, icon: "trash", get label() { return T("回收站"); }, count: trashCount },
        { id: FIXED.todos, icon: "todo", get label() { return T("待办"); }, count: counts[FIXED.todos] ?? 0 },
        { id: FIXED.favorites, icon: "star", get label() { return T("收藏"); }, count: counts[FIXED.favorites] ?? 0 },
      ];

      // 根目录, 未分组, 待办 and 收藏 accept drops (a shortcut, a folder, a session
      // into 未分组); the bin and the flat list only receive a navigate. Whether a
      // row is a target *at all* is the host's answer — `accepts` ships with every
      // node — and the payload decides the rest, so a wrong target greys out
      // instead of accepting and failing.
      for (const entry of fixedEntries) {
        const node = nodes[entry.id] ?? null;
        const accepts =
          Boolean(node?.accepts && (node.accepts.folder || node.accepts.session || node.accepts.shortcut)) &&
          typeof onDropOnFixed === "function";
        // The rail is a row of buttons: every entry opens its page in the right
        // pane and none of them grows a subtree. Expansion here put a second,
        // truncated copy of 收藏's contents under a heading the user reads as a
        // page name, and the chevrons made the six entries look like folders.
        rows.push(
          h(Trow, {
            key: "fixed-" + entry.id,
            scope: entry.id,
            icon: entry.icon,
            label: entry.label,
            count: entry.count,
            active: scope === entry.id,
            depth: 0,
            onSelect,
            onContextMenu: onNodeContextMenu
              ? (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(entry.id);
                  onNodeContextMenu(event, { kind: "fixed", id: entry.id, nodeId: entry.id, node: node ?? { id: entry.id, fixed: true } });
                }
              : undefined,
            // A fixed entry is a drop target for a *drag*, never a move target —
            // and it has to be wired on BOTH channels: a session drag calls
            // `onDrop`, a container drag calls `onDropNode`. Wiring only the
            // latter is why dropping a session on 收藏 silently did nothing.
            onDrop: accepts ? (targetId, event) => onDropOnFixed(targetId, event) : undefined,
            onDropNode: accepts ? (targetId, event) => onDropOnFixed(targetId, event) : undefined,
            // Both halves are wired even when the entry takes nothing: the row
            // greys out for a payload it cannot hold and `dropRefusal` names the
            // rule. Leaving 所有会话 / 回收站 unwired made them swallow the
            // gesture in silence, which reads as the panel ignoring the drag.
            canDropNode: (targetId) =>
              accepts && typeof canDropOnFixed === "function" ? canDropOnFixed(targetId) : false,
            dropRefusal: (targetId, kind) => dropRefusalFor(targetId, kind, { nodes, children }),
            onRefuse: onHint ? (message) => onHint(message) : undefined,
          }),
        );
      }

      // 快速访问 — containers the user parked here on purpose. It is a strip of
      // buttons, like the rail: a row opens its scope and nothing unfolds under
      // it, so the band stays a fixed height no matter how deep the tree goes.
      //
      // The band is drawn even when it is empty, because its *label* is the target
      // of the gesture that fills it: dragging a folder onto 快速访问 is how a
      // container becomes a bookmark, and a label that only appears after the
      // first bookmark cannot be found by the very drag that would create it.
      //
      // Its rows are a different thing: each one is the folder it names, so a drop
      // there goes *inside* that folder, not into the strip.
      const quickRows = Array.isArray(quickAccess) ? quickAccess : [];
      // 多选拖动: every dragged container is parked, not just the one
      // under the pointer, because the strip is a list of the same thing.
      const quickSources = () => draggedNodeIds();
      // One sentence per gesture: the band is a single surface and dragover
      // fires on every pointer frame.
      const quickSay = (message) => {
        if (!message || quickHinted === message) return;
        quickHinted = message;
        onHint?.(message);
      };
      const quickDropProps =
        typeof onDropOnQuick === "function"
          ? {
              onDragOver: (event) => {
                // A row inside the band owns its own drop (see containerDrop),
                // so the band's verdict only applies to its own surface: the
                // caption, the empty line and the blank strips beside them.
                if (event.target?.closest?.(".trow")) return;
                const types = Array.from(event.dataTransfer?.types ?? []);
                // A session cannot become a bookmark — 快速访问 only holds
                // containers — so the band says where the file *can* go instead
                // of refusing in silence.
                if (types.includes(SESSION_DRAG_TYPE)) {
                  quickSay(T("会话不能放进快速访问：拖到里面某个文件夹那一行上"));
                  return;
                }
                const sources = quickSources();
                if (sources.length === 0) {
                  // A drag that began in another window leaves no module state
                  // behind: text/plain is the only half that survives that hop,
                  // so the strip takes it and reads the id at drop time rather
                  // than staying dead for the whole gesture.
                  if (!types.includes("text/plain")) return;
                  quickHinted = "";
                  event.preventDefault();
                  event.dataTransfer.dropEffect = dropEffectFor(event.dataTransfer, "copy");
                  if (!quickOver) setQuickOver(true);
                  return;
                }
                // The strip holds entry points, so it holds a folder or a
                // workspace — nothing else. Asking here refuses the drag *before*
                // the write, which is what stops the strip from promising
                // 已放到快速访问 for an id the host would only skip.
                const bookmarkable = sources.filter((id) => isBookmarkableNode(nodes[id]));
                if (bookmarkable.length === 0) {
                  quickSay(T("快速访问只能放文件夹或工作区"));
                  event.dataTransfer.dropEffect = "none";
                  return;
                }
                quickHinted = "";
                event.preventDefault();
                // A drop here *adds* an entry point; nothing moves on disk, which
                // is why the cursor says copy and not move — as long as the source
                // allows a copy at all, otherwise the drop would be cancelled.
                event.dataTransfer.dropEffect = dropEffectFor(event.dataTransfer, "copy");
                if (!quickOver) setQuickOver(true);
              },
              onDragLeave: (event) => {
                // Moving between the band's own children fires leave/enter
                // pairs; only a real exit ends the gesture.
                if (event.currentTarget?.contains?.(event.relatedTarget)) return;
                quickHinted = "";
                setQuickOver(false);
              },
              onDrop: (event) => {
                event.preventDefault();
                event.stopPropagation();
                quickHinted = "";
                let sources = quickSources();
                if (sources.length === 0) {
                  // The shared payload is gone (another window, or a browser that
                  // cleared it): the DataTransfer is the only source left.
                  const raw = String(event.dataTransfer?.getData?.("text/plain") ?? "").trim();
                  if (raw) sources = [raw];
                }
                dragPayload = null;
                setQuickOver(false);
                if (sources.length > 0) onDropOnQuick(sources);
              },
            }
          : {};
      rows.push(h("div", { key: "sep-quick", className: "tsep" }));
      // 快速访问 is *one* drop surface: dropping a folder or workspace
      // anywhere on the band that is not a row parks it here. Its rows mean the
      // opposite thing — each one is the folder it names, so a file dropped on a
      // row goes inside that folder and never re-bookmarks the strip.
      const quickBand = [];
      quickBand.push(
        h(
          "div",
          {
            key: "cap-quick",
            className: "tcap",
            title: T("把文件夹或工作区拖到这里加入快速访问；拖到下面的行上则放进那个文件夹"),
          },
          T("快速访问"),
        ),
      );
      if (quickRows.length === 0) {
        // An empty band still says what it is for: this line is the visible
        // reminder of the gesture, and the band around it is the target.
        quickBand.push(h("div", { key: "quick-empty", className: "tghost" }, T("把文件夹或工作区拖到这里")));
      }
      for (const id of quickRows) {
          const node = nodes[id];
          if (!node) continue;
          quickBand.push(
            h(Trow, {
              key: "quick-" + id,
              scope: id,
              icon: iconOfNode(node, tree),
              label: nodeLabel(node, tree, sessionOf),
              count: counts[id] ?? 0,
              active: scope === id,
              tone: node.kind === "shortcut" ? "shortcut" : node.type === "workspace" ? "ws" : "default",
              // A bookmark drags as the container it points at, so the row can be
              // dropped anywhere the container itself could be dropped.
              draggable: true,
              onDragStart: (event) => {
                dragPayload = { kind: "node", id, ids: [id], sessions: [], nodes: [id] };
                event.dataTransfer.setData("text/plain", id);
                // Either gesture is real: the row can be moved into a folder or
                // offered to the 快速访问 caption, which asks for a copy.
                event.dataTransfer.effectAllowed = "copyMove";
              },
              // This row *is* the folder: a drop here lands inside it, exactly as
              // it would one level down in 目录. It is not a strip gesture —
              // dragging a file onto the folder shown here must put the file in
              // that folder, not re-bookmark the strip.
              ...containerDrop(id),
              onSelect,
              // The same menu as the row's twin in 目录 — 移出快速访问 included, so
              // the bookmark can be dropped from the place it is shown.
              onContextMenu: onNodeContextMenu
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    (onHighlight ?? onSelect)?.(id);
                    onNodeContextMenu(event, {
                      kind: node.type === "workspace" ? "workspace" : "folder",
                      id: node.type === "workspace" ? node.workspaceId ?? id : id,
                      nodeId: id,
                      node,
                      surface: "tree",
                    });
                  }
                : undefined,
            }),
          );
      }
      rows.push(
        h("div", { key: "quick-band", className: "qband" + (quickOver ? " qdrop" : ""), ...quickDropProps }, quickBand),
      );

      rows.push(h("div", { key: "sep-dir", className: "tsep" }));
      rows.push(h("div", { key: "cap-dir", className: "tcap" }, T("目录")));

      // A function declaration rather than a const arrow: the rail above calls
      // it for the children of 收藏 / 待办 / 未分组, and a `const` would still be
      // in its temporal dead zone at that point.
      function walk(id, depth) {
        const node = nodes[id];
        if (!node) return;
        // The three reference containers are rail rows, and the rail renders
        // their children too, so walking into them here would list the same
        // shortcut twice. 根目录 is a rail row as well — the 目录 band *is* its
        // contents, which is why it is not in `railOwned`.
        const kids = (children[id] ?? [])
          .map((child) => nodes[child])
          .filter((child) => child && child.id !== FIXED.all && child.id !== FIXED.trash && !railOwned.has(child.id))
          // A session shortcut is a bookmark, not a branch: it has no subtree to
          // unfold, and the row it drew in the tree looked like a container that
          // opened nothing. The folder's list still shows it, which is where it
          // can be opened or removed.
          .filter((child) => !(child.kind === "shortcut" && child.shortcutKind === "session"))
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          // 置顶 is a ranking, not a band: a pinned row sorts first among the
          // siblings it already has. Hoisting it into 快速访问 instead reads as
          // "the folder moved" and hides it from 目录 — the two features would
          // share one map. Array#sort is stable, so this keeps the manual order
          // inside each of the two groups.
          .sort((a, b) => Number(Boolean(pinnedMap[b.id])) - Number(Boolean(pinnedMap[a.id])));
        const isOpen = expanded.has(id);
        // A workspace row renames the *native* workspace record, a folder row
        // renames the sidecar node: the two id spaces never mix.
        const renameKind = node.type === "workspace" ? "workspace" : "folder";
        const effectiveId = node.type === "workspace" ? node.workspaceId ?? id : id;
        rows.push(
          h(Trow, {
            key: "dir-" + id,
            scope: id,
            icon: iconOfNode(node, tree),
            label: nodeLabel(node, tree, sessionOf),
            count: counts[id] ?? 0,
            active: scope === id,
            tone: node.kind === "shortcut" ? "shortcut" : node.type === "workspace" ? "ws" : "default",
            depth,
            hasKids: kids.length > 0,
            expanded: isOpen,
            pinned: Boolean(pinnedMap[id]),
            onToggle,
            // A shortcut is a reference, not a place: there is nothing to open
            // beneath it, so activating it goes to the original instead of
            // standing in an empty scope.
            onSelect:
              node.kind === "shortcut" && onOpenShortcut
                ? (event) => {
                    event?.stopPropagation?.();
                    onHighlight?.(id);
                    onOpenShortcut(node);
                  }
                : onSelect,
            // Either id space: see the same note in the list's container rows.
            rename:
              rename &&
              (rename.id === effectiveId || rename.id === id) &&
              rename.kind === renameKind &&
              rename.surface !== "list"
                ? rename
                : null,
            // Fixed containers (根目录/收藏/待办/未分组/回收站) are not the user's
            // to rename, so they get no editor at all. A workspace is addressed
            // by its native workspaceId — handing the tree id (w-<uuid>) to the
            // folder route would rename nothing and answer bad-request instead.
            // 默认工作区 is a real workspace whose label is synthetic (the host
            // always calls it 默认工作区), so editing it would be a no-op round
            // trip; every other workspace is fair game.
            // Fixed containers get no context menu: every item on it would be
            // disabled, which is worse than not offering one.
            onContextMenu:
              node.kind === "shortcut" && onShortcutContextMenu
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    // Highlight, never navigate: navigation clears the
                    // checked set, and a right-click inside a selection must
                    // act on the whole selection.
                    (onHighlight ?? onSelect)?.(id);
                    onShortcutContextMenu(event, { kind: "shortcut", id, nodeId: id, node });
                  }
                : onNodeContextMenu
                  ? (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      (onHighlight ?? onSelect)?.(id);
                      onNodeContextMenu(event, { kind: renameKind, id: effectiveId, nodeId: id, node, surface: "tree" });
                    }
                  : undefined,
            onBeginRename:
              onBeginRename && !node.fixed && node.kind !== "shortcut"
                ? () => onBeginRename(renameKind, effectiveId, "tree")
                : undefined,
            // A shortcut is draggable like any other row: moving it moves the
            // *reference*, never the target.
            draggable: node.type === "folder" ? !node.fixed : true,
            onDragStart: (event) => {
              dragPayload = { kind: "node", id };
              event.dataTransfer.setData("text/plain", id);
              // A tree row is both movable (into a folder) and copyable (onto a
              // folder as a shortcut, or onto the 快速访问 caption as a bookmark).
              event.dataTransfer.effectAllowed = "copyMove";
            },
            // Whatever lands here goes *inside* this node.
            ...containerDrop(id),
          }),
        );
        if (isOpen) for (const child of kids) walk(child.id, depth + 1);
      }

      // 目录 starts at 根目录 only: 回收站 is the one node outside the root and
      // the fixed band already offers a direct entry to it.
      walk(FIXED.root, 0);
      // The empty tail of the rail: rows fill from the top, so a short tree
      // leaves the bottom half as bare `<aside>` — which the rail does handle,
      // but only where the aside itself is hit. A filler makes that whole
      // remainder one honest target for the blank-area menu and for drops.
      rows.push(h("div", { key: "tree-blank", className: "tblank", "aria-hidden": "true" }));

      return h(
        "aside",
        {
          className: "pane-tree",
          id: "se-tree",
          style: { flexBasis: width + "px", width: width + "px" },
          // Rows carry their own menu and stop the event; this is the rail's
          // bare background. The closest() guard is belt-and-braces for the
          // 目录 node rows, whose handler does not call stopPropagation.
          onContextMenu: onBlankContextMenu
            ? (event) => {
                if (event.target?.closest?.(".trow")) return;
                event.preventDefault();
                onBlankContextMenu(event);
              }
            : undefined,
        },
        rows,
      );
    }

