/**
 * 日期格式 / 大小单位 — the two display choices in 设置 › 显示.
 *
 * 距今时间 is a count of 分钟, 小时 or 天 — never 月 or 年, never "昨天".
 *
 * Both formatters are called from rows that never receive a display prop, so the
 * branch they take is decided by one module-level record. That record is what
 * these cases move: they are the only place the four combinations are actually
 * printed, and a wrong branch here would show up for every row at once.
 *
 * @module test/display-format
 */
import test from "node:test";
import assert from "node:assert/strict";

import { loadClientBundle } from "./support/client-bundle.mjs";

const { test: internals } = loadClientBundle({ expose: ["formatSize", "formatRelative", "formatWhen", "panelFormat"] });

/** Move the record the formatters read; every case starts from the defaults. */
function choose(date, size) {
  internals.panelFormat.date = date;
  internals.panelFormat.size = size;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/**
 * A local wall-clock time, in the same zone the formatter prints in.
 *
 * The dates below are what a row shows, so building them from a fixed offset
 * (2026-10-23T12:00:00+08:00) would only agree with the expectation on a machine
 * set to +08:00 — a CI runner in UTC would print 04:00 and fail.
 */
function at(year, monthIndex, day, hour, minute) {
  return new Date(year, monthIndex, day, hour, minute).getTime();
}

test("自动转换 picks the unit that keeps the number readable", () => {
  choose("date", "auto");
  // An unknown size prints nothing: the row then decides whether to show a dash.
  assert.equal(internals.formatSize(0), "");
  assert.equal(internals.formatSize(-1), "");
  assert.equal(internals.formatSize(Number.NaN), "");
  assert.equal(internals.formatSize(999), "999 B");
  assert.equal(internals.formatSize(1536), "1.5 KB");
  assert.equal(internals.formatSize(19_200_000), "18.3 MB");
  // Past 100 the tenths are noise, so the number is rounded instead.
  assert.equal(internals.formatSize(150 * 1024), "150 KB");
});

test("固定 KB says every size in one unit", () => {
  choose("date", "kb");
  assert.equal(internals.formatSize(1536), "1.5 KB");
  assert.equal(internals.formatSize(19_200_000), "18750 KB");
  // Small files keep a tenth so a 512-byte session log is not "1 KB" and not "0".
  assert.equal(internals.formatSize(512), "0.5 KB");
  assert.equal(internals.formatSize(0), "", "unknown is still unknown, whatever the unit");
});

test("详细日期 prints the clock time, with the year only when it is not this year", () => {
  choose("date", "auto");
  const now = at(2026, 9, 23, 12, 0);
  const thisYear = internals.formatWhen(now - 3 * DAY, now);
  assert.match(thisYear, new RegExp("^\\d{2}-\\d{2} \\d{2}:\\d{2}$"), thisYear);
  const older = internals.formatWhen(at(2024, 2, 1, 8, 30), now);
  assert.match(older, /^2024-03-01 08:30$/, older);
  assert.equal(internals.formatWhen(0, now), "", "a session with no timestamp prints nothing");
});

test("距今时间 counts only 分钟, 小时, 天", () => {
  choose("relative", "auto");
  const now = at(2026, 9, 23, 12, 0);
  // Three units and no more: a number plus 分钟 / 小时 / 天, with no 前 and no
  // "昨天" — the count is the fact, the words around it are decoration.
  assert.match(internals.formatWhen(now - 5 * 60_000, now), /^5\s?分钟$/, "minutes");
  assert.match(internals.formatWhen(now - 3 * HOUR, now), /^3\s?小时$/, "hours");
  assert.match(internals.formatWhen(now - 3 * DAY, now), /^3\s?天$/, "days");
  // A count never stops climbing: months and years are days, however many.
  assert.match(internals.formatWhen(now - 60 * DAY, now), /^60\s?天$/, "two months is still days");
  assert.match(internals.formatWhen(now - 800 * DAY, now), /^800\s?天$/, "two years is still days");
  // Just now is 1, never 0 — "0分钟" reads as a bug, not as freshness.
  assert.match(internals.formatWhen(now - 20_000, now), /^1\s?分钟$/, "under a minute");
  assert.match(internals.formatWhen(now, now), /^1\s?分钟$/, "the same instant");
  // The same instant reads differently under each setting — that is the whole
  // point of the choice, and the reason both formats share one entry point.
  choose("date", "auto");
  assert.match(internals.formatWhen(now - 3 * DAY, now), /^\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("the two choices are independent", () => {
  choose("relative", "kb");
  const now = at(2026, 9, 23, 12, 0);
  assert.match(internals.formatWhen(now - 2 * HOUR, now), /^2\s?小时$/);
  assert.equal(internals.formatSize(2048), "2.0 KB");
  choose("date", "auto");
});
