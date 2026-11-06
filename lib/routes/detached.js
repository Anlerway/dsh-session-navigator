// 路由组 detached（1 条）

export const detachedRoutes = {


  /** Close the detached window. */
  "POST /detached/close": async (api) => {
    // `close()` answers "is no window running now", which is true for a click on
    // a window that was already gone; the caller asked whether it closed
    // something, so both facts travel.
    const wasOpen = api.detached.running === true;
    return { closed: await api.detached.close(), wasOpen };
  },
};
