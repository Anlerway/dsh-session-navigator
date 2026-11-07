/**
 * The reveal agent must not outlive the work it was warmed for.
 *
 * PowerShell is started once and kept warm because `Add-Type` costs about a
 * second per reveal (see lib/host/reveal-agent.js). That child is a daemon, and
 * a daemon with piped stdio holds the event loop open: any process that merely
 * answered `GET /library` — which warms the agent — would sit there after its
 * last test, its last request, its last line of output.
 *
 * This is not hypothetical. `test/routes-contract.test.mjs` calls every read
 * route, so it warmed the agent; on a machine with koffi installed the native
 * reveal path answers first and the warm-up never runs, but in a clean checkout
 * (and on CI, which installs no optional dependencies) it ran, the child kept
 * the pipes open, and the whole suite stalled at test 453 until the runner was
 * killed. The fix is one unref per handle; this file is what notices if it is
 * ever removed.
 *
 * The check is a real child process rather than an inspection of the agent's
 * internals: the failure being pinned is "Node never exits", and only a real
 * process exhibits it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = pathToFileURL(join(HERE, "..", "lib", "host", "reveal-agent.js")).href;

/** PowerShell only exists on Windows; the agent is never started elsewhere. */
const windows = process.platform === "win32";

test("a warmed reveal agent does not keep its parent process alive", { skip: !windows && "reveal-agent.js only spawns on Windows" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "se-reveal-agent-"));
  const script = join(dir, "warm.mjs");
  writeFileSync(
    script,
    [
      `import { warmRevealAgent } from ${JSON.stringify(AGENT)};`,
      `warmRevealAgent("Write-Output '#R:none#'");`,
      `console.log("warmed");`,
      // No process.exit on purpose: the point is that the event loop drains.
    ].join("\n"),
    "utf8",
  );

  /** @type {{ code: number | null, signal: string | null, stdout: string, stderr: string, timedOut: boolean }} */
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 20_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });

  rmSync(dir, { recursive: true, force: true });

  assert.equal(result.timedOut, false, "the warm-up held the process open for 20s; the agent's child and pipes must be unref'd");
  assert.equal(result.code, 0, "the warm-up exited with " + result.code + ": " + result.stderr);
  assert.match(result.stdout, /warmed/, "the script did not reach its own last line");
});
