// dispatch-support：从 lib/index.js 原样切出
import { codedError } from "../store/sidecar.js";

/**
 * Writes that no *other* document needs to hear about.
 *
 * A write is news for the panel and the detached window — they draw the same
 * tree, tags, notes and settings from one bootstrap payload and cannot see each
 * other's requests. These prefixes are the exceptions: the bus itself (a
 * command's own refresh would echo), the component downloader and the indexer
 * and the summariser (all three are polled while they run), the migration (the
 * page reloads on its own) and the routes that only report state.
 */
export const QUIET_WRITE_PREFIXES = [
  "/bridge/",
  "/component/",
  "/detached/",
  "/datadir/",
  "/search/",
  "/summarize",
  "/cache/",
  "/theme",
  "/update",
  "/about/",
  "/release-notes",
];

/**
 * Tell the other document that a write landed.
 *
 * The document that made the request reloads on its own. The *other* one — a
 * detached window in its own process, or the panel behind a window — has no way
 * to see a fetch it did not make, and a BroadcastChannel cannot leave the
 * process. One event on the Host's bus is what both of them can hear.
 *
 * Sent after the response, and never on a read: a broadcast per keystroke is
 * cheaper than a stale tree, but a broadcast per GET is just noise.
 *
 * @param {object} api
 * @param {string} path the matched route, not the raw URL
 * @param {string} method
 * @returns {boolean} whether anything was published
 */
export function announceWrite(api, path, method) {
  if (method === "GET" || method === "HEAD") return false;
  if (QUIET_WRITE_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  try {
    api.bridge.publish("changed", { path, method });
  } catch {
    // A bus that is down is not a reason to fail a write that succeeded.
    return false;
  }
  return true;
}

/**
 * Refuse a state-changing request that another site's page could have sent.
 *
 * The routes share DSH's own port and carry no token, so a browser page on any
 * origin could POST here and empty the trash: the response is unreadable to it,
 * but the write happens. Two browser-enforced facts close that hole without a
 * token to mint and store:
 *
 *   - `Sec-Fetch-Site` is set by the browser and cannot be forged by script.
 *     A cross-site value means the request came from another origin.
 *   - `Content-Type: application/json` is not a CORS-"simple" content type, so
 *     a cross-site form or `fetch` with it needs a preflight that DSH never
 *     answers. The panel's own requests already send it.
 *
 * Requests without `Sec-Fetch-Site` (curl, scripts) are allowed: they are not
 * a cross-site browser request, and local tooling has to keep working.
 *
 * @param {import("node:http").IncomingMessage} req
 */
export function assertSameOrigin(req) {
  const site = String(req.headers["sec-fetch-site"] ?? "");
  if (site === "cross-site") {
    throw codedError("cross-site", "cross-site writes are refused");
  }
  const type = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!type.startsWith("application/json")) {
    throw codedError("unsupported-media-type", "writes must be sent as application/json");
  }
}

/**
 * The code a thrown value should be reported under.
 *
 * Native DSH errors carry a namespaced `RemoteError.code` such as
 * `workspace/name-conflict` or `session/title-invalid`. Those are passed
 * through unchanged so the client can branch on the host's own vocabulary
 * instead of a translation layer that would drift.
 *
 * @param {any} err
 * @returns {string}
 */
export function errorCodeOf(err) {
  const code = typeof err?.code === "string" ? err.code : "";
  if (code === "") return "bad-request";
  // Node's own errno strings (`ENOENT`, `EACCES`, `ENOSPC`…) are not plugin
  // vocabulary. Reporting them verbatim gave a permission problem the status of
  // a malformed request; they are translated to the codes the client knows.
  if (FS_ERROR_CODES.has(code)) return code === "ENOSPC" ? "disk-full" : "io-error";
  return code;
}

/** errno codes that mean "the filesystem said no", not "the request was wrong". */
export const FS_ERROR_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EEXIST",
  "EIO",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "ENAMETOOLONG",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "ENOTEMPTY",
  "EPERM",
  "EROFS",
  "EXDEV",
]);
