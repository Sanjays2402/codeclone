// Compare page "copy json" button wiring.
// Pins the client-side JSON clipboard copy on /compare so users sharing a
// raw comparison payload into an internal ticket, a code-review thread, or
// a quick jq inspection can paste directly without routing through a
// downloaded .json file. Mirrors the download-json test but asserts the
// clipboard path and the shared report builder so both surfaces stay
// byte-identical.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("compare page exposes a copy-json button on the result", async () => {
  const src = await read("app/compare/page.tsx");
  assert.match(src, /onClick=\{copyJson\}/, "must wire the button to the copyJson handler");
  assert.match(src, /copy json/, "must label the button so users find it");
  assert.match(src, /aria-label="Copy JSON report to clipboard"/, "must expose an a11y label for screen readers");
});

test("copyJson writes the shared report to the clipboard", async () => {
  const src = await read("app/compare/page.tsx");
  assert.match(src, /const copyJson = useCallback\(/, "must define a stable copyJson callback");
  assert.match(src, /await navigator\.clipboard\.writeText\(json\)/, "must actually write the json payload");
  assert.match(src, /setJsonCopied\(true\)/, "must flip the copied flag for visual confirmation");
  assert.match(src, /setTimeout\(\(\) => setJsonCopied\(false\), 1400\)/, "must reset the copied flag so the button does not stick");
});

test("copyJson is a no-op until a comparison has been run", async () => {
  const src = await read("app/compare/page.tsx");
  const idx = src.indexOf("const copyJson");
  assert.ok(idx > 0, "copyJson must be defined");
  const tail = src.slice(idx, idx + 200);
  assert.match(tail, /if \(!result\) return;/, "copyJson must early-return when no result is loaded");
});

test("copyJson surfaces clipboard failures instead of swallowing them", async () => {
  const src = await read("app/compare/page.tsx");
  // Blocked clipboard (insecure context, denied permission, missing API) is
  // a real failure mode; silently doing nothing leaves the user thinking
  // the copy worked. Pin the visible error surface.
  assert.match(src, /setJsonCopyError\(/, "must capture a copy error in state");
  assert.match(src, /copy failed: \{jsonCopyError\}/, "must render the error inline so the user sees the failure");
});

test("download-json and copy-json share one JSON builder", async () => {
  const src = await read("app/compare/page.tsx");
  // Both surfaces must call the same buildJsonReport helper so a fix
  // to the payload (new field, schema bump) lands on both surfaces at
  // once. Regressing this would let the two outputs drift.
  assert.match(src, /const buildJsonReport = useCallback\(/, "must define a shared builder");
  const dlIdx = src.indexOf("const downloadJson = useCallback(");
  assert.ok(dlIdx > 0, "downloadJson must be defined");
  const dlBody = src.slice(dlIdx, dlIdx + 600);
  assert.match(dlBody, /buildJsonReport\(\)/, "downloadJson must call the shared builder");
  const cpIdx = src.indexOf("const copyJson = useCallback(");
  assert.ok(cpIdx > 0, "copyJson must be defined");
  const cpBody = src.slice(cpIdx, cpIdx + 600);
  assert.match(cpBody, /buildJsonReport\(\)/, "copyJson must call the shared builder");
});
