    // ── Detail pane ────────────────────────────────────────────────────────
    const paneStyle = { flexBasis: "var(--detail-width)", width: "var(--detail-width)" };

    /**
     * The note box.
     *
     * The text is edited locally and committed on blur, but it follows the
     * host's value whenever that value changes. With `defaultValue` the box
     * kept whatever had been typed even after the host reported a different
     * note (an undo, another window, a save that failed and then a reload), so
     * it could show text that was no longer the note — and blurring it wrote
     * that stale text back over the newer one.
     */
    function NoteField({ sessionId, note, onSetNote }) {
      const [draft, setDraft] = useState(note ?? "");
      useEffect(() => {
        setDraft(note ?? "");
      }, [note]);
      return h("textarea", {
        className: "note",
        value: draft,
        placeholder: T("写点只属于这条会话的备注…"),
        onChange: (event) => setDraft(event.target.value),
        onBlur: () => {
          const value = draft.trim();
          if (value !== (note ?? "")) onSetNote(sessionId, value);
        },
      });
    }

    /**
     * Detail pane.
     *
     * Everything that names something is renamed from here: the title
     * row carries an inline editor, and the same control renames a workspace or
     * a folder when one of those is selected instead of a session.
     *
     * Tags are picked from the shared library rather than retyped, so the
     * vocabulary stays small and one tag is never spelled two ways.
     *
     * A fork and a subagent both carry parentSession, but only a subagent is a
     * child. The two relations therefore get separate rows: 子智能体 / 子会话 for
     * a real delegation, 分叉自 / 分叉出去 for an independent copy.
     */
    function DetailPane({
      session,
      node,
      tree,
      sessionOf,
      now,
      onClose,
      onHint,
      parent,
      children = EMPTY_LIST,
      forks = EMPTY_LIST,
      forkSource,
      onOpen,
      onEnterNode,
      onOpenSession,
      tagLibrary,
      onAddTag,
      onRemoveTag,
      onNewTag,
      onDropTag,
      onSetNote,
      onToggleFlag,
      onArchive,
      onFork,
      onRename,
      onRestore,
      onDelete,
      onExport,
      onReveal,
      onCopyPath,
      onCopyNodePath,
      onRevealDir,
      onApplied,
    }) {
      const [editing, setEditing] = useState(false);
      const [draft, setDraft] = useState("");
      const [tagOpen, setTagOpen] = useState(false);
      const [newTag, setNewTag] = useState("");
      // Which generated tags the user ticked for 合并所选. `null` means "all of
      // them", which is both the default and what a fresh record should offer;
      // an explicit list survives re-renders so a half-made selection is not
      // reset by a poll from the queue.
      const [pickedTags, setPickedTags] = useState(/** @type {string[]|null} */ (null));
      // Escape closes the editor and the blur that follows must not commit the
      // abandoned text; a ref survives the re-render that the keydown causes.
      const cancelled = useRef(false);

      // Switching rows must not carry a half-typed name or an open picker over.
      const targetId = session?.id ?? node?.id ?? null;
      useEffect(() => {
        setEditing(false);
        setDraft("");
        setTagOpen(false);
        setNewTag("");
        // A new record (regenerated fields) starts with everything ticked.
        setPickedTags(null);
      }, [targetId]);

      // AI 字段: the record lives on the summaries store, shared with
      // the footer and 设置, so a run started from the context menu shows up
      // here while it is still being generated. Read above the empty-state
      // return below: a hook that only ran once something was selected made the
      // hook count differ between renders, which React refuses to render.
      const aiSummary = useSummaries();

      // A container is a workspace or a folder, and the two are told apart by
      // `node.type` alone. Reading anything else (an icon, a fixed flag) made a
      // workspace show up as 文件夹 in the detail pane.
      const nodeKind = !node ? null : node.type === "workspace" ? "workspace" : "folder";
      const kind = session ? "session" : nodeKind;
      const label = session ? session.displayTitle ?? session.id : nodeLabel(node, tree, sessionOf) || "";
      // Fixed views (root, trash, the built-in containers) are not ours to
      // rename, so they get no editor at all rather than a failing round trip.
      // A workspace renames like any other node, 默认工作区 included. A shortcut
      // shows its target's name, so that is not the user's to give either.
      const canRename = session
        ? true
        : Boolean(node && !node.fixed && node.kind !== "shortcut");
      const library = Array.isArray(tagLibrary) ? tagLibrary : [];
      const tags = session?.tags ?? [];

      const beginRename = () => {
        setDraft(label);
        cancelled.current = false;
        setEditing(true);
      };

      const commitRename = () => {
        if (cancelled.current) {
          cancelled.current = false;
          setEditing(false);
          return;
        }
        const value = draft.trim();
        setEditing(false);
        setDraft("");
        if (!value || value === label) return;
        // A workspace node is addressed by its native id, not by the tree id.
        const id = kind === "workspace" ? node?.workspaceId : session?.id ?? node?.id;
        if (!id) return;
        onRename(kind, id, value);
      };

      const submitNewTag = () => {
        const value = newTag.trim();
        if (!value || !session) return;
        onNewTag(session.id, value);
        setNewTag("");
      };

      if (!session && !node) {
        return h(
          "aside",
          { className: "pane-detail", style: paneStyle },
          h(Empty, { icon: "details", title: T("选中一项查看详情"), hint: T("可多选后批量操作") }),
        );
      }

      const status = session ? statusOf(session) : null;
      const stats = session?.stats ?? {};
      const tokens = session?.tokenUsage ?? {};
      const pressure = session?.contextPressure ?? {};

      // Whether this very session is the one being written right now.
      const summaryEntry = session ? aiSummary.sessions?.[session.id] ?? null : null;
      const summaryWriting = Boolean(session) && aiSummary.state?.current?.id === session.id;
      const summaryModel = summaryEntry?.model?.model || "";
      const summaryTokens =
        (summaryEntry?.tokens?.inputTokens ?? 0) + (summaryEntry?.tokens?.outputTokens ?? 0);
      // 合并所选 defaults to every generated tag: a click on 合并 should do the
      // obvious thing, and unticking is how the user says "not that one".
      const aiTags = summaryEntry?.tags ?? EMPTY_LIST;
      const aiPicked = pickedTags === null ? aiTags : aiTags.filter((tag) => pickedTags.includes(tag));
      const toggleTag = (tag) => {
        setPickedTags((current) => {
          const base = current === null ? aiTags : current;
          return base.includes(tag) ? base.filter((item) => item !== tag) : [...base, tag];
        });
      };

      const kv = (key, value) =>
        h("div", { className: "kv", key }, h("span", { className: "k" }, key), h("span", { className: "v" }, value));

      const head = h(
        "div",
        { className: "det-head" },
        h(
          "div",
          { className: "det-ic" },
          // A session is not a tree node, so asking the node table answered
          // "folder" for every session selected in the pane — the one glyph the
          // row above never shows for a conversation. Sessions wear the same
          // glyph here that they wear in the list.
          h(Icon, { name: session ? (session.isSubagent ? "external" : "chat") : iconOfNode(node, tree), size: 18 }),
        ),
        h(
          "div",
          { style: { minWidth: 0, flex: 1 } },
          editing && canRename
            ? h("input", {
                className: "det-rename",
                value: draft,
                autoFocus: true,
                spellCheck: false,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === "Enter") commitRename();
                  else if (event.key === "Escape") {
                    cancelled.current = true;
                    setEditing(false);
                    setDraft("");
                  }
                },
                onBlur: commitRename,
              })
            : h(
                "div",
                { className: "det-title-row" },
                h("div", { className: "det-title", title: label }, label),
                canRename
                  ? h(
                      "button",
                      { type: "button", className: "det-title-edit", title: T("重命名"), onClick: beginRename },
                      h(Icon, { name: "pencil", size: 11 }),
                    )
                  : null,
              ),
          h(
            "div",
            { className: "det-sub" },
            session
              ? (session.trashed ? T("回收站 · 已删除") : (session.workspaceTitle ?? T("未分组")) + " · " + (session.agentPreset ?? T("默认预设")))
              : kind === "workspace"
                ? node?.path ?? ""
                : node?.id === FIXED.root
                  ? T("全部会话")
                  : T("自建文件夹"),
          ),
          forkSource
            ? h(
                "div",
                { className: "det-fork" },
                h(Icon, { name: "copy", size: 10 }),
                h("span", null, T("分叉自")),
                h(
                  "span",
                  { className: "det-link", onClick: () => onOpen(forkSource.id) },
                  forkSource.displayTitle ?? forkSource.id,
                ),
              )
            : null,
        ),
        h("button", { className: "dclose", title: T("关闭"), onClick: onClose }, h(Icon, { name: "x", size: 13 })),
      );

      // A node can be in scope with no session selected (the root, a workspace),
      // so every session-only branch is built conditionally. Building it first
      // and hiding it later would dereference a null session during render and
      // take the whole slot down with it.
      const sessionBody = !session ? null : h(
        "div",
        { className: "det-body" },
        kv(T("大小"), formatSize(session.sizeBytes) || "—"),
        kv(T("上次对话"), formatWhen(session.activityAt, now) || "—"),
        kv(T("创建"), formatWhen(session.createdAt, now) || "—"),
        kv(T("状态"), status.text),
        kv(T("轮次"), formatCount(stats.turns ?? 0)),
        // 路径 is the session's working directory, and the row itself is the
        // shortest way to get there: the same reveal the row menu offers, on the
        // text the user is already reading.
        kv(
          T("路径"),
          session.cwd
            ? h(
                "span",
                {
                  className: "det-link",
                  title: T("在文件管理器中打开工作目录"),
                  onClick: () => onRevealDir?.(session.id),
                },
                session.cwd,
              )
            : "—",
        ),
        // Only a real subagent has a parent conversation; a fork is a sibling.
        session.isSubagent && session.parentSession
          ? h(
              "div",
              { className: "kv" },
              h("span", { className: "k" }, T("子智能体")),
              h(
                "span",
                { className: "v" },
                h(
                  "span",
                  { className: "detail-parent", onClick: () => onOpen(parent?.id ?? session.parentSession) },
                  h(Icon, { name: "external", size: 11 }),
                  h("span", { className: "nm" }, parent?.displayTitle ?? session.parentSession),
                ),
                h("span", { className: "subtag" }, T("深度 ") + (session.delegationDepth ?? 1)),
              ),
            )
          : null,
        children.length > 0
          ? h(
              "div",
              { className: "kv" },
              h("span", { className: "k" }, T("子会话")),
              h("span", { className: "v" }, formatCount(children.length) + T(" 个")),
            )
          : null,
        forks.length > 0
          ? h(
              "div",
              { className: "kv" },
              h("span", { className: "k" }, T("分叉出去")),
              h(
                "span",
                { className: "v" },
                forks.map((fork, index) =>
                  h(
                    React.Fragment,
                    { key: fork.id },
                    index > 0 ? h("span", { className: "det-sep" }, T("、")) : null,
                    h(
                      "span",
                      { className: "det-link", onClick: () => onOpen(fork.id) },
                      fork.displayTitle ?? fork.id,
                    ),
                  ),
                ),
              ),
            )
          : null,
        kv(T("会话 id"), session.id),
      );

      const nodeBody = h(
        "div",
        { className: "det-body" },
        kv(
          T("类型"),
          kind === "workspace"
            ? node?.kind === "default-workspace"
              ? T("工作区（默认）")
              : T("工作区")
            : node?.kind === "root"
              ? T("根目录")
              : node?.kind === "ungrouped"
                ? T("视图")
                : node?.kind === "todos" || node?.kind === "favorites"
                  ? T("视图")
                  : node?.kind === "trash"
                    ? T("回收站")
                    : T("文件夹"),
        ),
        kind === "workspace" ? kv(T("路径"), node?.path ?? "—") : null,
        kv(T("编号"), node?.id ?? "—"),
      );

      const tagSection = session
        ? h(
            "div",
            { className: "det-sec" },
            h("h4", null, T("标签")),
            h(
              "div",
              { className: "det-body", style: { padding: 0 } },
              h(
                "div",
                { className: "taglist" },
                tags.map((tag) =>
                  h(
                    "span",
                    { className: "tagchip", key: tag },
                    tag,
                    h(
                      "span",
                      { className: "x", title: T("移除标签"), onClick: () => onRemoveTag(session.id, tag) },
                      h(Icon, { name: "x", size: 9 }),
                    ),
                  ),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "tagadd" + (tagOpen ? " on" : ""),
                    onClick: () => setTagOpen((previous) => !previous),
                  },
                  h(Icon, { name: tagOpen ? "x" : "plus", size: 11 }),
                  tagOpen ? T("收起") : T("添加标签"),
                ),
              ),
              tagOpen
                ? h(
                    "div",
                    { className: "tagpanel" },
                    library.length === 0
                      ? h("div", { className: "tagempty" }, T("标签库是空的，在下面输入一个就会存进来"))
                      : null,
                    library.map((entry) =>
                      h(
                        "button",
                        {
                          type: "button",
                          key: entry.tag,
                          className: "tagopt" + (tags.includes(entry.tag) ? " on" : ""),
                          title: entry.preset ? T("已在标签库中") : T("仅被会话使用，点击后不会加入库"),
                          onClick: () =>
                            tags.includes(entry.tag)
                              ? onRemoveTag(session.id, entry.tag)
                              : onAddTag(session.id, entry.tag),
                        },
                        tags.includes(entry.tag) ? h(Icon, { name: "check", size: 10 }) : null,
                        entry.tag,
                        h("span", { className: "tagcount" }, formatCount(entry.count ?? 0)),
                        entry.preset
                          ? h(
                              "span",
                              {
                                className: "taglib-del",
                                title: T("从标签库移除（已打上的会话保留）"),
                                onClick: (event) => {
                                  event.stopPropagation();
                                  onDropTag(entry.tag);
                                },
                              },
                              h(Icon, { name: "x", size: 8 }),
                            )
                          : null,
                      ),
                    ),
                    h(
                      "div",
                      { className: "tagnewrow" },
                      h("input", {
                        className: "tagnew",
                        value: newTag,
                        placeholder: T("新建标签并加入库"),
                        spellCheck: false,
                        onChange: (event) => setNewTag(event.target.value),
                        onKeyDown: (event) => {
                          if (event.key === "Enter") submitNewTag();
                        },
                      }),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "tagnew-go",
                          title: T("加入标签库并打到这条会话上"),
                          onClick: submitNewTag,
                        },
                        h(Icon, { name: "plus", size: 10 }),
                      ),
                    ),
                  )
                : null,
            ),
          )
        : null;

      const sessionActions = !session ? null : h(
        "div",
        { className: "det-actions" },
        // 打开 hands the session to DSH's own navigation: the plugin is a
        // browser over the real store, never a second chat surface.
        h(Btn, { className: "act primary", icon: "external", disabled: session.trashed, onClick: () => onOpenSession?.(session.id) }, T("打开")),
        // 复制文件路径 puts the session's own log path on the clipboard. This
        // replaced 跳转至文件位置: an OS window can only open where the host
        // is, and a path can be pasted anywhere — an editor, a terminal, or a
        // file dialog on another machine. The host resolves it, because a
        // trashed session's log lives under a name only the index knows.
        h(Btn, {
          className: "act",
          icon: "copy",
          title: T("复制这个会话的日志文件路径"),
          onClick: () => onCopyPath?.(session.id),
        }, T("复制文件路径")),
        h(Btn, {
          className: "act",
          icon: "copy",
          onClick: () => {
            if (typeof navigator !== "undefined" && navigator.clipboard) navigator.clipboard.writeText(session.id).catch(() => {});
            onHint(T("已复制会话 id"));
          },
        }, T("复制 id")),
        h(Btn, { className: "act" + (session.favorite ? " on" : ""), icon: "star", onClick: () => onToggleFlag("favorite") }, session.favorite ? T("取消收藏") : T("收藏")),
        h(Btn, { className: "act" + (session.todo ? " on" : ""), icon: "todo", onClick: () => onToggleFlag("todo") }, session.todo ? T("取消待办") : T("待办")),
        // 导出 reads the session's own log on the host and streams back a file:
        // the panel never reconstructs the conversation itself.
        session.trashed
          ? null
          : h(Btn, { className: "act", icon: "download", onClick: () => onExport?.(session.id, "md") }, T("导出 Markdown")),
        session.trashed
          ? null
          : h(Btn, { className: "act", icon: "download", onClick: () => onExport?.(session.id, "jsonl") }, T("导出 JSONL")),
        // A trashed session has left DSH's own store, so the native operations
        // do not apply to it any more; only 还原 and 永久删除 make sense.
        session.trashed ? null : h(Btn, { className: "act", icon: "branch", onClick: onFork }, T("分叉")),
        session.trashed
          ? h(Btn, { className: "act", icon: "restore", onClick: onRestore }, T("还原"))
          : h(Btn, { className: "act" + (session.archived ? " on" : ""), icon: "archive", onClick: onArchive }, session.archived ? T("取消归档") : T("归档")),
        h(Btn, { className: "act danger", icon: "trash", onClick: onDelete }, session.trashed ? T("永久删除") : T("删除")),
      );

      const nodeActions = h(
        "div",
        { className: "det-actions" },
        // A node has nothing for DSH to open; 打开 means "go into it", which is
        // the only meaningful interpretation for a folder or a workspace.
        h(Btn, { className: "act primary", icon: "external", onClick: () => onEnterNode?.(node?.id) }, T("打开")),
        h(Btn, {
          className: "act",
          icon: "copy",
          onClick: () => {
            if (typeof navigator !== "undefined" && navigator.clipboard) navigator.clipboard.writeText(node?.id ?? "").catch(() => {});
            onHint(T("已复制编号"));
          },
        }, T("复制编号")),
        // 复制目录地址: the workspace's directory on the clipboard, so it can be
        // pasted anywhere — an editor, a terminal, a dialog on another machine.
        // Same reason the session panel copies instead of opening. The label
        // says 目录, not 文件夹: a workspace is a registered directory, and the
        // detail pane must never call it a folder (render-smoke asserts it).
        node?.type === "workspace"
          ? h(Btn, {
              className: "act",
              icon: "copy",
              title: T("复制这个工作区的目录路径"),
              onClick: () => onCopyNodePath?.(node.workspaceId ?? node.id),
            }, T("复制目录地址"))
          : null,
        // 跳转至文件位置: DSH verifies the path and opens the OS file manager.
        node?.type === "workspace"
          ? h(Btn, {
              className: "act",
              icon: "locate",
              onClick: () => onReveal?.({ kind: "workspace", id: node.workspaceId ?? node.id }),
            }, T("跳转至文件位置"))
          : null,
      );

      return h(
        "aside",
        { className: "pane-detail", style: paneStyle },
        head,
        session ? sessionBody : nodeBody,
        tagSection,
        session
          ? h(
              React.Fragment,
              null,
              h(
                "div",
                { className: "det-sec" },
                h("h4", null, T("备注")),
                h(
                  "div",
                  { className: "det-body", style: { padding: 0 } },
                  h(NoteField, {
                    key: session.id,
                    sessionId: session.id,
                    note: session.note,
                    onSetNote,
                  }),
                ),
              ),
              // 字段 sits right under 备注 because both answer "what happened in
              // this session" in words: 备注 is what I wrote, this is what a
              // model read back off the log. Nothing here is applied on its own
              // — 用这个标题 is DSH's own rename event, so it stays a click.
              h(
                "div",
                { className: "det-sec" },
                h("h4", null, T("AI 字段")),
                h(
                  "div",
                  { className: "det-body", style: { padding: 0 } },
                  summaryEntry
                    ? h(
                        React.Fragment,
                        null,
                        h(
                          "div",
                          { className: "ai-field" },
                          h("div", { className: "ai-field-h" }, T("标题")),
                          summaryEntry.title
                            ? h("div", { className: "ai-field-v" }, summaryEntry.title)
                            : h("div", { className: "ai-sum-empty" }, T("还没有生成")),
                          summaryEntry.title
                            ? summaryEntry.applied?.title
                              ? h("span", { className: "ai-field-tag" }, T("已用作标题"))
                              : h(
                                  Btn,
                                  {
                                    className: "act",
                                    icon: "check",
                                    onClick: () => applySummary(session.id, "title", T("已经用这个名字了"), onHint, { onApplied }),
                                  },
                                  T("用这个标题"),
                                )
                            : null,
                        ),
                        h(
                          "div",
                          { className: "ai-field" },
                          h("div", { className: "ai-field-h" }, T("描述")),
                          summaryEntry.description
                            ? h("div", { className: "ai-sum" }, summaryEntry.description)
                            : h("div", { className: "ai-sum-empty" }, T("还没有生成")),
                          summaryEntry.description
                            ? summaryEntry.applied?.description
                              ? h("span", { className: "ai-field-tag" }, T("已并入备注"))
                              : h(
                                  Btn,
                                  {
                                    className: "act",
                                    icon: "pencil",
                                    onClick: () => applySummary(session.id, "description", T("已经并入备注"), onHint, { onApplied }),
                                  },
                                  T("并入我的备注"),
                                )
                            : null,
                        ),
                        h(
                          "div",
                          { className: "ai-field" },
                          h("div", { className: "ai-field-h" }, T("标签")),
                          aiTags.length > 0
                            ? h(
                                "div",
                                { className: "ai-tags" },
                                aiTags.map((tag) => h(
                                  "span",
                                  {
                                    key: tag,
                                    className: aiPicked.includes(tag) ? "ai-tag on" : "ai-tag",
                                    role: "button",
                                    tabIndex: 0,
                                    title: aiPicked.includes(tag) ? T("不合并这个标签") : T("合并这个标签"),
                                    onClick: () => toggleTag(tag),
                                    onKeyDown: (event) => {
                                      if (event.key === "Enter" || event.key === " ") {
                                        event.preventDefault();
                                        toggleTag(tag);
                                      }
                                    },
                                  },
                                  tag,
                                )),
                              )
                            : h("div", { className: "ai-sum-empty" }, T("还没有生成")),
                          aiTags.length > 0
                            ? h(
                                Btn,
                                {
                                  className: "act",
                                  icon: "tag",
                                  disabled: aiPicked.length === 0,
                                  onClick: () => applySummary(session.id, "tags", T("标签已经并入"), onHint, { tags: aiPicked, onApplied }),
                                },
                                T("合并所选（{0}）", [aiPicked.length]),
                              )
                            : null,
                          summaryEntry.applied?.tags ? h("span", { className: "ai-field-tag" }, T("已并入标签")) : null,
                        ),
                        h(
                          "div",
                          { className: "ai-sum-meta" },
                          T("由 {0} 生成 · {1}", [summaryModel || T("模型"), formatWhen(summaryEntry.at, now)]),
                        ),
                        // What this one cost, in the same compact form as Token
                        // 用量 above: the running total lives in settings, but a
                        // number next to the text is what makes the total
                        // believable.
                        summaryTokens > 0
                          ? h("div", { className: "ai-sum-meta" }, T("这次用了 {0} token（输入 {1} · 输出 {2}）", [
                              formatCompact(summaryTokens),
                              formatCompact(summaryEntry.tokens?.inputTokens ?? 0),
                              formatCompact(summaryEntry.tokens?.outputTokens ?? 0),
                            ]))
                          : null,
                        // Generated before the last turn: worth saying, because a
                        // title that no longer describes the work is the one way
                        // these fields can be wrong without looking wrong.
                        summaryEntry.sourceAt && session.activityAt && summaryEntry.sourceAt < session.activityAt
                          ? h("div", { className: "ai-sum-meta" }, T("生成之后这个会话又动过"))
                          : null,
                      )
                    : h(
                        "div",
                        { className: "ai-sum-empty" },
                        summaryWriting ? T("正在写…") : T("还没有生成"),
                      ),
                  h(
                    "div",
                    { className: "ai-sum-act" },
                    h(
                      Btn,
                      {
                        className: "act",
                        icon: "spark",
                        disabled: summaryWriting,
                        onClick: () =>
                          startSummary(
                            [{ id: session.id, title: session.displayTitle ?? session.id }],
                            onHint,
                          ),
                      },
                      summaryWriting ? T("正在写…") : summaryEntry ? T("重新生成") : T("让 AI 写标题和标签"),
                    ),
                    summaryEntry && !summaryWriting
                      ? h(
                          Btn,
                          {
                            className: "act",
                            icon: "trash",
                            onClick: () => {
                              summaryStore.forget(session.id).catch((failure) => {
                                onHint?.(T("生成没成功：{0}", [String(failure?.message ?? failure)]));
                              });
                            },
                          },
                          T("删除"),
                        )
                      : null,
                  ),
                ),
              ),
              h(
                "div",
                { className: "det-sec" },
                h("h4", null, T("执行统计")),
                h(
                  "div",
                  { className: "det-body", style: { padding: 0 } },
                  kv(T("步数"), formatCount(stats.steps ?? 0)),
                  kv(T("模型耗时"), formatDuration(stats.llmMs)),
                  kv(T("首字"), formatDuration(stats.ttftMs)),
                  kv(T("工具耗时"), formatDuration(stats.toolMs)),
                ),
              ),
              h(
                "div",
                { className: "det-sec" },
                h("h4", null, T("Token 用量")),
                h(
                  "div",
                  { className: "det-body", style: { padding: 0 } },
                  kv(T("输入"), formatCompact(tokens.uncachedInputTokens)),
                  kv(T("输出"), formatCompact(tokens.outputTokens)),
                  kv(T("缓存读"), formatCompact(tokens.cacheReadTokens)),
                  kv(T("缓存写"), formatCompact(tokens.cacheWriteTokens)),
                ),
              ),
              h(
                "div",
                { className: "det-sec" },
                h("h4", null, T("上下文")),
                h(
                  "div",
                  { className: "det-body", style: { padding: 0 } },
                  kv(T("压力"), formatCompact(pressure.pressureTokens)),
                  kv(T("面量"), formatCompact(pressure.surfaceTokens)),
                  kv(T("窗口"), formatCompact(pressure.contextWindow)),
                ),
              ),
              sessionActions,
            )
          : nodeActions,
      );
    }

    /**
     * The filter that filters nothing.
     *
     * Three places need it — 重置, 取消筛选, and the status bar's "点击清除" — and
     * every one of them must hand React a *new* object, so this is the shape to
     * copy, never a value to share.
     */
    /**
     * 搜索范围: which session fields the search box reads.
     *
     * The three metadata fields are always searched; 会话内容 is a fourth scope,
     * off by default, because answering it means reading the session logs, and a
     * box that starts a multi-second index build on a stray keystroke is a box
     * people stop typing into.
     *
     * `place` is the other half of the same question — not *what* the
     * box reads but *where* it looks. The default is 所有位置: a search box that
     * quietly answered "not here" because the user happened to stand in an
     * empty folder is a search box that lies. 当前目录 is the narrowing, and it
     * narrows the rows (see searchBaseSessions) and the folder list together.
     */
    const DEFAULT_SEARCH_SCOPES = { place: "all", name: true, tags: true, note: true, content: false };

    /** A persisted 搜索范围, with every field defaulted and coerced to boolean. */
    function normalizeSearchScopes(raw) {
      const source = raw && typeof raw === "object" ? raw : {};
      return {
        place: source.place === "here" ? "here" : "all",
        name: source.name !== false,
        tags: source.tags !== false,
        note: source.note !== false,
        content: source.content === true,
      };
    }

    /** Stable empty hit map, so clearing 会话内容 hits does not allocate a new one. */
    const EMPTY_HITS = Object.freeze({});

    /**
     * Does `session` match `needle` under the chosen 搜索范围?
     *
     * 会话名 carries everything that names the session — both titles, the
     * workspace, the cwd and the id — because those are the strings a person
     * types when they are looking for a row they have already seen. 会话内容 is
     * the one field this function cannot test: the panel holds no session text,
     * so the host index answers it and the hits arrive in `contentHits`.
     *
     * @param {object} session
     * @param {string} needle lowercased, non-empty
     * @param {{ name: boolean, tags: boolean, note: boolean, content: boolean }} scopes
     * @param {Record<string, { id: string, count: number, snippet: string }> | null | undefined} contentHits
     * @returns {boolean}
     */
    function sessionMatchesQuery(session, needle, scopes, contentHits) {
      if (!needle) return true;
      // A caller that passes no scopes means the default ones: the box searched
      // 会话名 / 标签 / 备注 before 搜索范围 existed, and it still does.
      const scope = scopes ?? DEFAULT_SEARCH_SCOPES;
      const hit = (value) => typeof value === "string" && value.toLowerCase().includes(needle);
      if (scope.name) {
        if (
          hit(session.displayTitle) ||
          hit(session.title) ||
          hit(session.cwd) ||
          hit(session.id) ||
          hit(session.workspaceTitle)
        ) {
          return true;
        }
      }
      if (scope.tags && (session.tags ?? []).some(hit)) return true;
      if (scope.note && hit(session.note)) return true;
      if (scope.content && contentHits && contentHits[session.id]) return true;
      return false;
    }

    const EMPTY_FILTER = { scope: "scope", favorite: "all", archived: "all", todo: "all", tags: [] };

    /**
     * 筛选 dialog.
     *
     * A filter is a *view*: it narrows what the current scope lists and never
     * moves, hides or rewrites a session. That is why it can be cleared with one
     * click and why the bin ignores it — a bin you cannot see into is a bin you
     * cannot empty.
     *
     * The two ways out are deliberately different: 重置 empties the form (and
     * still needs 应用筛选, so a half-built filter is not thrown away by a stray
     * click), while 取消筛选 drops the filter that is actually in effect and
     * closes the dialog. The second only exists when there is one — a button that
     * does nothing is worse than no button.
     *
     * Tags intersect (every chosen tag must be present); the three selects are
     * tri-state (all / yes / no) so "未收藏" is expressible without a separate
     * control.
     */
    function FilterDialog({ open, value, library, active, onApply, onClear, onClose }) {
      const [draft, setDraft] = useState(value);
      useEffect(() => {
        if (open) setDraft(value);
      }, [open, value]);
      // Escape closes the dialog, like every other modal in DSH. Registered only
      // while it is open, so it cannot swallow the panel's own Escape handling.
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
      }, [open, onClose]);

      if (!open) return null;
      const tags = (library ?? []).map((entry) => entry.tag).filter(Boolean);
      const toggleTag = (tag) =>
        setDraft((previous) => ({
          ...previous,
          tags: previous.tags.includes(tag)
            ? previous.tags.filter((entry) => entry !== tag)
            : [...previous.tags, tag],
        }));

      return h(
        "div",
        { className: "fmodal open", role: "dialog", "aria-label": T("筛选"), onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h(
          "div",
          { className: "fdlg" },
          h(
            "div",
            { className: "fhead" },
            h("span", { className: "fic" }, h(Icon, { name: "tag", size: 13 })),
            h("span", { className: "ftitle" }, T("筛选")),
            h("span", { className: "spacer" }),
            h("button", { type: "button", className: "wbtn", title: T("关闭"), onClick: onClose }, h(Icon, { name: "x", size: 13 })),
          ),
          h(
            "div",
            { className: "fbody" },
            selectRow(T("范围"), draft.scope, [["scope", T("当前目录")], ["all", T("全部会话")]], (next) => setDraft((previous) => ({ ...previous, scope: next }))),
            selectRow(T("收藏"), draft.favorite, [["all", T("所有")], ["yes", T("已收藏")], ["no", T("未收藏")]], (next) => setDraft((previous) => ({ ...previous, favorite: next }))),
            selectRow(T("归档"), draft.archived, [["all", T("所有")], ["yes", T("已归档")], ["no", T("未归档")]], (next) => setDraft((previous) => ({ ...previous, archived: next }))),
            selectRow(T("待办"), draft.todo, [["all", T("所有")], ["yes", T("待办中")], ["no", T("非待办")]], (next) => setDraft((previous) => ({ ...previous, todo: next }))),
            h(
              "div",
              { className: "frow", style: { alignItems: "flex-start" } },
              h("label", { className: "flb" }, T("标签"), h("span", { className: "fsub" }, T("可多选"))),
              tags.length === 0
                ? h("div", { className: "se-set-note" }, T("标签库是空的"))
                : h(
                    "div",
                    { className: "ftags" },
                    tags.map((tag) =>
                      h(
                        "button",
                        {
                          type: "button",
                          key: tag,
                          className: "tagopt" + (draft.tags.includes(tag) ? " on" : ""),
                          onClick: () => toggleTag(tag),
                        },
                        draft.tags.includes(tag) ? h(Icon, { name: "check", size: 10 }) : null,
                        tag,
                      ),
                    ),
                  ),
            ),
          ),
          h(
            "div",
            { className: "ffoot" },
            h(
              "button",
              {
                type: "button",
                className: "act",
                title: T("把下面的选择恢复成默认（仍需点应用筛选生效）"),
                onClick: () => setDraft({ ...EMPTY_FILTER }),
              },
              T("重置"),
            ),
            h("span", { className: "spacer" }),
            active
              ? h(
                  "button",
                  { type: "button", className: "act", title: T("取消筛选，立即恢复完整列表"), onClick: onClear },
                  T("取消筛选"),
                )
              : null,
            h("button", { type: "button", className: "act primary", onClick: () => onApply(draft) }, T("应用筛选")),
          ),
        ),
      );
    }

    /**
     * 搜索范围 dialog.
     *
     * The search box lives in a 40px navbar beside the address bar, so the four
     * fields it can read are behind one funnel button rather than four chips
     * competing with the breadcrumbs. Nothing here takes effect before 应用, for
     * the same reason the 筛选 dialog works that way: a half-built range should
     * not silently change what the box already finds.
     *
     * 至少选择一项 is enforced rather than explained away: a search that reads no
     * field cannot match anything, and an empty list would read as a bug.
     *
     * 搜索位置 sits above the field list because it is the outer
     * question: *where* before *what*. 搜索索引设置 in the footer is the other
     * half of the same conversation — 会话内容 is the only field that costs a
     * build, so the place to manage that build belongs next to the switch that
     * turns it on, not three clicks away in the settings page.
     */
    function SearchScopeDialog({ open, value, onApply, onClose, onManage }) {
      const [draft, setDraft] = useState(value);
      useEffect(() => {
        if (open) setDraft(value);
      }, [open, value]);
      // Escape closes the dialog, like every other modal in DSH. Registered only
      // while it is open, so it cannot swallow the panel's own Escape handling.
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
      }, [open, onClose]);

      if (!open) return null;
      const rows = [
        ["name", T("会话名"), T("标题、工作区、路径")],
        ["tags", T("标签"), T("会话上的标签")],
        ["note", T("备注"), T("自己写的备注")],
        ["content", T("会话内容"), T("用户与助手的对话正文，需先建索引")],
      ];
      const toggle = (key) => setDraft((previous) => ({ ...previous, [key]: !previous[key] }));
      const anyOn = rows.some(([key]) => draft[key] === true);

      return h(
        "div",
        {
          className: "fmodal open",
          role: "dialog",
          "aria-label": T("搜索范围"),
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          "div",
          { className: "fdlg" },
          h(
            "div",
            { className: "fhead" },
            h("span", { className: "fic" }, h(Icon, { name: "filter", size: 13 })),
            h("span", { className: "ftitle" }, T("搜索范围")),
            h("span", { className: "spacer" }),
            h("button", { type: "button", className: "wbtn", title: T("关闭"), onClick: onClose }, h(Icon, { name: "x", size: 13 })),
          ),
          h(
            "div",
            { className: "fbody" },
            selectRow(T("搜索位置"), draft.place ?? "all", [
              ["all", T("所有位置")],
              ["here", T("当前目录")],
            ], (next) => setDraft((previous) => ({ ...previous, place: next }))),
            h(
              "div",
              { className: "frow", style: { alignItems: "flex-start" } },
              h("label", { className: "flb" }, T("搜索字段"), h("span", { className: "fsub" }, T("可多选"))),
              h(
                "div",
                { className: "ftags" },
                rows.map(([key, label, hint]) =>
                  h(
                    "button",
                    {
                      type: "button",
                      key,
                      className: "tagopt" + (draft[key] ? " on" : ""),
                      title: hint,
                      role: "checkbox",
                      "aria-checked": draft[key] === true,
                      onClick: () => toggle(key),
                    },
                    draft[key] ? h(Icon, { name: "check", size: 10 }) : null,
                    label,
                  ),
                ),
              ),
            ),
            h(
              "div",
              { className: "fsub" },
              anyOn
                ? T("会话内容会读取会话日志，第一次检索需要几秒建立索引，之后走缓存")
                : T("至少选择一项，否则搜索无法命中任何会话"),
            ),
          ),
          h(
            "div",
            { className: "ffoot" },
            h(
              "button",
              {
                type: "button",
                className: "act",
                title: T("恢复默认范围（仍需点应用生效）"),
                onClick: () => setDraft({ ...DEFAULT_SEARCH_SCOPES }),
              },
              T("重置"),
            ),
            onManage
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "act",
                    title: T("打开搜索索引设置，查看索引进度、重建或删除索引"),
                    onClick: onManage,
                  },
                  T("搜索索引设置"),
                )
              : null,
            h("span", { className: "spacer" }),
            h("button", { type: "button", className: "act", onClick: onClose }, T("取消")),
            h(
              "button",
              { type: "button", className: "act primary", disabled: !anyOn, onClick: () => onApply(draft) },
              T("应用"),
            ),
          ),
        ),
      );
    }

    /**
     * One tri-state filter row, as a segmented button group.
     *
     * It was a `<select>`: a native dropdown inside a modal that is itself
     * floating over the app reads as a second, unrelated window, and its
     * options were invisible until opened. Three short labels fit inline, and a
     * segmented control shows the current choice at a glance — which is the
     * whole job of a filter panel.
     */
    function selectRow(label, value, options, onChange) {
      return h(
        "div",
        { className: "frow" },
        h("label", { className: "flb" }, label),
        h(
          "div",
          { className: "fseg", role: "radiogroup", "aria-label": label },
          options.map(([optionValue, text]) =>
            h(
              "button",
              {
                key: optionValue,
                type: "button",
                role: "radio",
                "aria-checked": value === optionValue,
                className: value === optionValue ? "on" : "",
                onClick: () => onChange(optionValue),
              },
              text,
            ),
          ),
        ),
      );
    }

    /**
     * A small command menu anchored to a button.
     *
     * The prototype has a full context-menu component; the panel only needs one
     * menu (更多), so this is the smallest thing that behaves: it opens next to
     * the button, closes on outside click, Escape or after running an item, and
     * never leaves a listener behind.
     */
    function CommandMenu({ anchor, items, onClose }) {
      const ref = useRef(null);
      useEffect(() => {
        if (!anchor) return undefined;
        const onDown = (event) => {
          // A press on the trigger belongs to the trigger (it toggles the menu);
          // closing here as well would close and immediately re-open it.
          if (anchor.element && anchor.element.contains?.(event.target)) return;
          if (ref.current && !ref.current.contains(event.target)) onClose();
        };
        const onKey = (event) => {
          if (event.key === "Escape") onClose();
        };
        window.addEventListener("mousedown", onDown);
        window.addEventListener("keydown", onKey);
        return () => {
          window.removeEventListener("mousedown", onDown);
          window.removeEventListener("keydown", onKey);
        };
      }, [anchor, onClose]);
      if (!anchor) return null;
      // `top` wins when the caller is anchoring to a pointer (a context menu);
      // otherwise the menu hangs below the button that opened it.
      const top = Number.isFinite(anchor.top) ? anchor.top : (anchor.bottom ?? 0) + 4;
      const left = Math.max(6, Math.min(anchor.left ?? 0, (window.innerWidth || 1280) - 216));
      // 发送到 opens its flyout to the right (left:100%). A menu pinned against
      // the right edge would push that flyout off-screen, so the menu flips its
      // flyouts to the left instead (data-flip, matched in the stylesheet).
      const flip = left + 200 + 190 > (window.innerWidth || 1280) - 8;
      const style = {
        left,
        top: Math.max(6, Math.min(top, (window.innerHeight || 800) - 40 - items.length * 31)),
      };
      // Rendered where it is mounted (inside the shell), not portaled: the
      // popover needs the shell's --sm-* token scope to pick up the theme, and
      // `position: fixed` already lifts it out of the shell's own layout.
      // 发送到: an item may carry `sub`, an array of items of the same shape.
      // Those render as a hover flyout to the right (see .mi.has-sub in the
      // stylesheet). The parent row is a label, not a command — it has no run()
      // and its click deliberately does nothing, so hover is the only way in.
      const renderMenuItem = (item, key) => {
        if (item.sep) return h("div", { key, className: "misep" });
        const hasSub = Array.isArray(item.sub) && item.sub.length > 0;
        return h(
          "div",
          {
            key,
            className:
              "mi" +
              (item.danger ? " danger" : "") +
              (item.disabled ? " disabled" : "") +
              (hasSub ? " has-sub" : ""),
            "aria-disabled": item.disabled === true,
            "aria-haspopup": hasSub ? "true" : undefined,
            onClick: () => {
              // A parent only opens its flyout by hover: it must not run and
              // must not dismiss the menu it belongs to.
              if (hasSub) return;
              // A disabled item states why it cannot run instead of
              // closing on a no-op the user cannot explain.
              if (item.disabled) {
                if (typeof item.onDisabled === "function") {
                  onClose();
                  item.onDisabled();
                }
                return;
              }
              onClose();
              item.run();
            },
          },
          item.icon ? h("span", { className: "ic" }, h(Icon, { name: item.icon, size: 13 })) : null,
          h("span", null, item.label),
          hasSub
            ? h("span", { className: "k" }, h(Icon, { name: "chevright", size: 11, className: "ic" }))
            : item.key
              ? h("span", { className: "k" }, item.key)
              : null,
          hasSub
            ? h(
                "div",
                { className: "submenu" },
                item.sub.map((child, index) => renderMenuItem(child, key + "-" + index)),
              )
            : null,
        );
      };
      return h(
        "div",
        { className: "ctxmenu open", style, ref, "data-flip": flip ? "1" : undefined },
        items.map((item, index) => renderMenuItem(item, "mi-" + index)),
      );
    }

