/**
 * Tests for the 独立窗口美化 file: upload, serve, remove.
 *
 *   node --test test/wallpaper.test.mjs
 *
 * The route group is driven directly rather than through the dispatcher, because
 * the interesting behaviour is in the bytes: an upload is the request body itself
 * (src/index.js skips readJsonBody for it), and a video needs `206` with a
 * Content-Range or the window cannot seek it. Both are properties of the stream
 * plumbing, so the fakes here are real streams and a real data directory.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { RESERVE_BYTES, wallpaperRoutes } from "../src/routes/wallpaper.js";
import { dataPaths, ensureDataDir } from "../src/paths.js";
import { openDocuments } from "../src/store/documents.js";

/** A data directory of its own, with the documents the routes read. */
async function host() {
  const dir = await mkdtemp(join(tmpdir(), "se-wallpaper-"));
  ensureDataDir(dir);
  const paths = dataPaths(dir);
  const api = { dataDir: dir, paths, documents: openDocuments(paths) };
  return { api, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A response the streaming routes can pipe into; `finish` is what they await. */
function sink() {
  const parts = [];
  const res = new Writable({
    write(chunk, _encoding, callback) {
      parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      callback();
    },
  });
  res.statusCode = 0;
  res.headersSent = false;
  res.headers = {};
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = value;
  };
  res.getHeader = (name) => res.headers[String(name).toLowerCase()];
  res.bytes = () => Buffer.concat(parts);
  return res;
}

/**
 * An upload request: the body is the file, split into two chunks so a route that
 * read only the first would fail the byte-count assertions.
 */
function uploadRequest(bytes, { name, type = "image/png" } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const half = Math.ceil(buffer.length / 2);
  return {
    req: {
      url: "/session-navigator/api/wallpaper/custom",
      method: "POST",
      headers: { "content-type": type },
      async *[Symbol.asyncIterator]() {
        if (buffer.length === 0) return;
        yield buffer.subarray(0, half);
        if (half < buffer.length) yield buffer.subarray(half);
      },
    },
    query: new URLSearchParams(name === undefined ? {} : { name }),
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

const get = (api, key, req = { headers: {} }) => wallpaperRoutes[key](api, req, sink(), new URLSearchParams());

test("nothing uploaded yet is an empty answer, not an error", async () => {
  const box = await host();
  try {
    const answer = await get(box.api, "GET /wallpaper");
    assert.deepEqual(answer, { file: null }, "the window draws no layer for a null file");
    await assert.rejects(() => get(box.api, "GET /wallpaper/media"), (failure) => {
      assert.equal(failure.code, "wallpaper-not-found");
      return true;
    });
  } finally {
    await box.cleanup();
  }
});

test("an upload is written to the data directory and named in settings", async () => {
  const box = await host();
  try {
    const { req, query } = uploadRequest(PNG, { name: "海边.png" });
    const answer = await wallpaperRoutes["POST /wallpaper/custom"](box.api, req, sink(), query);
    assert.equal(answer.file.bytes, PNG.length, "the byte count is what was streamed");
    assert.equal(answer.file.type, "image/png");
    assert.equal(answer.settings.wallpaper.custom, "wallpaper.png");
    assert.equal(answer.settings.wallpaper.customName, "海边.png", "the name the user picked is kept for the row");

    const onDisk = await readFile(join(box.dir, "wallpaper", "wallpaper.png"));
    assert.deepEqual(onDisk, PNG, "the bytes on disk are the bytes sent");
    const listed = await readdir(join(box.dir, "wallpaper"));
    assert.deepEqual(listed, ["wallpaper.png"], "no temporary file survives a successful upload");

    const now = await get(box.api, "GET /wallpaper");
    assert.equal(now.file.name, "海边.png");
    assert.equal(now.file.bytes, PNG.length);
    assert.ok(now.file.modified > 0, "the window's cache-buster needs a stamp");
  } finally {
    await box.cleanup();
  }
});

test("the media route serves the file, and a Range gets 206", async () => {
  const box = await host();
  try {
    const { req, query } = uploadRequest(PNG, { name: "a.png" });
    await wallpaperRoutes["POST /wallpaper/custom"](box.api, req, sink(), query);

    const whole = sink();
    await wallpaperRoutes["GET /wallpaper/media"](box.api, { headers: {} }, whole, new URLSearchParams());
    assert.equal(whole.statusCode, 200);
    assert.equal(whole.headers["content-type"], "image/png");
    assert.equal(whole.headers["accept-ranges"], "bytes");
    assert.equal(whole.headers["cache-control"], "no-store");
    assert.equal(whole.headers["content-length"], String(PNG.length));
    assert.deepEqual(whole.bytes(), PNG);

    const part = sink();
    await wallpaperRoutes["GET /wallpaper/media"](box.api, { headers: { range: "bytes=2-5" } }, part, new URLSearchParams());
    assert.equal(part.statusCode, 206, "a video that cannot seek is a video that loops from the start");
    assert.equal(part.headers["content-range"], "bytes 2-5/" + PNG.length);
    assert.equal(part.headers["content-length"], "4");
    assert.deepEqual(part.bytes(), PNG.subarray(2, 6));
  } finally {
    await box.cleanup();
  }
});

test("a second upload replaces the first instead of stacking", async () => {
  const box = await host();
  try {
    const first = uploadRequest(PNG, { name: "a.png" });
    await wallpaperRoutes["POST /wallpaper/custom"](box.api, first.req, sink(), first.query);
    const movie = Buffer.from("....ftypisom....", "utf8");
    const second = uploadRequest(movie, { name: "b.mp4", type: "video/mp4" });
    const answer = await wallpaperRoutes["POST /wallpaper/custom"](box.api, second.req, sink(), second.query);
    assert.equal(answer.settings.wallpaper.custom, "wallpaper.mp4");
    assert.deepEqual(await readdir(join(box.dir, "wallpaper")), ["wallpaper.mp4"], "one wallpaper, not two");
  } finally {
    await box.cleanup();
  }
});

test("a file this window cannot draw is refused before it is written", async () => {
  const box = await host();
  try {
    const { req, query } = uploadRequest(Buffer.from("hello"), { name: "notes.txt", type: "text/plain" });
    await assert.rejects(() => wallpaperRoutes["POST /wallpaper/custom"](box.api, req, sink(), query), (failure) => {
      assert.equal(failure.code, "bad-request");
      assert.match(failure.message, /png/);
      return true;
    });
    assert.deepEqual(await readdir(join(box.dir, "wallpaper")).catch(() => []), [], "nothing landed on disk");
  } finally {
    await box.cleanup();
  }
});

test("an empty upload leaves no half-written file behind", async () => {
  const box = await host();
  try {
    const { req, query } = uploadRequest(Buffer.alloc(0), { name: "a.png" });
    await assert.rejects(() => wallpaperRoutes["POST /wallpaper/custom"](box.api, req, sink(), query), (failure) => {
      assert.equal(failure.code, "bad-request");
      return true;
    });
    assert.deepEqual(await readdir(join(box.dir, "wallpaper")), [], "the temporary file is gone");
  } finally {
    await box.cleanup();
  }
});

test("removing the wallpaper empties the directory and clears the name", async () => {
  const box = await host();
  try {
    const { req, query } = uploadRequest(PNG, { name: "a.png" });
    await wallpaperRoutes["POST /wallpaper/custom"](box.api, req, sink(), query);

    const answer = await wallpaperRoutes["DELETE /wallpaper/custom"](box.api, { headers: {} }, sink(), new URLSearchParams());
    assert.equal(answer.settings.wallpaper.custom, "");
    assert.equal(answer.settings.wallpaper.customName, "");
    await assert.rejects(() => stat(join(box.dir, "wallpaper")), "the directory goes with it");
    assert.deepEqual(await get(box.api, "GET /wallpaper"), { file: null });
  } finally {
    await box.cleanup();
  }
});

test("a deleted file is reported as no wallpaper, not as a broken one", async () => {
  const box = await host();
  try {
    const { req, query } = uploadRequest(PNG, { name: "a.png" });
    await wallpaperRoutes["POST /wallpaper/custom"](box.api, req, sink(), query);
    await rm(join(box.dir, "wallpaper", "wallpaper.png"), { force: true });
    assert.deepEqual(await get(box.api, "GET /wallpaper"), { file: null }, "settings still name a file nobody has");
  } finally {
    await box.cleanup();
  }
});

test("the only ceiling is the disk, and it is checked before the first byte", async () => {
  assert.equal(RESERVE_BYTES, 256 * 1024 * 1024, "the upload has to leave this much free");
  const box = await host();
  try {
    // A declared size no volume has room for. Refused up front: the point of the
    // check is that a 40 GB file never starts writing.
    const req = {
      url: "/session-navigator/api/wallpaper/custom",
      method: "POST",
      headers: { "content-type": "image/png", "content-length": String(Number.MAX_SAFE_INTEGER) },
      async *[Symbol.asyncIterator]() {
        throw new Error("the body must not be read once the disk says no");
      },
    };
    await assert.rejects(
      () => wallpaperRoutes["POST /wallpaper/custom"](box.api, req, sink(), new URLSearchParams({ name: "big.png" })),
      (failure) => {
        assert.equal(failure.code, "disk-full");
        return true;
      },
    );
    assert.deepEqual(readdirSync(join(box.dir, "wallpaper")), [], "no half file left behind");
  } finally {
    await box.cleanup();
  }
});
