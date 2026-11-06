    // ── Panel hook: dropping a container ───────────────────────────────────
    // The tree and the list both accept a dropped folder or workspace. What may
    // land where is decided by canDropInTree (module scope, shared with the tree
    // pane's own highlight); this hook is the write side: one node, a batch, and
    // the per-row legality filter.

    /** The drop targets: single, batch, the hover question, and the list drop. */
    function useDragAndDrop({ mutate, tree, setHint }) {      const moveNodeTo = useCallback(
        (nodeId, parentId) => {
          mutate(() => apiSend("POST", `/nodes/${encodeURIComponent(nodeId)}/move`, { parent: parentId }), T("已移动"));
        },
        [mutate],
      );

      /**
       * Move several containers under one parent.
       *
       * The host route takes a single id, so this is one request per node — but
       * one `mutate`, which means one refresh and one toast instead of N of
       * each. A one-item batch stays on `moveNodeTo` so the single-container
       * gesture keeps saying exactly what it always said.
       *
       * @param {string | string[]} nodeIds
       * @param {string} parentId
       */
      const moveNodesTo = useCallback(
        (nodeIds, parentId) => {
          const list = (Array.isArray(nodeIds) ? nodeIds : [nodeIds]).filter((id) => id && id !== parentId);
          if (list.length === 0) return;
          if (list.length === 1) {
            moveNodeTo(list[0], parentId);
            return;
          }
          const name = tree?.nodes?.[parentId]?.name ?? parentId;
          mutate(async () => {
            for (const id of list) {
              await apiSend("POST", `/nodes/${encodeURIComponent(id)}/move`, { parent: parentId });
            }
          }, T("已移动 {0} 个目录到「{1}」", [list.length, name]));
        },
        [moveNodeTo, mutate, tree],
      );

      /** May any container currently being dragged land on `targetId`? */
      const canDropHere = useCallback(
        (targetId) => {
          const sources = draggedNodeIds();
          if (sources.length === 0) return false;
          return sources.some((source) => canDropInTree(source, targetId, tree?.nodes ?? {}, tree?.children ?? {}));
        },
        [tree],
      );

      /** Drop a dragged container — or a whole check-set of them — onto another one (list surface). */
      const moveNodeHere = useCallback(
        (targetId, sourceIds) => {
          const list = (Array.isArray(sourceIds) ? sourceIds : [sourceIds]).filter((id) => id && id !== targetId);
          if (list.length === 0) return;
          // Each node is checked on its own: a folder carrying a workspace may
          // not land where a plain folder could, and one illegal member must not
          // cancel the move of the rest.
          const legal = list.filter((id) => canDropInTree(id, targetId, tree?.nodes ?? {}, tree?.children ?? {}));
          if (legal.length === 0) {
            setHint(T("这里放不下：工作区不能放进工作区，含工作区的文件夹也不能再放一个工作区"));
            return;
          }
          if (legal.length < list.length) {
            setHint(T("这里放不下：工作区不能放进工作区，含工作区的文件夹也不能再放一个工作区"));
          }
          moveNodesTo(legal, targetId);
        },
        [moveNodesTo, tree],
      );
      return { moveNodeTo, moveNodesTo, canDropHere, moveNodeHere };
    }
