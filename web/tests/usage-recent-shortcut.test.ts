// Usage page Recent API calls filter wiring.
// Pins a client-side endpoint/key filter on the /usage Recent API calls panel
// plus the global "/" focus-search shortcut, matching the convention already
// live on /history, /snippets, /collections, /pairs, /audit, /models,
// /api-keys, /notifications, /webhooks, /workspaces, and /eval. Source-level
// so it runs with the same node --test rig the rest of the suite uses, no
// jsdom required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("usage recent calls panel renders a filter input with a ref", async () => {
  const src = await read("app/usage/page.tsx");
  assert.match(src, /filterInputRef\s*=\s*useRef<HTMLInputElement \| null>\(null\)/, "must hold a ref to the filter input");
  assert.match(src, /ref=\{filterInputRef\}/, "must attach the ref to the filter input");
  assert.match(src, /placeholder="filter endpoint or key"/, "must label the input as endpoint or key filter");
});

test("usage recent calls panel binds a global / shortcut", async () => {
  const src = await read("app/usage/page.tsx");
  assert.match(src, /addEventListener\("keydown"/, "must register a keydown listener");
  assert.match(src, /removeEventListener\("keydown"/, "must clean up the listener");
  assert.match(src, /e\.key !== "\/"/, "must gate on the / key");
  assert.match(src, /e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey/, "must ignore modifier combos so it does not steal browser shortcuts");
  assert.match(src, /tag === "INPUT" \|\| tag === "TEXTAREA" \|\| tag === "SELECT"/, "must not hijack a literal / typed in another field");
  assert.match(src, /isContentEditable/, "must not hijack a literal / in contenteditable surfaces");
  assert.match(src, /el\.focus\(\);\s*\n\s*el\.select\(\)/, "must focus and select the existing query for fast overwrite");
});

test("usage recent calls panel advertises the / shortcut", async () => {
  const src = await read("app/usage/page.tsx");
  assert.match(src, /aria-keyshortcuts="\/"/, "must expose the shortcut to assistive tech");
  assert.match(src, /title="Press \/ to focus search"/, "must show a tooltip with the shortcut");
  assert.match(src, /<kbd[\s\S]*?\/\s*<\/kbd>/, "must render a visible kbd hint inside the search box");
});

test("usage recent calls panel filters events by endpoint and key id", async () => {
  const src = await read("app/usage/page.tsx");
  assert.match(src, /ev\.endpoint\.toLowerCase\(\)\.includes\(ql\)/, "must match endpoint substring");
  assert.match(src, /ev\.keyId\.toLowerCase\(\)\.includes\(ql\)/, "must also match key id substring");
  assert.match(src, /\{ql \? `\$\{filtered\.length\} of \$\{data\.events\.length\}`/, "must show filtered count next to total");
});

test("usage recent calls panel shows an empty state when no events match the filter", async () => {
  const src = await read("app/usage/page.tsx");
  assert.match(src, /data\.events\.length > 0 && filtered\.length === 0/, "must distinguish empty filter result from no events at all");
  assert.match(src, /title="No calls match the filter"/, "must show a clear empty-filter message");
});
