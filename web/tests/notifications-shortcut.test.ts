// Notifications page keyboard shortcut + text-search wiring.
// Pins the "/" focus-search shortcut on /notifications so power users can jump
// to the search box from anywhere on a noisy inbox, matching the convention
// used by GitHub, Linear, and Slack (and the same shortcut already live on
// /collections, /history, /snippets, /api-keys, /audit, /pairs, and /models).
// Source-level so it runs with the same node --test rig the rest of the suite
// uses, no jsdom required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("notifications page binds a global / shortcut that focuses the search input", async () => {
  const src = await read("app/notifications/page.tsx");
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

test("notifications search box advertises the / shortcut", async () => {
  const src = await read("app/notifications/page.tsx");
  assert.match(src, /aria-keyshortcuts="\/"/, "must expose the shortcut to assistive tech");
  assert.match(src, /title="Press \/ to focus search"/, "must show a tooltip with the shortcut");
});

test("notifications search filters by title and body case-insensitively", async () => {
  const src = await read("app/notifications/page.tsx");
  // The visible list must apply the text filter on top of the unread filter,
  // matching on title or body, lowercased on both sides.
  assert.match(src, /query\.trim\(\)\.toLowerCase\(\)/, "must lowercase the query");
  assert.match(src, /n\.title.*toLowerCase\(\)\.includes\(q\)/s, "must match the notification title");
  assert.match(src, /n\.body.*toLowerCase\(\)\.includes\(q\)/s, "must match the notification body");
});
