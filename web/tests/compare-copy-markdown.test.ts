// Compare page "copy md" button wiring.
// Pins the client-side Markdown clipboard copy on /compare so users sharing
// a comparison in a PR, ticket, or Slack thread can paste directly without
// routing through a downloaded .md file. Mirrors the download-md test but
// asserts the clipboard path and the shared report builder so both surfaces
// stay byte-identical.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("compare page exposes a copy-markdown button on the result", async () => {
  const src = await read("app/compare/page.tsx");
  assert.match(src, /onClick=\{copyMarkdown\}/, "must wire the button to the copyMarkdown handler");
  assert.match(src, /copy md/, "must label the button so users find it");
  assert.match(src, /aria-label="Copy Markdown report to clipboard"/, "must expose an a11y label for screen readers");
});

test("copyMarkdown writes the shared report to the clipboard", async () => {
  const src = await read("app/compare/page.tsx");
  assert.match(src, /const copyMarkdown = useCallback\(/, "must define a stable copyMarkdown callback");
  assert.match(src, /navigator\.clipboard\?\.writeText/, "must guard on the async Clipboard API");
  assert.match(src, /await navigator\.clipboard\.writeText\(md\)/, "must actually write the markdown payload");
  assert.match(src, /setMdCopied\(true\)/, "must flip the copied flag for visual confirmation");
  assert.match(src, /setTimeout\(\(\) => setMdCopied\(false\), 1400\)/, "must reset the copied flag so the button does not stick");
});

test("copyMarkdown is a no-op until a comparison has been run", async () => {
  const src = await read("app/compare/page.tsx");
  const idx = src.indexOf("const copyMarkdown");
  assert.ok(idx > 0, "copyMarkdown must be defined");
  const tail = src.slice(idx, idx + 200);
  assert.match(tail, /if \(!result\) return;/, "copyMarkdown must early-return when no result is loaded");
});

test("copyMarkdown surfaces clipboard failures instead of swallowing them", async () => {
  const src = await read("app/compare/page.tsx");
  // Blocked clipboard (insecure context, denied permission, missing API) is
  // a real failure mode and silently doing nothing leaves the user thinking
  // the copy worked. Pin the visible error surface.
  assert.match(src, /setMdCopyError\(/, "must capture a copy error in state");
  assert.match(src, /copy failed: \{mdCopyError\}/, "must render the error inline so the user sees the failure");
  assert.match(src, /Clipboard not available in this browser\./, "must fall back to a clear message when the API is missing");
});

test("download-md and copy-md share one Markdown builder", async () => {
  const src = await read("app/compare/page.tsx");
  // Both surfaces must call the same buildMarkdownReport helper so a fix
  // to the report (new metric, new heading, fenced-block change) lands on
  // both surfaces at once. Regressing this would let the two outputs drift.
  assert.match(src, /const buildMarkdownReport = useCallback\(/, "must define a shared builder");
  const dlIdx = src.indexOf("const downloadMarkdown = useCallback(");
  assert.ok(dlIdx > 0, "downloadMarkdown must be defined");
  const dlBody = src.slice(dlIdx, dlIdx + 600);
  assert.match(dlBody, /buildMarkdownReport\(\)/, "downloadMarkdown must call the shared builder");
  const cpIdx = src.indexOf("const copyMarkdown = useCallback(");
  assert.ok(cpIdx > 0, "copyMarkdown must be defined");
  const cpBody = src.slice(cpIdx, cpIdx + 600);
  assert.match(cpBody, /buildMarkdownReport\(\)/, "copyMarkdown must call the shared builder");
});
