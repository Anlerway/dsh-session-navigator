      // ── how the panel is mounted ─────────────────────────────────────────
      // One surface: the 浮窗 card, centred over the optional scrim and sized by
      // the fixed/percent preset. 独立窗口 is a separate browser window, not
      // another way to paint this card, so there is nothing to branch on here.
      const modalFrame = frameSizeOf(settings?.shell?.modal ?? null);
      // The size always comes from settings. There is no maximise mode: a
      // full-screen panel with no visible way back is a trap.
      const shellStyle = {
        "--nav-width": `${navWidth}px`,
        "--detail-width": `${detailWidth}px`,
        width: modalFrame.width,
        height: modalFrame.height,
      };

      // The bin has its own vocabulary: everything that acts on a live session
      // (paste, cut, rename, tags, pin) is meaningless there, so the two bars
      // are told apart once, here, instead of at each button.
      const inTrash = scope === FIXED.trash;
      const shell = h(
          "div",
          {
            className: "se-shell",
            ref: shellRef,
            "data-bp": bp,
            "data-view": view,
            "data-detail": showDetail ? "on" : "off",
            "data-material": "auto",
            "data-size": modalSize,
            "data-sizing": sizing,
            style: shellStyle,
          },
          staleBuild
            ? h(
                "div",
                { className: "se-stale", role: "status" },
                h("span", null, T("面板已更新，当前显示的是旧版本")),
                h(
                  "button",
                  {
                    type: "button",
                    onClick: () => {
                      if (typeof location !== "undefined" && typeof location.reload === "function") location.reload();
                    },
                  },
                  T("重载面板"),
                ),
              )
            : null,
          // titlebar
          h(
            "div",
            { className: "titlebar" },
            h(
              "div",
              { className: "tabs", role: "tablist" },
              tabs.map((tab, index) =>
                h(
                  "div",
                  {
                    key: tab.id,
                    role: "tab",
                    "aria-selected": index === activeTab,
                    className: "tab" + (index === activeTab ? " active" : ""),
                    draggable: true,
                    title: titleOfScope(tab.scope) + (index === activeTab ? "" : T("（点按切换）")),
                    onClick: () => switchTab(index),
                    // Middle click closes a tab, as in every browser.
                    onAuxClick: (event) => {
                      if (event.button === 1) {
                        event.preventDefault();
                        closeTab(index);
                      }
                    },
                    onDragStart: (event) => {
                      event.dataTransfer.setData("text/plain", "tab:" + index);
                      event.dataTransfer.effectAllowed = "move";
                    },
                    onDragOver: (event) => {
                      if (!String(event.dataTransfer?.types ?? "").includes("text")) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    },
                    onDrop: (event) => {
                      event.preventDefault();
                      const raw = event.dataTransfer.getData("text/plain");
                      if (!raw.startsWith("tab:")) return;
                      moveTab(Number(raw.slice(4)), index);
                    },
                  },
                  h("span", { className: "t-ic" }, h(Icon, { name: iconOfScope(tab.scope), size: 13 })),
                  h("span", { className: "tname" }, titleOfScope(tab.scope)),
                  tabs.length > 1
                    ? h(
                        "span",
                        {
                          className: "x",
                          title: T("关闭标签页"),
                          onClick: (event) => {
                            event.stopPropagation();
                            closeTab(index);
                          },
                        },
                        h(Icon, { name: "x", size: 11 }),
                      )
                    : null,
                ),
              ),
              h("button", { type: "button", className: "tab-add", title: T("新建标签页（Ctrl+T）"), onClick: addTab }, h(Icon, { name: "plus", size: 13 })),
            ),
            h(
              "div",
              { className: "wbtns" },
              // Two window actions, and only two: 独立窗口 and close.
              // Minimum/maximum are omitted because a maximised panel has no
              // obvious way back. The panel's size is a setting, and the detached
              // window is the way to go bigger.
              //
              // 独立窗口 is absent *in* the window: there is nothing to detach
              // to, and the window's own titlebar already owns its frame.
              windowHost()
                ? null
                : h(
                    "button",
                    {
                      key: "detach",
                      type: "button",
                      className: "wbtn wide",
                      title: !componentReady
                        ? T("独立窗口需要先下载Electron 组件（设置 → 会话资源管理器）")
                        : detachedOpen
                          ? T("独立窗口已打开，点击聚焦（Ctrl+Shift+D）")
                          : T("在独立窗口中打开（Ctrl+Shift+D）"),
                      "aria-disabled": !componentReady,
                      onClick: openDetachedWindow,
                    },
                    h(Icon, { name: "external", size: 12 }),
                  ),
              h(
                "button",
                {
                  key: "close",
                  type: "button",
                  className: "wbtn close",
                  title: T("关闭"),
                  onClick: () => panelStore.set(false, "user"),
                },
                h(Icon, { name: "x", size: 13 }),
              ),
            ),
          ),
          // navbar
          h(
            "div",
            { className: "navbar" },
            h("button", { type: "button", className: "nbtn", title: T("后退"), disabled: cursor <= 0, onClick: goBack }, h(Icon, { name: "back" })),
            h("button", { type: "button", className: "nbtn", title: T("前进"), disabled: cursor >= history.length - 1, onClick: goForward }, h(Icon, { name: "fwd" })),
            h("button", { type: "button", className: "nbtn", title: T("上一级"), onClick: () => navigate(tree?.nodes?.[scope]?.parent ?? FIXED.root) }, h(Icon, { name: "up" })),
            h("button", { type: "button", className: "nbtn", title: T("重新扫描"), onClick: () => load(true) }, h(Icon, { name: "refresh" })),
            h(
              "div",
              { className: "crumbs" },
              crumbs.map((crumb, index) =>
                h(
                  React.Fragment,
                  { key: crumb.id },
                  index > 0 ? h("span", { className: "crumb-sep" }, h(Icon, { name: "chevright", size: 9 })) : null,
                  h("span", { className: "crumb" + (index === crumbs.length - 1 ? " cur" : ""), onClick: () => navigate(crumb.id) }, crumb.label),
                ),
              ),
            ),
            h(
              "label",
              { className: "search" },
              h(Icon, { name: "search", size: 13 }),
              h(SearchInput, {
                inputRef: searchRef,
                value: query,
                placeholder: scopePlaceholder,
                onCommit: setQuery,
              }),
            ),
            // 搜索范围. A sibling of the search label, not a child: a
            // button inside a <label> would focus the input on its way to the
            // click, and the point of this control is to leave the box alone.
            h(
              "button",
              {
                type: "button",
                className: "nbtn scopes" + (scopesNarrowed ? " on" : ""),
                title: T("搜索范围") + " · " + scopeSummary,
                "aria-label": T("搜索范围"),
                onClick: (event) => {
                  event.preventDefault();
                  setScopeOpen(true);
                },
              },
              h(Icon, { name: "filter", size: 13 }),
            ),
          ),
          // command bar — the write commands scroll, but the sort/view/details
          // cluster is pinned to the right edge so 详细信息 stays reachable at
          // any pane width (the prototype scrolls the whole bar and loses it).
          h(
            "div",
            { className: "cmdbar" },
            h(
              "div",
              { className: "cmdscroll" },
              // One 新建 entry with a menu: two adjacent buttons that both start
              // with "新建" made the bar read as one long verb. The menu names
              // both actions and leaves room for a third without another button.
              h(
                "button",
                {
                  type: "button",
                  className: "cmd" + (createOpen ? " on" : ""),
                  title: T("新建"),
                  onClick: (event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setCreateOpen((previous) =>
                      previous ? null : { element: event.currentTarget, left: rect.left, bottom: rect.bottom },
                    );
                  },
                },
                h("span", { className: "ic", "data-i": "plus" }, h(Icon, { name: "plus", size: 14 })),
                h("span", null, T("新建")),
                h("span", { className: "ic", "data-i": "chevdown" }, h(Icon, { name: "chevdown", size: 11 })),
              ),
              h("span", { className: "cmsep" }),
              // The file-manager cluster reads left to right in the order a
              // user works: take it (cut/copy), put it down (paste), then name
              // it and — only at the end — throw it away.
              //
              // The bin is the exception: a trashed session has no log to move,
              // rename, tag or pin, so those commands would be dead buttons.
              // Only 还原 / 永久删除 / 清空 make sense there, and they get a bar
              // of their own instead of a cluster of disabled ones.
              inTrash ? null : h(Btn, { className: "cmd", icon: "cut", iconOnly: true, title: T("剪切（Ctrl+X）"), disabled: targets.length === 0, onClick: () => cutOrCopy("cut") }),
              // 复制 is for sessions only: a container cannot be duplicated —
              // its children would have to be duplicated too, and the registry
              // has no notion of a copied workspace. 剪切 covers both.
              inTrash ? null : h(Btn, {
                className: "cmd",
                icon: "copy",
                iconOnly: true,
                title: T("复制会话（Ctrl+C）"),
                disabled: !targets.some((id) => sessionsById.has(id)),
                onClick: () => cutOrCopy("copy"),
              }),
              inTrash ? null : h(Btn, {
                className: "cmd" + (clipboard.ids.length > 0 || (clipboard.nodes?.length ?? 0) > 0 ? " on" : ""),
                icon: "paste",
                iconOnly: true,
                title: (() => {
                  if ((clipboard.nodes?.length ?? 0) > 0) {
                    return nodePasteTarget
                      ? T("粘贴 {0} 个目录到「{1}」（Ctrl+V）", [clipboard.nodes.length, nodePasteTarget.name])
                      : T("粘贴目录（先进入一个文件夹或根目录）");
                  }
                  return clipboard.ids.length > 0
                    ? T("粘贴 {0} 个会话到「{1}」（Ctrl+V）", [clipboard.ids.length, pasteTarget?.name ?? T("当前工作区")])
                    : T("粘贴（Ctrl+V）");
                })(),
                disabled:
                  (clipboard.nodes?.length ?? 0) > 0
                    ? !nodePasteTarget
                    : clipboard.ids.length === 0 || !pasteTarget,
                onClick: pasteClipboard,
              }),
              // 重命名 is a command, not a double click: a double click on a row
              // means "open", and overloading it made the first click select and
              // the second silently start editing.
              inTrash
                ? null
                : h(Btn, {
                    className: "cmd",
                    icon: "rename",
                    iconOnly: true,
                    onClick: renameCurrent,
                    // Grey unless exactly one session, folder or workspace is
                    // selected: there is no name to edit for anything else.
                    disabled: !renameTarget,
                    title: renameTarget ? T("重命名（F2）") : T("先选中一个会话、文件夹或工作区（F2）"),
                  }),
              // 删除 means "move to the bin" for a session and "delete the
              // folder" for a folder: the selected rows decide which. It comes
              // last in this cluster so it is never adjacent to 粘贴.
              inTrash
                ? h(Btn, { className: "cmd", icon: "restore", onClick: restoreSelection }, T("还原"))
                : h(Btn, { className: "cmd danger", icon: "trash", iconOnly: true, title: T("删除"), onClick: deleteSelection }),
              inTrash ? h(Btn, { className: "cmd danger", icon: "trash", onClick: emptyTrashNow }, T("清空回收站")) : null,
              inTrash ? null : h("span", { className: "cmsep" }),
              // flagMany, not toggleFlag: the bar acts on whatever is selected,
              // and a folder or workspace can only be collected by reference. The
              // session-only writer would post kind "session" for it — a row the
              // tree then refuses to draw.
              inTrash ? null : h(Btn, { className: "cmd", icon: "star", onClick: () => flagMany("favorite") }, T("收藏")),
              inTrash ? null : h(Btn, { className: "cmd", icon: "todo", onClick: () => flagMany("todo") }, T("待办")),
              inTrash ? null : h(Btn, { className: "cmd", icon: "pin", onClick: togglePinOrNode }, T("置顶")),
              inTrash ? null : h(Btn, { className: "cmd", icon: "archive", onClick: toggleArchive }, T("归档")),
              inTrash ? null : h(Btn, { className: "cmd", icon: "branch", title: T("分叉会话（从当前位置另起一支）"), onClick: forkSession }, T("分叉")),
              // One separator, and the only one: 分叉 closed the flags group and
              // 筛选 opens the last one. The pair here drew two hairlines four
              // pixels apart, which read as a glitch rather than a group break.
              h("span", { className: "cmsep" }),
              h(
                Btn,
                { className: "cmd" + (filterActive ? " on" : ""), icon: "tag", onClick: () => setFilterOpen(true) },
                T("筛选"),
              ),
            ),
            h(
              "div",
              { className: "cmdfixed" },
              // The fixed cluster is icon+label like the scrolling one; the
              // separator before it is a real border (see CSS), not an overlay,
              // so nothing is ever painted over these buttons.
              // 排序 is a menu, not a cycle: three fields and two directions are
              // six states, and a button that silently walked through them made
              // the user guess what the next click would do.
              h(
                "button",
                {
                  type: "button",
                  className: "cmd" + (sortOpen ? " on" : ""),
                  title: T("排序方式"),
                  onClick: (event) => {
                    const element = event.currentTarget;
                    const rect = element.getBoundingClientRect();
                    setSortOpen((previous) =>
                      previous ? null : { element, left: rect.left, bottom: rect.bottom },
                    );
                  },
                },
                h("span", { className: "ic", "data-i": "sort" }, h(Icon, { name: "sort", size: 14 })),
                h("span", null, T("排序")),
                h("span", { className: "ic", "data-i": "chevdown" }, h(Icon, { name: "chevdown", size: 11 })),
              ),
              h(Btn, {
                className: "cmd",
                icon: "grid",
                title: T("切换视图（详细信息 / 列表 / 图标）"),
                onClick: () => setView((previous) => (previous === "details" ? "icons" : "details")),
              }, T("查看")),
              h(Btn, { className: "cmd", icon: "more", iconOnly: true, title: T("更多"), onClick: moreMenu }),
              h("span", { className: "cmsep" }),
              h(Btn, { className: "cmd" + (showDetail ? " on" : ""), icon: "details", onClick: () => setShowDetail((previous) => !previous) }, T("详细信息")),
            ),
          ),
          // body
          h("div", { className: "body" }, body()),
          // status bar
          h(
            "div",
            { className: "status" },
            h("div", { className: "s-item" }, T("{0} 个项目", [formatCount(filteredInScope.length)])),
            // 会话内容 builds on first use; saying so is the difference between a
            // list that grows for a reason and one that looks like it is guessing.
            contentPending
              ? h(
                  "div",
                  { className: "s-item on" },
                  T("正在索引会话内容 {0}/{1}", [formatCount(contentState.indexed), formatCount(contentState.total)]),
                )
              : null,
            searchScopes.content && contentState?.error
              ? h("div", { className: "s-item s-error" }, T("会话内容检索不可用"))
              : null,
            // One line while the queue runs, and a click to stop it: a batch of
            // fifty sessions can take minutes and the menu is long gone by then.
            summarizing
              ? h(
                  "div",
                  {
                    className: "s-item clickable on",
                    title: T("点击停止总结"),
                    onClick: () => {
                      summaryStore.cancel().catch((failure) => setErrorText(String(failure?.message ?? failure)));
                    },
                  },
                  summaryState.state?.current?.title
                    ? T("{0} · {1}", [summaryProgress, summaryState.state.current.title])
                    : summaryProgress,
                )
              : null,
            filterActive
              ? h(
                  "div",
                  {
                    className: "s-item clickable on",
                    title: T("清除筛选"),
                    onClick: () => setFilter({ ...EMPTY_FILTER }),
                  },
                  T("筛选中 · 点击清除"),
                )
              : null,
            filterActive && filter.scope === "all"
              ? h("div", { className: "s-item" }, T("全部会话范围"))
              : null,
            archivedInScope > 0 ? h("div", { className: "s-item" }, T("{0} 个已归档", [formatCount(archivedInScope)])) : null,
            h("div", { className: "s-item" }, checked.size > 0 ? T("已选 {0} 项", [formatCount(checked.size)]) : T("未选择")),
            h("div", { className: "s-item" }, T("共 {0}", [formatSize(totalSize) || "0 B"])),
            errorText
              ? h(
                  "div",
                  {
                    className: "s-item s-error clickable on",
                    title: T("点击关闭"),
                    onClick: () => setErrorText(""),
                  },
                  errorText,
                )
              : null,
            hint ? h("div", { className: "s-item clickable on" }, hint) : null,
            h(
              "div",
              { className: "viewswitch" },
              h("button", { type: "button", className: "vsw" + (view === "details" ? " on" : ""), title: T("详细信息"), onClick: () => setView("details") }, h(Icon, { name: "details", size: 13 })),
              h("button", { type: "button", className: "vsw" + (view === "icons" ? " on" : ""), title: T("图标"), onClick: () => setView("icons") }, h(Icon, { name: "grid", size: 13 })),
            ),
          ),
          // Popovers live *inside* the shell so the --sm-* token bridge and
          // the theme apply to them; the CSS positioning is viewport-fixed,
          // so being a descendant costs nothing.
          h(CommandMenu, { anchor: more, items: moreItems, onClose: () => setMore(null) }),
          h(CommandMenu, { anchor: sortOpen, items: sortItems, onClose: () => setSortOpen(null) }),
          h(CommandMenu, { anchor: createOpen, items: createItems, onClose: () => setCreateOpen(null) }),
          h(CommandMenu, {
            anchor: contextMenu,
            items: contextMenu?.items ?? [],
            onClose: () => setContextMenu(null),
          }),
          // The dialog host is not here: it is mounted with the sidebar entry
          // (DialogChannel), so a dialog asked for from DSH's own row menu
          // survives that menu closing. The panel still renders the filter
          // dialog and its menus inside the shell, to inherit its token scope.
          h(FilterDialog, {
            open: filterOpen,
            value: filter,
            library: data?.tagLibrary ?? EMPTY_LIST,
            active: filterActive,
            onApply: (next) => {
              setFilter(next);
              setFilterOpen(false);
              setHint(T("已应用筛选"));
            },
            // 取消筛选 drops the filter that is in effect and closes in one step:
            // the alternative — read the dialog, work out that everything is
            // already unchecked, press 应用筛选 — is a second errand for the user.
            onClear: () => {
              setFilter({ ...EMPTY_FILTER });
              setFilterOpen(false);
              setHint(T("已取消筛选"));
            },
            onClose: () => setFilterOpen(false),
          }),
          h(SearchScopeDialog, {
            open: scopeOpen,
            value: searchScopes,
            onApply: (next) => {
              setSearchScopes(normalizeSearchScopes(next));
              setScopeOpen(false);
              setHint(T("已应用搜索范围"));
            },
            onClose: () => setScopeOpen(false),
            // 搜索索引设置: close first, then go. Leaving the dialog open
            // under a page that is about to unmount would strand it there on the
            // way back.
            onManage: () => {
              setScopeOpen(false);
              openSettingsPage();
            },
          }),
      );

      // One surface: the scrim (invisible at the default dim=0) behind the card.
      return portalFragment([scrim, shell]);
    }

    /**
     * Keeps a failed panel from taking the sidebar entry down with it.
     *
     * A plugin slot is one React subtree: if `Panel` throws during render (a
     * host shape we did not anticipate), React unmounts the nearest boundary —
     * and without one that is the whole slot, so the sidebar button itself
     * disappears. That is exactly the "点了入口，闪退之后入口也没了" report: the
     * crash and the missing entry are the same event.
     *
     * The boundary catches the error, drops back to the closed state and shows a
     * readable message, so the entry survives and can be clicked again.
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        // Do NOT close the store here: closing unmounts the boundary together
        // with the panel, so the message flashes and the user is left with a
        // button that seems to do nothing. The card stays until 重试 or 关闭.
        try {
          console.error("[session-navigator] panel render failed", error);
        } catch {
          /* logging must never mask the original error */
        }
      }

      render() {
        if (this.state.error) {
          // Portaled like the panel: the sidebar clips its own subtree, and a
          // fixed element inside a transformed ancestor is clipped too.
          return portalFragment([h(
            "div",
            { className: "se-crash", role: "alert" },
            h("div", { className: "t" }, T("面板渲染失败")),
            h("div", { className: "s" }, String(this.state.error?.message ?? this.state.error)),
            h(
              "div",
              { className: "row-btns" },
              h(
                "button",
                {
                  type: "button",
                  className: "act",
                  onClick: () => this.setState({ error: null }),
                },
                T("重试"),
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "act",
                  onClick: () => panelStore.set(false, "user"),
                },
                T("关闭"),
              ),
            ),
          )]);
        }
        return this.props.children;
      }
    }

    // ── Sidebar footer entry ───────────────────────────────────────────────
    function FooterAction(props) {
      const t = typeof props.t === "function" ? props.t : identityT;
      const open = useSyncExternalStore(
        panelStore.subscribe,
        panelStore.getSnapshot,
        panelStore.getSnapshot,
      );
      const wide = props.wide !== false;
      return h(React.Fragment, null,
        h("button", {
          type: "button",
          className: "se-footerBtn" + (wide ? "" : " se-footerBtn-rail"),
          title: wide ? undefined : t("footerLabel"),
          "aria-label": t("footerLabel"),
          "aria-expanded": open,
          // 默认打开方式 decides where a *launch* lands — the same setting the
          // 更多 menu would honour — but the button still takes back what it
          // opened: one control must not leave two windows in front of the user
          // with no obvious way to tell which one is live.
          onClick: () => {
            if (open) {
              panelStore.set(false, "user");
              return;
            }
            void launchExplorer();
          },
        },
          h("svg", {
            viewBox: "0 0 16 16",
            width: wide ? 14 : 18,
            height: wide ? 14 : 18,
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.4,
            "aria-hidden": "true",
            style: { flex: "0 0 auto", display: "block" },
          },
            // The plugin's own mark: a folder, because the explorer is a
            // folder-shaped place. Three rules read as a generic "menu" and
            // were indistinguishable from DSH's own list controls.
            h("path", { d: "M2 4.4h4l1.2 1.6H14V13H2z", strokeLinejoin: "round" }),
          ),
          wide ? h("span", { className: "se-footerBtn-label" }, t("footerLabel")) : null,
        ),
        open ? h(PanelBoundary, null, h(Panel, { t })) : null,
        // 更新说明: mounted with the entry, so an announcement lands when
        // DSH starts rather than waiting for the panel to be opened. It portals
        // to the page root: the sidebar clips its own subtree.
        h(NotesGate, { t }),
        // Always mounted, so 取消/删除 asked for from DSH's own row menu lands
        // on a host that outlives the menu that asked.
        h(DialogChannel),
      );
    }

