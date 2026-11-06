/**
 * dsh-session-navigator — request validation.
 *
 * Every handler used to open-code its own reading of `req.body`: a `typeof`
 * here, an `Array.isArray` there. Two of those readings were the incidents this
 * file closes — a rename with no name answered 200 without writing anything,
 * and a reorder whose `order` was `"abc"` reached the document as `NaN`. A rule
 * written three times drifts twice; here it is written once.
 *
 * A route body should say *what* it needs ("a name", "a list of ids") and leave
 * *how* that is checked to this file. Every validator throws
 * `codedError("bad-request", …)`, which the dispatcher in lib/index.js already
 * turns into a 400 with the standard envelope (`{ ok: false, error, code }`), so
 * nothing here touches a response object.
 *
 * Messages keep the shape they had inline (`"<field> must be a string"`,
 * `"<field> must not be blank"`) because the panel and the tests match on those
 * sentences. A call site whose sentence was already better passes it as
 * `message`, so moving a rule here never rewrites what a user reads.
 */

import { codedError } from "./store/sidecar.js";

/**
 * The one error every validator throws: a malformed request, not a server fault.
 *
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function badRequest(message) {
  return codedError("bad-request", message);
}

/**
 * A request body that must be a JSON object.
 *
 * Arrays and `null` are refused: `typeof null === "object"` and an array reads
 * as an object, so a body that is really a list would otherwise walk through
 * `body.source` checks as `undefined` and look like an empty request.
 *
 * @param {any} value
 * @param {string} [field] name used in the message
 * @param {{ message?: string }} [options]
 * @returns {Record<string, any>}
 */
export function requireObject(value, field = "body", options = {}) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest(options.message ?? `${field} must be an object`);
  }
  return value;
}

/**
 * A body that may legitimately be absent.
 *
 * `undefined` / `null` become `{}` — a request with no body is a request with no
 * options, which is what `fetch` sends for a button with nothing to configure.
 * Anything present must still be an object.
 *
 * @param {any} value
 * @param {string} [field]
 * @returns {Record<string, any>}
 */
export function optionalObject(value, field = "body") {
  if (value === undefined || value === null) return {};
  return requireObject(value, field);
}

/**
 * A required, non-blank string.
 *
 * The value is trimmed: a rename to `"   "` is a rename to nothing, and the
 * whitespace never belonged to the name. `options.message` replaces both
 * sentences when a call site has its own wording (e.g. "borrowed must be a
 * runtime path").
 *
 * @param {any} value
 * @param {string} field
 * @param {{ message?: string }} [options]
 * @returns {string} the trimmed text
 */
export function requireText(value, field, options = {}) {
  if (typeof value !== "string") throw badRequest(options.message ?? `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed === "") throw badRequest(options.message ?? `${field} must not be blank`);
  return trimmed;
}

/**
 * One of a fixed set of words.
 *
 * `options.unknown` names the noun for the "not a value I know" case, which is
 * how `unknown install source: ftp` keeps saying exactly that instead of
 * listing the two sources — a typo should be echoed, not taught.
 *
 * @template T
 * @param {any} value
 * @param {readonly T[]} allowed
 * @param {string} field
 * @param {{ message?: string, unknown?: string }} [options]
 * @returns {T}
 */
export function requireEnum(value, allowed, field, options = {}) {
  if (allowed.includes(value)) return value;
  if (options.unknown) throw badRequest(`unknown ${options.unknown}: ${String(value)}`);
  throw badRequest(options.message ?? `${field} must be one of ${allowed.join(", ")}`);
}

/**
 * A number, or the string form of one.
 *
 * Sorting sends `order` as JSON, so it arrives as a number; a form or a URL
 * query sends the same thing as text. Both are the same request. `NaN`, `""`,
 * `null` and `{}` are not: they become `NaN` and are refused here, because the
 * document would otherwise be written with an order nothing can sort by.
 *
 * @param {any} value
 * @param {string} field
 * @param {{ message?: string }} [options]
 * @returns {number}
 */
export function requireFiniteNumber(value, field, options = {}) {
  const number =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) throw badRequest(options.message ?? `${field} must be a number`);
  return number;
}

/**
 * A batch of ids.
 *
 * Entries that are not non-blank strings are dropped rather than refused: a
 * selection can carry a stale row, and one stale row must not void a gesture
 * that was otherwise valid. Whether an empty batch is an error is the caller's
 * question, and so is what counts as empty:
 *
 * - `emptyWhen: "filtered"` (default) — a batch that named nothing usable is
 *   an error, and the sentence is about ids (a placement of `[]`).
 * - `emptyWhen: "input"` — the caller only needs the batch to have been
 *   *named*; ids the domain cannot resolve are its business (`/trash`, where
 *   `withBoundChildren` answers with what it removed).
 *
 * @param {any} value
 * @param {string} [field]
 * @param {{ allowEmpty?: boolean, emptyWhen?: "filtered" | "input", message?: string }} [options]
 * @returns {string[]} the usable ids, in the order they arrived
 */
export function requireIdArray(value, field = "ids", options = {}) {
  const { allowEmpty = false, emptyWhen = "filtered", message } = options;
  if (!Array.isArray(value)) throw badRequest(message ?? `${field} must be an array of ids`);
  const ids = value.filter((id) => typeof id === "string" && id.trim() !== "");
  const counted = emptyWhen === "input" ? value : ids;
  if (!allowEmpty && counted.length === 0) throw badRequest(message ?? `${field} must be a non-empty array`);
  return ids;
}

/**
 * Refuse keys nobody reads.
 *
 * Silently ignoring the rest of a body let a caller believe a choice was
 * honoured when nothing was even read — a `mirror` URL that never reached the
 * downloader, and a re-run install that restarted a finished component.
 *
 * @param {Record<string, any>} value
 * @param {readonly string[]} allowed
 * @param {string} label noun for the message, e.g. "install option"
 * @returns {Record<string, any>} the same object, for chaining
 */
export function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value ?? {})) {
    if (!allowed.includes(key)) throw badRequest(`unknown ${label}: ${key}`);
  }
  return value;
}
