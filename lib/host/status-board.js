/**
 * dsh-session-navigator — the last session states the DSH page announced.
 *
 * The rows only exist inside DSH's renderer: `uiSession.sessionStatus` is a live
 * service there, and the detached window runs a stub instead of it. So the page
 * announces a full snapshot whenever something changes and the Host fans it out
 * (see lib/host/bridge.js). Two gaps were left, and both are about *time* rather
 * than content:
 *
 *   - a snapshot is only worth something while it is the newest one. The command
 *     bus drops commands after MAX_AGE_MS, and the page sends nothing when the
 *     snapshot has not changed, so a window opened a minute later asked into an
 *     empty bus and drew no badges at all;
 *   - a page whose document sits in the background is throttled by the browser.
 *     Its announcement is *sent*, just late, and nothing on the other side can
 *     tell "late" from "never" — the badge simply stayed absent until the user
 *     clicked back into DSH and the page published again.
 *
 * Keeping the latest snapshot here closes both: `GET /bridge/status` hands the
 * window the last thing the page said, on a beat the window owns, so it never
 * waits for a push and never has to ask a backgrounded page. `status-request`
 * is that same answer on demand, which is what the window's ask gets.
 *
 * The board keeps no history. A snapshot replaces the previous one, because "the
 * state is no longer in the list" is exactly how a badge goes away.
 */

/**
 * Create the one-slot board.
 *
 * @param {{ now?: () => number }} [options] `now` is for tests; the timestamp is
 *   what lets a reader skip a snapshot it already applied.
 */
export function createStatusBoard(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  /** @type {Array<{ id: string, running: boolean, pending: string | null, completed: boolean }>} */
  let rows = [];
  let at = 0;

  return {
    /**
     * Record a snapshot. The caller has already normalised it (the route does,
     * through normalizeStatusRows); the board only remembers.
     *
     * @param {any} next
     * @returns {{ rows: Array<any>, at: number }}
     */
    set(next) {
      rows = Array.isArray(next) ? next : [];
      at = now();
      return { rows, at };
    },

    /** What was last announced, and when. `at` is 0 when nothing ever was. */
    snapshot() {
      return { rows, at };
    },

    /** When the last snapshot arrived; 0 while the board is empty. */
    get at() {
      return at;
    },

    /** Drop the snapshot (a data-directory migration, or a reset). */
    clear() {
      rows = [];
      at = 0;
    },
  };
}
