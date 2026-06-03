// API keys page filter + keyboard shortcut wiring.
//
// Pins the label/prefix free-text filter and the active/revoked/expired
// status filter added to /api-keys, plus the global "/" focus-search
// shortcut so power users with many keys can jump to the filter box
// without reaching for the mouse, matching the convention already live
// on /history, /snippets, /collections, /pairs, /audit, and /models.
//
// Also pins that the "Download CSV" link forwards the active q and status
// filters so an admin who narrowed the on-screen list to revoked keys
// (for a SOC2 rotation review) gets that exact slice in their spreadsheet,
// not the unfiltered inventory; and that the route applies the same
// filters before serializing CSV.
//
// Source-level so it runs with the same node --test rig the rest of the
// suite uses, no jsdom required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("api-keys page binds a global / shortcut that focuses the filter input", async () => {
  const src = await read("app/api-keys/page.tsx");
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

test("api-keys page advertises the / shortcut", async () => {
  const src = await read("app/api-keys/page.tsx");
  assert.match(src, /aria-keyshortcuts="\/"/, "must expose the shortcut to assistive tech");
  assert.match(src, /title="Press \/ to focus search"/, "must show a tooltip with the shortcut");
  assert.match(src, /<kbd[\s\S]*?\/\s*<\/kbd>/, "must render a visible kbd hint inside the search box");
});

test("api-keys page filters the on-screen list by label/prefix and status", async () => {
  const src = await read("app/api-keys/page.tsx");
  assert.match(src, /Filter by label or prefix/, "must offer a free-text filter on label/prefix");
  assert.match(src, /KeyStatusFilter/, "must declare a key status filter type");
  // status filter options
  for (const opt of ["all", "active", "revoked", "expired"]) {
    assert.match(src, new RegExp(`<option value="${opt}">`), `must offer ${opt} in the status filter`);
  }
  // filtered list is what we render
  assert.match(src, /filtered\.map\(\(k\) =>/, "must render the filtered list, not the raw items");
  // empty state for filtered-out
  assert.match(src, /No keys match the filter\./, "must render a filter-empty hint when nothing matches");
});

test("api-keys page forwards active filters to the CSV download link", async () => {
  const src = await read("app/api-keys/page.tsx");
  // CSV href is computed from q + statusFilter
  assert.match(src, /csvHref\s*=\s*useMemo/, "must memoize the CSV href so it tracks the active filters");
  assert.match(src, /sp\.set\("q", needle\)|extra\.set\("q", needle\)/, "must forward the active q filter into the CSV link");
  assert.match(src, /sp\.set\("status", statusFilter\)|extra\.set\("status", statusFilter\)/, "must forward the active status filter into the CSV link");
  assert.match(src, /href=\{csvHref\}/, "the Download CSV link must read the memoized href");
});

test("/api/api-keys route applies q + status filters before serializing CSV", async () => {
  const src = await read("app/api/api-keys/route.ts");
  assert.match(src, /url\.searchParams\.get\("q"\)/, "route must read the q query param");
  assert.match(src, /url\.searchParams\.get\("status"\)/, "route must read the status query param");
  assert.match(
    src,
    /statusRaw === "active" \|\| statusRaw === "revoked" \|\| statusRaw === "expired"/,
    "route must validate the status filter against the allowed enum",
  );
  // active branch must exclude both revoked and expired
  assert.match(
    src,
    /statusFilter === "active" && \(k\.revoked === true \|\| k\.expired === true\)/,
    "active filter must exclude both revoked and expired keys",
  );
  // expired branch must not double-count revoked keys
  assert.match(
    src,
    /statusFilter === "expired" && !\(k\.expired === true && k\.revoked !== true\)/,
    "expired filter must not include revoked-and-expired keys",
  );
  // CSV path uses the filtered list (not the raw inventory)
  assert.match(src, /keysToCsv\(items\)/, "CSV must serialize the filtered items array");
  assert.match(src, /const all = await listKeys/, "must keep the unfiltered list available for the audit row");
  assert.match(src, /total: all\.length/, "audit row must record both the returned count and the unfiltered total");
});
