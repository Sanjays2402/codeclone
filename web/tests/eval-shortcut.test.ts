// Eval page keyboard shortcut + filter wiring.
// Pins the "/" focus-search shortcut on /eval so MLOps reviewers can jump to
// the filter box without reaching for the mouse, matching the convention
// used by GitHub, Linear, and Slack (and the same shortcut already live on
// /history, /snippets, /collections, /pairs, /audit, /api-keys, /webhooks,
// /notifications, /models, and /workspaces). Source-level so it runs with
// the same node --test rig the rest of the suite uses, no jsdom required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("eval filter bar binds a global / shortcut that focuses the search input", async () => {
  const src = await read("components/EvalFilterBar.tsx");
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

test("eval filter bar advertises the / shortcut", async () => {
  const src = await read("components/EvalFilterBar.tsx");
  assert.match(src, /aria-keyshortcuts="\/"/, "must expose the shortcut to assistive tech");
  assert.match(src, /title="Press \/ to focus search"/, "must show a tooltip with the shortcut");
  assert.match(src, /<kbd[\s\S]*?\/\s*<\/kbd>/, "must render a visible kbd hint inside the search box");
});

test("eval filter bar form posts back to /eval so SSR can re-render the slice", async () => {
  const src = await read("components/EvalFilterBar.tsx");
  assert.match(src, /action="\/eval"/, "must submit back to /eval");
  assert.match(src, /name="q"/, "must expose the free-text filter as q");
  assert.match(src, /name="status"/, "must expose the status filter");
  assert.match(src, /name="backend"/, "must expose the backend filter");
});

test("eval page mounts the client filter bar with the current query state", async () => {
  const src = await read("app/eval/page.tsx");
  assert.match(src, /import EvalFilterBar from "\.\.\/\.\.\/components\/EvalFilterBar"/, "must import the client filter bar");
  assert.match(src, /<EvalFilterBar[\s\S]*defaultQ=\{q\}[\s\S]*defaultStatus=\{status\}[\s\S]*defaultBackend=\{backend\}/, "must render the filter bar with the current query state");
});

test("eval page filters the run list by q, status, and backend", async () => {
  const src = await read("app/eval/page.tsx");
  assert.match(src, /sp\.q\?\.trim\(\)/, "must read q from the search params");
  assert.match(src, /sp\.status\?\.trim\(\)/, "must read status from the search params");
  assert.match(src, /sp\.backend\?\.trim\(\)/, "must read backend from the search params");
  assert.match(src, /ALLOWED_STATUS\.has\(statusParam\)/, "must validate status against the allowed set so a bad value cannot crash the page");
  assert.match(src, /No runs match the filter/, "must show a dedicated empty state when filters exclude everything");
});

test("eval page preserves active filters in the CSV download link", async () => {
  const src = await read("app/eval/page.tsx");
  assert.match(src, /q\s*\?\s*`&q=\$\{encodeURIComponent\(q\)\}`/, "must forward q to the CSV export");
  assert.match(src, /status\s*\?\s*`&status=\$\{encodeURIComponent\(status\)\}`/, "must forward status to the CSV export");
  assert.match(src, /backend\s*\?\s*`&backend=\$\{encodeURIComponent\(backend\)\}`/, "must forward backend to the CSV export");
  assert.match(src, /\/api\/runs\?format=csv/, "must keep the existing CSV endpoint URL");
});

test("runs CSV route honors the q free-text filter", async () => {
  const src = await read("app/api/runs/route.ts");
  assert.match(src, /searchParams\.get\("q"\)/, "must read the q query param");
  assert.match(src, /id\.includes\(qFilter\)/, "must match run id substring");
  assert.match(src, /recipe\.includes\(qFilter\)/, "must also match recipe hash substring");
  assert.match(src, /model\.includes\(qFilter\)/, "must also match model substring");
});
