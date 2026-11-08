// 路由组 wallpaper（4 条）
//
// 独立窗口美化：一张图片或一段视频，铺在窗口面板下面。文件归插件自己管——
// 它**不在缓存里**，清理缓存不会把它带走，换数据目录时会跟着搬。
//
// 为什么上传不走 JSON：一张 4K 壁纸、一段十几秒的视频，base64 之后是原文的
// 1.34 倍，8 MB 的 JSON 上限连一张截图都装不下。所以这条路由读的是**原始请求体**，
// 字节直接落盘（见 src/index.js 里 dispatch 对 RAW_BODY_ROUTES 的例外）。
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat, statfs } from "node:fs/promises";
import { extname, join } from "node:path";

import { CUSTOM_FILE, normalizeSettings } from "../domain/settings.js";
import { expectedRevision } from "../routes/shared.js";
import { codedError } from "../store/sidecar.js";

/**
 * 上传没有固定上限，边界是磁盘本身。
 *
 * 原先这里写着 256 MB——一个凭感觉挑的数：够放一段循环视频，却没有任何一只
 * 硬盘说过这个数。视频壁纸能有多大是用户自己的事，插件该做的是**别把盘写满**，
 * 而不是替人决定文件多大。所以现在写之前先看剩余空间：这段上传之后还要剩
 * 至少 RESERVE_BYTES，否则报 disk-full（507），一开始就拒绝，不写到一半才说。
 */
export const RESERVE_BYTES = 256 * 1024 * 1024;

/** 边写边看盘：每写这么多字节重新问一次剩余空间。 */
const CHECK_EVERY_BYTES = 32 * 1024 * 1024;

/** 认的扩展名 → Content-Type。别的都拒，因为窗口只会用这几类画东西。 */
const TYPES = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
});

/** 反向表：Content-Type → 扩展名，给没有文件名（或文件名没扩展名）的上传兜底。 */
const BY_TYPE = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/ogg": "ogv",
});

/** 这些扩展名一起当目录里的“旧壁纸”，换的时候一并清掉。 */
const KEPT_EXTENSIONS = Object.keys(TYPES);

/**
 * 壁纸目录：`<dataDir>/wallpaper/`。
 *
 * 每次现算，因为换数据目录之后 `api.dataDir` 会变，而这里是唯一决定文件
 * 落在哪儿的函数。
 *
 * @param {any} api
 * @returns {string}
 */
function wallpaperDir(api) {
  if (typeof api?.dataDir !== "string" || api.dataDir === "") {
    throw codedError("capability-missing", "这个运行环境没有自己的数据目录，壁纸无处可放");
  }
  return join(api.dataDir, "wallpaper");
}

/**
 * 文件名里能留下来的部分：只取 basename，去掉控制字符，截到 120 个字符。
 *
 * 用户看到的“名字”，不是路径。
 *
 * @param {unknown} value
 * @returns {string}
 */
function displayName(value) {
  const raw = typeof value === "string" ? value : "";
  // 反斜杠也算分隔符：Windows 的 input.files[0].name 只会给 "a\\b.png" 这种残片。
  const tail = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = tail.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, 120);
}

/**
 * 从文件名或 Content-Type 里认出扩展名。
 *
 * @param {string} name
 * @param {string} type
 * @returns {string} 小写扩展名，认不出时为空串
 */
function extensionFor(name, type) {
  const ext = extname(name).slice(1).toLowerCase();
  if (KEPT_EXTENSIONS.includes(ext)) return ext;
  const bare = String(type ?? "").split(";")[0].trim().toLowerCase();
  return BY_TYPE[bare] ?? "";
}

/**
 * 这个卷还剩多少字节，不知道时回 null。
 *
 * 不知道就说不知道：把这个调用当成可选能力，比在旧运行时上假装盘满了稳。
 *
 * @param {string} dir
 * @returns {Promise<number | null>}
 */
async function freeBytes(dir) {
  try {
    const stats = await statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/**
 * 这段字节写得下吗：写完之后至少还要留下 RESERVE_BYTES。
 *
 * @param {string} dir
 * @param {number} need 还要写的字节数
 */
async function assertRoom(dir, need) {
  const free = await freeBytes(dir);
  if (free === null) return;
  if (need + RESERVE_BYTES > free) {
    const mb = Math.ceil(RESERVE_BYTES / 1024 / 1024);
    throw codedError("disk-full", `磁盘剩余空间不够：写入之后要留 ${mb} MB 余量`);
  }
}

/**
 * 把请求体按字节写进磁盘，中途失败不留半截文件。
 *
 * @param {any} req
 * @param {string} path
 * @param {string} dir 目标目录，用来问剩余空间
 * @returns {Promise<number>} 写下的字节数
 */
async function receive(req, path, dir) {
  if (typeof req?.[Symbol.asyncIterator] !== "function") {
    throw codedError("bad-request", "上传的内容为空");
  }
  // Content-Length is the cheap half: a 40 GB file is refused before its first
  // byte lands. Chunked uploads have no such header, hence the loop below.
  const declared = Number(req?.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > 0) await assertRoom(dir, declared);
  const handle = await open(path, "w");
  let size = 0;
  let nextCheck = CHECK_EVERY_BYTES;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size >= nextCheck) {
        nextCheck = size + CHECK_EVERY_BYTES;
        const free = await freeBytes(dir);
        if (free !== null && free < RESERVE_BYTES) {
          throw codedError("disk-full", "磁盘空间不够，壁纸写入没有完成");
        }
      }
      await handle.write(chunk);
    }
    await handle.close();
  } catch (failure) {
    await handle.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
    throw failure;
  }
  if (size === 0) {
    await rm(path, { force: true }).catch(() => {});
    throw codedError("bad-request", "上传的内容为空");
  }
  return size;
}

/**
 * 当前这张壁纸的实情，或者 null。
 *
 * 以设置里记的名为准，再 stat 一次：设置写了名字、文件却被人删掉时，窗口
 * 应该看到“没有壁纸”，而不是一个 404 的图层。
 *
 * @param {any} api
 * @returns {Promise<{ file: string, name: string, bytes: number, type: string, modified: number, path: string } | null>}
 */
async function currentFile(api) {
  const settings = normalizeSettings(await api.documents.settings.read());
  const file = settings.wallpaper.custom;
  if (!file || !CUSTOM_FILE.test(file)) return null;
  const dir = wallpaperDir(api);
  const path = join(dir, file);
  let info;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  const ext = extname(file).slice(1).toLowerCase();
  return {
    file,
    name: settings.wallpaper.customName || file,
    bytes: info.size,
    type: TYPES[ext] ?? "application/octet-stream",
    modified: Math.round(info.mtimeMs),
    path,
  };
}

/**
 * 删掉目录里所有旧壁纸（包括上一次留下的临时文件）。
 *
 * @param {string} dir
 */
async function clearDir(dir) {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * 解析一个 Range 头。
 *
 * 视频要的就是这个：没有 206，Chromium 会整段下载完才能 seek，一段 30 秒的
 * 循环视频每次打开窗口都要重下一遍。
 *
 * @param {string | undefined} header
 * @param {number} total
 * @returns {{ start: number, end: number } | null} null 表示按整份回
 */
function parseRange(header, total) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? "").trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  let start;
  let end;
  if (rawStart === "") {
    // `bytes=-500`：最后 500 字节。
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? total - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) return null;
  return { start, end: Math.min(end, total - 1) };
}

/**
 * 把文件的一段送进响应，等它写完再返回。
 *
 * @param {string} path
 * @param {any} res
 * @param {{ start?: number, end?: number }} [range]
 */
function streamFile(path, res, range) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, range ? { start: range.start, end: range.end } : undefined);
    stream.on("error", reject);
    res.on("close", resolve);
    res.on("finish", resolve);
    stream.pipe(res);
  });
}

export const wallpaperRoutes = {
  /**
   * 这张壁纸现在的样子。
   *
   * 窗口每四秒问一次：文件换了（或没换）比 `/settings` 的版本号更直接。
   */
  "GET /wallpaper": async (api) => {
    const file = await currentFile(api);
    return { file: file ? { file: file.file, name: file.name, bytes: file.bytes, type: file.type, modified: file.modified } : null };
  },

  /**
   * 上传一张图或一段视频（原始字节作为请求体）。
   *
   * 查询串上的 `name` 是用户看到的文件名；扩展名从它或 Content-Type 里取。
   */
  "POST /wallpaper/custom": async (api, req, res, query) => {
    const name = displayName(query?.get?.("name"));
    const ext = extensionFor(name, req.headers?.["content-type"]);
    if (!ext) {
      throw codedError("bad-request", "只支持图片（png / jpg / webp / gif / avif / bmp）或视频（mp4 / webm / mov / ogv）");
    }
    const dir = wallpaperDir(api);
    await mkdir(dir, { recursive: true });
    const temp = join(dir, `.upload-${Date.now().toString(36)}.tmp`);
    const bytes = await receive(req, temp, dir);
    // 换壁纸不叠加：目录里只留一张，旧的先清掉再落位。
    for (const kept of KEPT_EXTENSIONS) await rm(join(dir, `wallpaper.${kept}`), { force: true }).catch(() => {});
    const file = `wallpaper.${ext}`;
    await rename(temp, join(dir, file));
    const document = await api.documents.settings.mutate(
      (draft) => {
        draft.wallpaper = { ...(draft.wallpaper && typeof draft.wallpaper === "object" ? draft.wallpaper : {}), custom: file, customName: name || file };
      },
      expectedRevision(req, api),
    );
    return {
      file: { file, name: name || file, bytes, type: TYPES[ext], modified: Date.now() },
      settings: normalizeSettings(document),
      revision: document.revision,
    };
  },

  /**
   * 这张壁纸的字节，支持 Range。
   *
   * 与 `/ui/*` 的资产不同，这里是用户上传的文件：它可能是一段视频，所以
   * 206 不是加分项而是能不能播的前提。
   */
  "GET /wallpaper/media": async (api, req, res) => {
    const info = await currentFile(api);
    if (!info) throw codedError("wallpaper-not-found", "还没有设置自定义壁纸");
    const range = parseRange(req.headers?.range, info.bytes);
    res.setHeader("Content-Type", info.type);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    if (!range) {
      res.statusCode = 200;
      res.setHeader("Content-Length", String(info.bytes));
      await streamFile(info.path, res);
      return;
    }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${info.bytes}`);
    res.setHeader("Content-Length", String(range.end - range.start + 1));
    await streamFile(info.path, res, range);
  },

  /** 删掉自定义壁纸，窗口回到“跟随壁纸插件”。 */
  "DELETE /wallpaper/custom": async (api, req) => {
    await clearDir(wallpaperDir(api));
    const document = await api.documents.settings.mutate(
      (draft) => {
        draft.wallpaper = { ...(draft.wallpaper && typeof draft.wallpaper === "object" ? draft.wallpaper : {}), custom: "", customName: "" };
      },
      expectedRevision(req, api),
    );
    return { settings: normalizeSettings(document), revision: document.revision };
  },
};
