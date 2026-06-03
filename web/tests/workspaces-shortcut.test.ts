// Workspaces page filter + keyboard shortcut wiring.
// Pins the "/" focus-search shortcut on /workspaces so power users with many
// workspaces can jump to the filter without reaching for the mouse, matching
// the convention already live on /snippets, /history, /api-keys, /webhooks,
// /models, /notifications, /collections, /pairs, and /audit. Source-level so
// it runs with the same node --test rig the rest of the suite uses, no jsdom
// required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("workspaces page filters items by name, slug, and role", async () => {
  const src = await read("app/workspaces/page.tsx");
  assert.match(src, /const \[q, setQ\] = useState\(""\)/, "must hold a filter query in state");
  assert.match(src, /const filtered = useMemo\(/, "must derive the filtered list with useMemo so it updates as the user types");
  assert.match(src, /w\.name.*w\.slug.*w\.myRole/, "filter haystack must cover name, slug, and role");
  assert.match(src, /filtered\.map\(/, "rendered list must come from the filtered slice, not the raw items array");
  assert.match(src, /No workspaces match the filter/, "must show a dedicated empty state when the filter excludes everything");
});

test("workspaces page binds a global / shortcut that focuses the search input", async () => {
  const src = await read("app/workspaces/page.tsx");
  assert.match(src, /searchInputRef\s*=\s*useRef<HTMLInputElement \| null>\(null\)/, "must hold a ref to the search input");
  assert.match(src, /ref=\{searchInputRef\}/, "must attach the ref to the search input");
  assert.match(src, /addEventListener\("keydown"/, "must register a keydown listener");
  assert.match(src, /removeEventListener\("keydown"/, "must clean up the listener");
  assert.match(src, /e\.key !== "\/"/, "must gate on the / key");
  assert.match(src, /e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey/, "must ignore modifier combos so it does not steal browser shortcuts");
  assert.match(src, /tag === "INPUT" \|\| tag === "TEXTAREA" \|\| tag === "SELECT"/, "must not hijack a literal / typed in another field");
  assert.match(src, /isContentEditable/, "must not hijack a literal / in contenteditable surfaces");
  assert.match(src, /el\.focus\(\);\s*\n\s*el\.select\(\)/, "must focus and select the existing query for fast overwrite");
});

test("workspaces filter box advertises the / shortcut", async () => {
  const src = await read("app/workspaces/page.tsx");
  assert.match(src, /aria-keyshortcuts="\/"/, "must expose the shortcut to assistive tech");
  assert.match(src, /title="Press \/ to focus search"/, "must show a tooltip with the shortcut");
  assert.match(src, /<kbd[\s\S]*?\/\s*<\/kbd>/, "must render a visible kbd hint inside the filter box");
});
