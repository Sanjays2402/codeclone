// Sessions page filter + keyboard shortcut wiring.
//
// Pins the browser/OS/IP free-text filter added to /settings/sessions and
// the global "/" focus-search shortcut so an admin reviewing a long device
// list can jump to the filter box without reaching for the mouse, matching
// the convention already live on /history, /snippets, /collections,
// /pairs, /audit, /models, /api-keys, /notifications, /webhooks,
// /workspaces, /eval, and /usage.
//
// Also pins that the "Download CSV" link forwards the active q filter so
// an admin who narrowed the on-screen list (e.g. one office IP range)
// gets that exact slice in their spreadsheet, not the unfiltered roster;
// and that the /api/sessions route applies the same filter before
// serializing CSV and records the q + total in the audit row.
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

test("sessions page binds a global / shortcut that focuses the filter input", async () => {
  const src = await read("app/settings/sessions/page.tsx");
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

test("sessions page advertises the / shortcut", async () => {
  const src = await read("app/settings/sessions/page.tsx");
  assert.match(src, /aria-keyshortcuts="\/"/, "must expose the shortcut to assistive tech");
  assert.match(src, /title="Press \/ to focus search"/, "must show a tooltip with the shortcut");
  assert.match(src, /<kbd[\s\S]*?\/\s*<\/kbd>/, "must render a visible kbd hint inside the search box");
});

test("sessions page filters the on-screen device list by browser/OS/IP", async () => {
  const src = await read("app/settings/sessions/page.tsx");
  assert.match(src, /Filter by browser, OS, or IP/, "must offer a free-text filter on browser/OS/IP");
  assert.match(src, /filteredSessions\s*=\s*useMemo/, "must memoize the filtered session list");
  assert.match(src, /filteredSessions\.map\(\(s\) =>/, "must render the filtered list, not the raw session array");
  assert.match(src, /No sessions match the filter\./, "must render a filter-empty hint when nothing matches");
});

test("sessions page forwards the active filter to the CSV download link", async () => {
  const src = await read("app/settings/sessions/page.tsx");
  assert.match(src, /csvHref\s*=\s*useMemo/, "must memoize the CSV href so it tracks the active filter");
  assert.match(src, /encodeURIComponent\(needle\)/, "must url-encode the q value forwarded to the CSV link");
  assert.match(src, /href=\{csvHref\}/, "the Download CSV link must read the memoized href");
});

test("/api/sessions route applies the q filter before serializing CSV", async () => {
  const src = await read("app/api/sessions/route.ts");
  assert.match(src, /url\.searchParams\.get\("q"\)/, "route must read the q query param");
  // Filter only kicks in for CSV so the JSON shape and currentJti resolution
  // stay intact for the dashboard, which does its own client-side filtering
  // against the unfiltered source of truth.
  assert.match(src, /needle && format === "csv"/, "q filter must only apply to the CSV export, not the JSON response");
  assert.match(src, /sessionsToCsv\(rows\)/, "CSV must serialize the (possibly filtered) rows array");
  assert.match(src, /total: allRows\.length/, "audit row must record the unfiltered total alongside the returned count");
  assert.match(src, /q: needle \|\| undefined/, "audit row must record the q filter (or undefined when absent)");
});
