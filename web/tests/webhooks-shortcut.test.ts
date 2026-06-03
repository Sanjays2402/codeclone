// /webhooks page filter + keyboard shortcut wiring.
//
// Pins the free-text label/url filter and status dropdown (all/active/paused)
// on /webhooks plus the global "/" shortcut that focuses the filter box,
// matching the convention already live on /history, /snippets, /collections,
// /pairs, /audit, /models, /api-keys, and /notifications. Also pins that the
// Download CSV link forwards the active q and status filters so an operator
// who narrowed to e.g. paused endpoints gets that slice in the spreadsheet
// (and that the /api/webhooks server route honors and audits those filters).
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

test("/webhooks page binds a global / shortcut that focuses the filter input", async () => {
  const src = await read("app/webhooks/page.tsx");
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

test("/webhooks filter input advertises the / shortcut", async () => {
  const src = await read("app/webhooks/page.tsx");
  assert.match(src, /aria-keyshortcuts="\/"/, "must expose the shortcut to assistive tech");
  assert.match(src, /title="Press \/ to focus search"/, "must show a tooltip with the shortcut");
  assert.match(src, /aria-label="Filter webhooks by label or url"/, "must label the filter input");
});

test("/webhooks page filters items by label and url case-insensitively", async () => {
  const src = await read("app/webhooks/page.tsx");
  assert.match(src, /q\.trim\(\)\.toLowerCase\(\)/, "must lowercase the needle");
  assert.match(src, /\(w\.label \+ " " \+ w\.url\)\.toLowerCase\(\)/, "must search label and url");
  // Status dropdown options
  assert.match(src, /<option value="all">all<\/option>/);
  assert.match(src, /<option value="active">active<\/option>/);
  assert.match(src, /<option value="paused">paused<\/option>/);
  // Render uses filteredItems, empty state when nothing matches.
  assert.match(src, /filteredItems\.map\(/, "must render the filtered list");
  assert.match(src, /No webhooks match the filter\./, "must show an empty state for an empty filter result");
});

test("/webhooks CSV link forwards q and status to /api/webhooks", async () => {
  const src = await read("app/webhooks/page.tsx");
  // Keep the workspace-scoped CSV path stable for the existing csv test.
  assert.match(
    src,
    /\/api\/webhooks\?workspaceId=\$\{encodeURIComponent\(activeWs\)\}&format=csv/,
    "CSV link must keep the workspace-scoped /api/webhooks?...&format=csv base",
  );
  assert.match(src, /extra\.set\("q", needle\)/, "must forward the active q filter");
  assert.match(src, /extra\.set\("status", statusFilter\)/, "must forward the active status filter");
});

test("/api/webhooks route honors and validates q and status", async () => {
  const src = await read("app/api/webhooks/route.ts");
  assert.match(src, /searchParams\.get\("q"\)/, "must read the q query param");
  assert.match(src, /searchParams\.get\("status"\)/, "must read the status query param");
  assert.match(
    src,
    /status must be 'all' \(default\), 'active', or 'paused'/,
    "must reject unknown status values with a 400",
  );
  assert.match(src, /\(w\.label \+ " " \+ w\.url\)\.toLowerCase\(\)/, "must filter on label and url");
  // Filter is applied before serializing CSV (otherwise the slice would not match the UI).
  assert.match(src, /webhooksToCsv\(filteredItems\)/, "CSV must serialize the filtered slice");
});

test("/api/webhooks read audit records the filter context for SOC2 evidence", async () => {
  const src = await read("app/api/webhooks/route.ts");
  // Audit meta carries the filtered count, the unfiltered total, the active q,
  // and the status filter so a reviewer can reconstruct what the operator
  // was looking at when they exported.
  assert.match(src, /count:\s*filteredItems\.length/);
  assert.match(src, /total:\s*items\.length/);
  assert.match(src, /q:\s*needle \|\| undefined/);
  assert.match(src, /statusFilter,/);
});
