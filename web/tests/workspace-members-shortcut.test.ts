// Workspace detail page member filter + keyboard shortcut wiring.
// Pins the "/" focus-search shortcut on /workspaces/[id] so an owner triaging
// a large team can jump straight to the member filter without reaching for
// the mouse, matching the convention already live on /workspaces, /snippets,
// /history, /api-keys, /webhooks, /models, /notifications, /collections,
// /pairs, and /audit. Source-level so it runs with the same node --test rig
// the rest of the suite uses, no jsdom required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("workspace detail page filters members by email, role, and status", async () => {
  const src = await read("app/workspaces/[id]/page.tsx");
  assert.match(src, /const \[memberQuery, setMemberQuery\] = useState\(""\)/, "must hold a filter query in state");
  assert.match(src, /const filteredMembers =/, "must derive the filtered member list");
  assert.match(src, /m\.email.*m\.role.*m\.status/, "filter haystack must cover email, role, and status");
  assert.match(src, /filteredMembers\.map\(/, "rendered list must come from the filtered slice, not the raw members array");
  assert.match(src, /No members match the filter/, "must show a dedicated empty state when the filter excludes everything");
});

test("workspace detail page binds a global / shortcut that focuses the member filter", async () => {
  const src = await read("app/workspaces/[id]/page.tsx");
  assert.match(src, /memberSearchRef\s*=\s*useRef<HTMLInputElement \| null>\(null\)/, "must hold a ref to the member search input");
  assert.match(src, /ref=\{memberSearchRef\}/, "must attach the ref to the search input");
  assert.match(src, /addEventListener\("keydown"/, "must register a keydown listener");
  assert.match(src, /removeEventListener\("keydown"/, "must clean up the listener");
  assert.match(src, /e\.key !== "\/"/, "must gate on the / key");
  assert.match(src, /e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey/, "must ignore modifier combos so it does not steal browser shortcuts");
  assert.match(src, /tag === "INPUT" \|\| tag === "TEXTAREA" \|\| tag === "SELECT"/, "must not hijack a literal / typed in another field");
  assert.match(src, /isContentEditable/, "must not hijack a literal / in contenteditable surfaces");
  assert.match(src, /el\.focus\(\);\s*\n\s*el\.select\(\)/, "must focus and select the existing query for fast overwrite");
});

test("workspace member filter box advertises the / shortcut", async () => {
  const src = await read("app/workspaces/[id]/page.tsx");
  assert.match(src, /aria-keyshortcuts="\/"/, "must expose the shortcut to assistive tech");
  assert.match(src, /title="Press \/ to focus search"/, "must show a tooltip with the shortcut");
  assert.match(src, /<kbd[\s\S]*?\/\s*<\/kbd>/, "must render a visible kbd hint inside the filter box");
});
