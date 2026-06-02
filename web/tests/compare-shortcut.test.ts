// Compare page keyboard shortcut wiring.
// Pins the Cmd/Ctrl+Enter submit shortcut on /compare so the main "try it"
// action stays reachable from the keyboard while focus sits inside either
// snippet textarea. Source-level so it runs with the same node --test rig
// the rest of the suite uses, no jsdom required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("compare page binds a global Cmd/Ctrl+Enter shortcut to submit", async () => {
  const src = await read("app/compare/page.tsx");
  assert.match(src, /addEventListener\("keydown"/, "must register a keydown listener");
  assert.match(src, /removeEventListener\("keydown"/, "must clean up the listener");
  assert.match(src, /e\.metaKey \|\| e\.ctrlKey/, "must accept either Cmd or Ctrl");
  assert.match(src, /e\.key !== "Enter"/, "must gate on Enter");
  assert.match(src, /canCompareRef\.current/, "must respect the same disabled-state guard as the button");
  assert.match(src, /submitRef\.current\(\)/, "must call the latest submit closure, not a stale one");
});

test("compare button advertises the keyboard shortcut", async () => {
  const src = await read("app/compare/page.tsx");
  assert.match(src, /aria-keyshortcuts="Meta\+Enter Control\+Enter"/, "must expose shortcut to assistive tech");
  assert.match(src, /title=\{`Run comparison \(\$\{shortcutHint\}\)`\}/, "must show a tooltip with the shortcut");
  assert.match(src, /setShortcutHint\(isMac \? "\\u2318\+Enter" : "Ctrl\+Enter"\)/, "must show the cmd glyph on Mac and fall back elsewhere");
});
