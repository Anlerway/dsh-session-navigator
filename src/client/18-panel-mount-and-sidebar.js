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
                      // Not disabled when the component is missing: the click
                      // opens the installer, which is the useful answer.
                      title: !componentReady
                        ? T("打开独立窗口（需要先下载 Electron 组件）")
                        : detachedOpen
                          ? T("独立窗口已打开，点击聚焦（Ctrl+Shift+D）")
                          : T("在独立窗口中打开（Ctrl+Shift+D）"),
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
              // The bar is the one caller that means "the selection"; passing the
              // click event itself would be an accident waiting to be a target.
              inTrash
                ? h(Btn, { className: "cmd", icon: "restore", onClick: () => restoreSelection() }, T("还原"))
                : h(Btn, { className: "cmd danger", icon: "trash", iconOnly: true, title: T("删除"), onClick: () => deleteSelection() }),
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
              inTrash ? null : h(Btn, { className: "cmd", icon: "branch", title: T("分叉会话"), onClick: forkSession }, T("分叉")),
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
              { className: "status-right" },
              // 总结 runs on the host and outlives the menu that started it, so the
              // bar rides just left of the view switch: the corner that is always
              // on screen, and next to the controls rather than past them. The
              // component subscribes by itself — a running batch repaints this bar
              // and nothing else in the panel.
              h(SummaryRunProgress, { onError: setErrorText }),
              h(
                "div",
                { className: "viewswitch" },
                h("button", { type: "button", className: "vsw" + (view === "details" ? " on" : ""), title: T("详细信息"), onClick: () => setView("details") }, h(Icon, { name: "details", size: 13 })),
                h("button", { type: "button", className: "vsw" + (view === "icons" ? " on" : ""), title: T("图标"), onClick: () => setView("icons") }, h(Icon, { name: "grid", size: 13 })),
              ),
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

    // ── Sidebar footer entry + 悬浮球 ──────────────────────────────────────
    /**
     * The plugin's own mark: a folder, because the explorer is a folder-shaped
     * place. Three rules read as a generic "menu" and were indistinguishable
     * from DSH's own list controls.
     */
    function entryGlyph(size) {
      return h("svg", {
        viewBox: "0 0 16 16",
        width: size,
        height: size,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.4,
        "aria-hidden": "true",
        style: { flex: "0 0 auto", display: "block" },
      },
        h("path", { d: "M2 4.4h4l1.2 1.6H14V13H2z", strokeLinejoin: "round" }),
      );
    }

    /**
     * The face of the floating ball. Names are file stems, and the route table
     * serves exactly these five; normalising here means a stale store value can
     * never turn into a 404 image in the corner.
     */
    function ballArt(style) {
      const face = BALL_STYLES.includes(style) ? style : "folder";
      return API + "/ui/ball-" + face + ".png";
    }

    // ── 悬浮球的位置 ────────────────────────────────────────────────────────
    // The ball is a real ball: it can be thrown anywhere in the window. Where it
    // lands is view state, not a preference — it belongs to this browser, so it
    // lives in localStorage instead of the settings document (a second window
    // must not inherit a spot that only makes sense on this screen).
    const BALL_SIZE = 64;
    const BALL_GAP = 8;
    const BALL_SPOT_KEY = "session-navigator.ball-spot";
    // The feel follows dsh-pet 0.3.8 (src/shared/physics.ts): gravity pulls the
    // ball down, walls keep 78% of its speed, and only the floor rubs off
    // horizontal motion. There is no air drag — the old 4.2/s exponential bleed
    // was what made a throw feel like it was pushing through treacle. State is
    // in the browser's own units, pixels and milliseconds.
    const BALL_GRAVITY = 0.0014;          // px/ms² (dsh-pet 1400 px/s²)
    const BALL_RESTITUTION = 0.78;        // dsh-pet RESTITUTION
    const BALL_GROUND_FRICTION = 0.0025;  // per ms (dsh-pet 2.5/s)
    const BALL_REST_VY = 0.04;            // px/ms (dsh-pet 40 px/s)
    const BALL_REST_VX = 0.015;           // px/ms (dsh-pet 15 px/s)
    const BALL_MAX_STEP = 50;             // ms (dsh-pet MAX_STEP_DT)
    // A release is measured over the last 150ms, never from one pointermove; a
    // pause before letting go is a placement, and a slow drag does not throw.
    const BALL_VELOCITY_WINDOW = 150;     // ms (dsh-pet RELEASE_WINDOW_MS)
    const BALL_VELOCITY_SPAN = 20;        // ms (dsh-pet MIN_SPAN_MS)
    const BALL_SEGMENT_MIN = 8;           // ms (dsh-pet SEG_MIN_DT_MS)
    const BALL_PEAK_WEIGHT = 0.5;         // dsh-pet PEAK_WEIGHT
    const BALL_ACCEL_REF = 8000;          // px/s² (dsh-pet ACCEL_REF)
    const BALL_ACCEL_GAIN = 0.6;          // dsh-pet ACCEL_GAIN_MAX
    const BALL_THROW_MIN = 500;           // px/s (dsh-pet DEAD_ZONE_SPEED)
    const BALL_MAX_SPEED = 3600;          // px/s (dsh-pet MAX_THROW_SPEED)
    let ballSpot = readBallSpot();
    let ballThrown = false;
    let ballCaught = false;
    let glideFrame = 0;
    let glideStop = null;

    function viewportSize() {
      if (typeof window === "undefined") return { width: 0, height: 0 };
      return { width: window.innerWidth || 0, height: window.innerHeight || 0 };
    }

    /**
     * Keep the whole ball on screen. A viewport of zero means there is no layout
     * to clamp against (unit tests, SSR), so the raw spot is returned unchanged.
     */
    function clampBall(left, top, width, height) {
      if (!(width > 0) || !(height > 0)) return { left, top };
      return {
        left: Math.min(Math.max(BALL_GAP, left), Math.max(BALL_GAP, width - BALL_SIZE - BALL_GAP)),
        top: Math.min(Math.max(BALL_GAP, top), Math.max(BALL_GAP, height - BALL_SIZE - BALL_GAP)),
      };
    }

    /**
     * The speed of the gesture, not of the last pointermove. A fast drag often
     * ends with a one-pixel correction; reading only the last segment would
     * throw that away and make the ball feel dead. The window, the peak weight
     * and the acceleration gain are dsh-pet's, so a brisk flick carries the
     * same springy weight as its pet. A pause before release leaves one sample
     * in the window and therefore no throw at all.
     */
    function throwVelocity(samples, now) {
      const recent = samples.filter((sample) => sample.at >= now - BALL_VELOCITY_WINDOW);
      if (recent.length < 2) return { vx: 0, vy: 0 };
      const first = recent[0];
      const last = recent[recent.length - 1];
      const span = Math.max(BALL_VELOCITY_SPAN, last.at - first.at);
      const baseVx = ((last.x - first.x) / span) * 1000;
      const baseVy = ((last.y - first.y) / span) * 1000;
      const baseSpeed = Math.hypot(baseVx, baseVy);
      if (baseSpeed < 1e-6) return { vx: 0, vy: 0 };
      // Segment speeds catch a flick whose displacement is concentrated in a
      // short slice of the window; the last segment's acceleration adds up to
      // 60% to a throw that was still speeding up when the finger lifted.
      const segments = [];
      let px = first.x;
      let py = first.y;
      let pt = first.at;
      for (const sample of recent.slice(1)) {
        const dt = sample.at - pt;
        if (dt < BALL_SEGMENT_MIN) continue;
        segments.push({ speed: (Math.hypot(sample.x - px, sample.y - py) / dt) * 1000, at: sample.at });
        px = sample.x;
        py = sample.y;
        pt = sample.at;
      }
      const peakSpeed = segments.length ? Math.max(...segments.map((segment) => segment.speed)) : baseSpeed;
      let accel = 0;
      if (segments.length >= 2) {
        const firstSegment = segments[0];
        const lastSegment = segments[segments.length - 1];
        accel = (lastSegment.speed - firstSegment.speed) / Math.max((lastSegment.at - firstSegment.at) / 1000, BALL_VELOCITY_SPAN / 1000);
      }
      const gain = 1 + Math.min(Math.max(accel, 0) / BALL_ACCEL_REF, 1) * BALL_ACCEL_GAIN;
      const beforeClamp = ((1 - BALL_PEAK_WEIGHT) * baseSpeed + BALL_PEAK_WEIGHT * peakSpeed) * gain;
      const speed = softClampSpeed(beforeClamp);
      if (speed < BALL_THROW_MIN) return { vx: 0, vy: 0 };
      return { vx: (baseVx / baseSpeed) * speed / 1000, vy: (baseVy / baseSpeed) * speed / 1000 };
    }

    /** dsh-pet's soft ceiling: every speed stays distinct, none reaches the cap. */
    function softClampSpeed(speed) {
      if (!(speed > 0)) return 0;
      return BALL_MAX_SPEED * (1 - Math.exp(-speed / BALL_MAX_SPEED));
    }

    /**
     * One tick of the thrown ball: gravity, move, then the four edges. Pure so
     * the tests can throw it without a DOM, a timer or a frame. `bounced` is
     * true for a real impact worth squashing; `atRest` says the ball is on the
     * floor and slow enough that the frame loop can stop.
     */
    function ballStep(state, dt, view) {
      const step = Math.min(Math.max(dt, 0), BALL_MAX_STEP);
      let vx = state.vx;
      let vy = state.vy + BALL_GRAVITY * step;
      let left = state.left + vx * step;
      let top = state.top + vy * step;
      const maxLeft = Math.max(BALL_GAP, view.width - BALL_SIZE - BALL_GAP);
      const maxTop = Math.max(BALL_GAP, view.height - BALL_SIZE - BALL_GAP);
      let bounced = false;
      if (left < BALL_GAP) {
        left = BALL_GAP;
        bounced = Math.abs(vx) > 0.12;
        vx = Math.abs(vx) * BALL_RESTITUTION;
      } else if (left > maxLeft) {
        left = maxLeft;
        bounced = Math.abs(vx) > 0.12;
        vx = -Math.abs(vx) * BALL_RESTITUTION;
      }
      if (top < BALL_GAP) {
        top = BALL_GAP;
        bounced = bounced || Math.abs(vy) > 0.12;
        vy = Math.abs(vy) * BALL_RESTITUTION;
      } else if (top >= maxTop) {
        top = maxTop;
        const impact = Math.abs(vy);
        // Only the floor rubs: a ball skidding along it slows, then stops.
        vx *= Math.max(0, 1 - BALL_GROUND_FRICTION * step);
        if (impact < BALL_REST_VY) vy = 0;
        else vy = -impact * BALL_RESTITUTION;
        bounced = bounced || impact > 0.12;
      }
      const speed = Math.hypot(vx, vy);
      const atRest =
        (top >= maxTop - 1 && Math.abs(vy) < 0.001 && Math.abs(vx) < BALL_REST_VX)
        || (bounced && speed < BALL_REST_VY && Math.abs(vy) < 0.001);
      return { left, top, vx, vy, bounced, atRest };
    }

    function readBallSpot() {
      try {
        const raw = globalThis.localStorage?.getItem(BALL_SPOT_KEY);
        if (!raw) return null;
        const spot = JSON.parse(raw);
        if (!Number.isFinite(spot?.left) || !Number.isFinite(spot?.top)) return null;
        const view = viewportSize();
        return clampBall(spot.left, spot.top, view.width, view.height);
      } catch {
        return null;
      }
    }

    function saveBallSpot(spot) {
      try {
        globalThis.localStorage?.setItem(BALL_SPOT_KEY, JSON.stringify(spot));
      } catch {
        // Forgetting where the ball was is cheaper than breaking the click;
        // storage can be full or switched off entirely.
      }
    }

    function ballStyle() {
      // The layer is click-through on purpose; this is the opt-in that makes
      // the ball itself hittable even if the stylesheet loads late.
      const base = { pointerEvents: "auto" };
      if (!ballSpot) return base;
      // A window that shrank after the throw would otherwise leave the ball
      // outside the viewport; the render path re-clamps for free.
      const view = viewportSize();
      ballSpot = clampBall(ballSpot.left, ballSpot.top, view.width, view.height);
      return {
        ...base,
        left: ballSpot.left + "px",
        top: ballSpot.top + "px",
        right: "auto",
        bottom: "auto",
      };
    }

    /**
     * Stop a ball that is still flying. Returns whether there was anything to
     * stop, so a press on a moving ball can be read as catching it rather than
     * as a click that opens the panel.
     */
    function stopGlide(persist, node) {
      if (!glideFrame && !glideStop) return false;
      if (glideFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(glideFrame);
      glideFrame = 0;
      glideStop = null;
      if (node?.style) node.style.transform = "";
      if (persist && ballSpot) saveBallSpot(ballSpot);
      return true;
    }

    /**
     * Throw: keep moving after the pointer lets go, then let gravity pull the
     * ball down, bounce it off the edges with restitution, rub speed off along
     * the floor, and squash a little on impact. The spot is saved at release and
     * again when the ball settles, so a reload mid-flight puts it back on screen
     * instead of leaving it in the air.
     */
    function glideBall(node, vx, vy) {
      // A throw is the control's own feedback, not decoration: reduced motion
      // still gets the flight, only the squash below is optional. Zero speed is
      // a placement, not a throw: leave the ball hovering and start no frames.
      if (!(Math.hypot(vx, vy) >= BALL_THROW_MIN / 1000)) return;
      if (!ballSpot || typeof requestAnimationFrame !== "function") return;
      const view = viewportSize();
      if (!(view.width > 0) || !(view.height > 0)) return;
      let state = { left: ballSpot.left, top: ballSpot.top, vx, vy };
      let last = performance.now();
      const write = () => {
        ballSpot = { left: Math.round(state.left), top: Math.round(state.top) };
        if (node.style) {
          node.style.left = ballSpot.left + "px";
          node.style.top = ballSpot.top + "px";
          node.style.right = "auto";
          node.style.bottom = "auto";
        }
      };
      const squash = (sx) => {
        if (typeof node.animate !== "function") return;
        if (typeof globalThis.matchMedia === "function"
          && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        node.animate(
          [{ transform: "scale(" + sx + "," + (2 - sx).toFixed(2) + ")" }, { transform: "scale(1)" }],
          { duration: 180, easing: "ease-out" },
        );
      };
      const settle = () => {
        glideFrame = 0;
        glideStop = null;
        write();
        saveBallSpot(ballSpot);
        if (node.style) node.style.transform = "";
        squash(1.06);
      };
      const step = (now) => {
        // The setting can change while the ball is in the air; a switch that
        // says "no physics" must stop the flight, not wait for it to land.
        if (!entryPhysics.on) { stopGlide(true, node); return; }
        const dt = Math.min(BALL_MAX_STEP, Math.max(0, now - last));
        last = now;
        const next = ballStep(state, dt, view);
        state = { left: next.left, top: next.top, vx: next.vx, vy: next.vy };
        write();
        if (next.bounced) squash(1.1);
        if (next.atRest) { settle(); return; }
        glideFrame = requestAnimationFrame(step);
      };
      glideStop = settle;
      glideFrame = requestAnimationFrame(step);
    }

    /**
     * Drag, in one piece of geometry: pointerdown remembers the corner, pointermove
     * turns the delta into a clamped left/top, pointerup writes it down. A press
     * that travelled less than 4px is still a click — that threshold is what lets
     * one button both open the panel and be thrown across the window.
     */
    function dragBall(event) {
      if (event.button !== 0) return;
      const node = event.currentTarget;
      if (!node || typeof node.addEventListener !== "function") return;
      // A flying ball stops under the finger; the click that trails this press
      // belongs to the catch, not to opening the panel.
      if (stopGlide(true, node)) ballCaught = true;
      const rect = node.getBoundingClientRect?.() ?? { left: 0, top: 0 };
      const startX = event.clientX;
      const startY = event.clientY;
      let moved = false;
      const samples = [{ x: startX, y: startY, at: performance.now() }];

      const onMove = (move) => {
        const dx = move.clientX - startX;
        const dy = move.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        samples.push({ x: move.clientX, y: move.clientY, at: performance.now() });
        if (samples.length > 16) samples.shift();
        if (node.classList) node.classList.add("dragging");
        const view = viewportSize();
        ballSpot = clampBall(rect.left + dx, rect.top + dy, view.width, view.height);
        if (node.style) {
          node.style.left = ballSpot.left + "px";
          node.style.top = ballSpot.top + "px";
          node.style.right = "auto";
          node.style.bottom = "auto";
        }
      };

      const finish = () => {
        node.removeEventListener("pointermove", onMove);
        node.removeEventListener("pointerup", finish);
        node.removeEventListener("pointercancel", finish);
        if (node.classList) node.classList.remove("dragging");
        if (moved) {
          ballThrown = true;
          ballCaught = false;
          // Remember where the hand let go even if the ball keeps flying: a
          // reload in mid-air should not resurrect the previous window's spot.
          saveBallSpot(ballSpot);
          if (entryPhysics.on) {
            const { vx, vy } = throwVelocity(samples, performance.now());
            // A placement is not a throw. Below the threshold the ball simply
            // hovers where the hand left it; only real speed starts physics.
            if (vx || vy) glideBall(node, vx, vy);
          }
          // The click that follows this pointerup belongs to the throw. Clear the
          // flag afterwards so the next press is a plain click again.
          setTimeout(() => { ballThrown = false; }, 0);
        }
      };

      node.addEventListener("pointermove", onMove);
      node.addEventListener("pointerup", finish);
      node.addEventListener("pointercancel", finish);
      // No preventDefault here: cancelling pointerdown can swallow the click
      // that a throw-less press still owes the button. touch-action:none and
      // user-select:none already keep the gesture from scrolling or selecting.
      node.setPointerCapture?.(event.pointerId);
    }


    // A resize does not necessarily re-render the footer, so the mounted ball is
    // moved by hand. The listener reads ballSpot, never the DOM, to find out
    // whether the user has dragged at all.
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("resize", () => {
        if (!ballSpot) return;
        const node = globalThis.document?.querySelector?.(".se-ball");
        stopGlide(false, node);
        const view = viewportSize();
        ballSpot = clampBall(ballSpot.left, ballSpot.top, view.width, view.height);
        if (node?.style) {
          node.style.left = ballSpot.left + "px";
          node.style.top = ballSpot.top + "px";
        }
      });
    }

    function FooterAction(props) {
      const t = typeof props.t === "function" ? props.t : identityT;
      const open = useSyncExternalStore(
        panelStore.subscribe,
        panelStore.getSnapshot,
        panelStore.getSnapshot,
      );
      const entry = useSyncExternalStore(
        entryMode.subscribe,
        entryMode.snapshot,
        entryMode.snapshot,
      );
      const physics = useSyncExternalStore(
        entryPhysics.subscribe,
        entryPhysics.snapshot,
        entryPhysics.snapshot,
      );
      const art = useSyncExternalStore(
        entryStyle.subscribe,
        entryStyle.snapshot,
        entryStyle.snapshot,
      );
      // 入口位置 is read once, on the first mount: the footer is the first
      // surface DSH draws, and the store's default (左下角) is only a guess
      // until the host answers. Later changes arrive through the settings page,
      // which writes the same store — so this is not polled.
      useEffect(() => {
        void refreshEntryMode();
      }, []);
      const wide = props.wide !== false;
      // The ball stays on top while the panel is open: it is the one control that
      // must never be buried, so it is also allowed to close what it opened.
      const showButton = entry !== "ball";
      // The detached window is the panel already; a second floating entry there
      // has nothing to open, and it would sit on top of the window it belongs to.
      const showBall = entry !== "sidebar" && !windowHost();
      // 物理效果 off, or the ball hidden by another entry mode, has to stop a
      // flight already in progress. A ball that is merely sitting in the air
      // stays there: placement and throwing are different gestures.
      useEffect(() => {
        const node = globalThis.document?.querySelector?.(".se-ball") ?? null;
        if (!physics || !showBall) stopGlide(true, node);
      }, [physics, showBall]);
      return h(React.Fragment, null,
        showButton
          ? h("button", {
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
            entryGlyph(wide ? 14 : 18),
            wide ? h("span", { className: "se-footerBtn-label" }, t("footerLabel")) : null,
          )
          : null,
        showBall
          ? portalBall(
              h("button", {
                type: "button",
                className: "se-ball",
                style: ballStyle(),
                "data-style": art,
                title: t("footerLabel"),
                "aria-label": t("footerLabel"),
                "aria-expanded": open,
                onPointerDown: dragBall,
                onClick: () => {
                  // Catching a flying ball and landing a throw are both
                  // gestures, not presses: neither may open the panel.
                  if (ballCaught) {
                    ballCaught = false;
                    return;
                  }
                  if (ballThrown) {
                    ballThrown = false;
                    return;
                  }
                  if (open) {
                    panelStore.set(false, "user");
                    return;
                  }
                  void launchExplorer();
                },
              },
              h("img", {
                className: "se-ball-face",
                src: ballArt(art),
                alt: "",
                "aria-hidden": "true",
                draggable: false,
              }),
              ),
            )
          : null,
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

