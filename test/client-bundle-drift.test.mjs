/**
 * 产物护航：磁盘上的 lib/client.js 必须能从 src/client/ 逐字节重建。
 *
 * 负责：把「改了分片却忘了重建」变成一条红的用例，而不是等某个用户装上插件
 * 发现面板少了一块。产物进仓库，所以这条用例守的就是提交里的那份：src/client/
 * 动过而 lib/client.js 没跟着重建，提交本身就会红。重建交给
 * scripts/build-client.mjs --check，这里只断言它的退出码，以及产物开头仍然是
 * 宿主认识的那一层壳。
 * 不负责：分片内容的正确性（由其余用例与 render-smoke 覆盖）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FRAGMENT_DIR = fileURLToPath(new URL("../src/client/", import.meta.url));
const BUNDLE = fileURLToPath(new URL("../lib/client.js", import.meta.url));

test("the bundle on disk is reproducible from src/client", () => {
  const run = spawnSync(process.execPath, ["scripts/build-client.mjs", "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    run.status,
    0,
    `build-client --check failed\n${run.stdout ?? ""}${run.stderr ?? ""}`,
  );
});

test("the bundle keeps the module-loader contract the host loads it by", () => {
  const head = readFileSync(BUNDLE, "utf8").slice(0, 4000);
  assert.match(head, /^\/\/ GENERATED FILE/, "the product announces itself as generated");
  assert.match(
    head,
    /window\.__ModuleLoader__\.load\(\{\s*id:\s*"dsh-session-navigator"/,
    "the host finds the plugin by this exact call",
  );
  assert.match(head, /factory:/, "the factory is what the loader executes");
});

test("the manifest lists every fragment and nothing else", () => {
  const manifest = JSON.parse(readFileSync(FRAGMENT_DIR + "manifest.json", "utf8"));
  assert.ok(Array.isArray(manifest) && manifest.length >= 8, "the bundle stays split");

  const listed = new Set(manifest.map((entry) => entry.file));
  const onDisk = readdirSync(FRAGMENT_DIR).filter((name) => name.endsWith(".js"));
  const missing = onDisk.filter((name) => !listed.has(name));
  const stray = [...listed].filter((name) => !onDisk.includes(name));

  assert.deepEqual(missing, [], "a fragment nobody listed would be dropped from the product");
  assert.deepEqual(stray, [], "a listed file that does not exist would break the build");
});

test("no fragment outgrows the 2,000-line split budget", () => {
  const manifest = JSON.parse(readFileSync(FRAGMENT_DIR + "manifest.json", "utf8"));
  for (const entry of manifest) {
    const lines = readFileSync(FRAGMENT_DIR + entry.file, "utf8").split("\n").length - 1;
    assert.ok(lines <= 2000, `${entry.file} is ${lines} lines`);
  }
});
