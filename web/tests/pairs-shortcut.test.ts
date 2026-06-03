// Pairs page keyboard shortcut wiring.
// Pins the "/" focus-search shortcut on /pairs so power users can jump to
// the filter box without reaching for the mouse, matching the convention used
// by GitHub, Linear, and Slack (and the same shortcut already live on
// /history, /snippets, and /collections). Source-level so it runs with the
// same node --test rig the rest of the suite uses, no jsdom required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("pairs filter bar binds a global / shortcut that focuses the search input", async () => {
  const src = await read("components/PairsFilterBar.tsx");
  assert.match(src, /^"use client";/, "must be a client component to use keydown listeners");
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

test("pairs filter bar advertises the / shortcut", async () => {
  const src = await read("components/PairsFilterBar.tsx");
  assert.match(src, /aria-keyshortcuts="\/"/, "must expose the shortcut to assistive tech");
  assert.match(src, /title="Press \/ to focus search"/, "must show a tooltip with the shortcut");
  assert.match(src, /<kbd[\s\S]*?\/\s*<\/kbd>/, "must render a visible kbd hint inside the search box");
});

test("pairs page mounts the client filter bar in place of the inline form", async () => {
  const src = await read("app/pairs/page.tsx");
  assert.match(src, /import PairsFilterBar from "\.\.\/\.\.\/components\/PairsFilterBar"/, "must import the client filter bar");
  assert.match(src, /<PairsFilterBar defaultQ=\{q\} defaultLang=\{lang\}/, "must render the filter bar with the current query state");
  assert.doesNotMatch(src, /<form className="mb-4 flex items-center gap-2" action="\/pairs">/, "must not keep the old inline form once the client bar is wired");
});
