// Datasets page keyboard shortcut wiring.
// Pins the "/" focus-search shortcut on /datasets so power users can jump to
// the language filter box without reaching for the mouse, matching the
// convention used by GitHub, Linear, and Slack (and the same shortcut
// already live on /models, /history, /snippets, /collections, /pairs,
// /audit, /workspaces, /webhooks, /eval, /usage, /notifications, /api-keys,
// and /settings/sessions). Source-level so it runs with the same
// node --test rig the rest of the suite uses, no jsdom required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("datasets filter bar binds a global / shortcut that focuses the search input", async () => {
  const src = await read("components/DatasetsFilterBar.tsx");
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

test("datasets filter bar advertises the / shortcut", async () => {
  const src = await read("components/DatasetsFilterBar.tsx");
  assert.match(src, /aria-keyshortcuts="\/"/, "must expose the shortcut to assistive tech");
  assert.match(src, /title="Press \/ to focus search"/, "must show a tooltip with the shortcut");
  assert.match(src, /<kbd[\s\S]*?\/\s*<\/kbd>/, "must render a visible kbd hint inside the search box");
});

test("datasets page mounts the client filter bar with the current query state", async () => {
  const src = await read("app/datasets/page.tsx");
  assert.match(src, /import DatasetsFilterBar from "\.\.\/\.\.\/components\/DatasetsFilterBar"/, "must import the client filter bar");
  assert.match(src, /<DatasetsFilterBar[\s\S]*defaultQ=\{q\}/, "must render the filter bar with the current query state");
});

test("datasets page filters the language rows by q server-side", async () => {
  const src = await read("app/datasets/page.tsx");
  assert.match(src, /const q = sp\.q\?\.trim\(\) \?\? ""/, "must read the q query param");
  assert.match(src, /lang\.toLowerCase\(\)\.includes\(ql\)/, "must match language name substring");
});

test("datasets page preserves the active filter in the CSV download link", async () => {
  const src = await read("app/datasets/page.tsx");
  assert.match(src, /extraCsvParams\.set\("q", q\)/, "must forward the q filter to the CSV export");
});

test("datasets CSV route honors the q free-text filter", async () => {
  const src = await read("app/api/datasets/route.ts");
  assert.match(src, /searchParams\.get\("q"\)/, "must read the q query param");
  assert.match(src, /lang\.toLowerCase\(\)\.includes\(qFilter\)/, "must match language name substring");
});
