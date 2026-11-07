/**
 * The hooks the panel destructures must actually return what it asks for.
 *
 * The panel is one function spread over several `lib/client-src/` fragments, and
 * the state it uses was carved into hooks (13b–13h). Nothing checks the seam:
 * `const { renameEntity } = useRenameEditor(...)` is ordinary JavaScript, so a
 * hook that forgets a key still parses, still builds, and only fails when the
 * panel is finally drawn — which is what happened: `renameEntity` stayed inside
 * `useRenameEditor`, the list rows kept taking it as `onRename`, and opening
 * the panel produced "ReferenceError: renameEntity is not defined" behind the
 * `.se-crash` box. Every test passed, because no test opened the panel.
 *
 * The check here is textual on purpose: the fragments are concatenated into one
 * factory scope at build time, so "declared in another fragment" and "returned
 * by the hook" are the only two facts that decide whether the name resolves.
 * Reading the sources keeps this test honest without teaching it to evaluate
 * the bundle — a bundle-level test would need the host's data before the panel
 * draws the rows that use these callbacks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "lib", "client-src");

const fragments = readdirSync(SRC)
  .filter((name) => name.endsWith(".js"))
  .sort()
  .map((name) => ({ name, source: readFileSync(join(SRC, name), "utf8") }));

/** Every `function useSomething(` declaration, with the fragment it lives in. */
function hookDeclarations() {
  const hooks = new Map();
  for (const { name, source } of fragments) {
    for (const match of source.matchAll(/^ {4}function (use[A-Z]\w*)\(/gm)) {
      hooks.set(match[1], { file: name, source });
    }
  }
  return hooks;
}

/** The keys of a hook's `return { ... }` object literal. */
function returnedKeys(source, hook) {
  const start = source.indexOf("function " + hook + "(");
  if (start < 0) return null;
  const rest = source.slice(start);
  // The first top-level `return {` after the declaration is the hook's own;
  // these hooks return once, at the end.
  const match = /^ {6}return \{([\s\S]*?)\};$/m.exec(rest);
  if (!match) return null;
  return match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(":")[0].trim());
}

/** Every `const { a, b } = useHook(...)` in the client sources. */
function hookCalls() {
  const calls = [];
  for (const { name, source } of fragments) {
    for (const match of source.matchAll(/const \{([^}]+)\} = (use[A-Z]\w*)\(/g)) {
      const names = match[1]
        .split(",")
        .map((part) => part.trim().split(":")[0].trim())
        .filter(Boolean);
      calls.push({ file: name, hook: match[2], names });
    }
  }
  return calls;
}

test("every hook the panel calls is declared in a client fragment", () => {
  const hooks = hookDeclarations();
  assert.ok(hooks.size >= 8, "expected the eight panel hooks, found " + hooks.size);
  for (const call of hookCalls()) {
    assert.ok(hooks.has(call.hook), call.file + " calls " + call.hook + "(), which no fragment declares");
  }
});

test("every hook returns the names its callers destructure", () => {
  const hooks = hookDeclarations();
  const problems = [];
  for (const call of hookCalls()) {
    const declaration = hooks.get(call.hook);
    if (!declaration) continue;
    const keys = returnedKeys(declaration.source, call.hook);
    assert.ok(keys, "could not read the return object of " + call.hook + " in " + declaration.file);
    for (const name of call.names) {
      if (!keys.includes(name)) {
        problems.push(call.hook + "() is destructured for " + name + " in " + call.file + " but returns only " + keys.join(", "));
      }
    }
  }
  assert.deepEqual(problems, [], "a destructured hook value is missing from its return object");
});

test("names the panel hands to onRename are declared before use", () => {
  // The panel passes the same rename function to the detail title row, the list
  // rows and the tree rows. If a fragment names it without the destructuring
  // above, the panel dies on first render; this pins the specific symbol so the
  // failure reads as a sentence instead of a browser stack.
  const declared = new Set();
  for (const { source } of fragments) {
    for (const match of source.matchAll(/const \{([^}]+)\} = (use[A-Z]\w*)\(/g)) {
      for (const part of match[1].split(",")) declared.add(part.trim().split(":")[0].trim());
    }
    for (const match of source.matchAll(/^ {6}(?:const|let) ([A-Za-z_$][\w$]*) =/gm)) declared.add(match[1]);
  }
  const used = [];
  for (const { name, source } of fragments) {
    for (const match of source.matchAll(/onRename: ([A-Za-z_$][\w$]*)/g)) {
      // `onRename: onRename` is a row forwarding the prop it was handed; only a
      // different name is a lookup in the panel's own scope.
      if (match[1] === "onRename") continue;
      used.push({ file: name, symbol: match[1] });
    }
  }
  assert.ok(used.length >= 2, "expected the list and tree rows to pass an onRename");
  for (const entry of used) {
    assert.ok(declared.has(entry.symbol), entry.file + " passes onRename: " + entry.symbol + ", which nothing declares");
  }
});
