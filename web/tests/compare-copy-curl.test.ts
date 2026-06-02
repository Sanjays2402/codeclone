// Compare page "copy curl" button wiring.
// Pins the client-side clipboard copy of a runnable cURL command on /compare
// so a dev who sees an interesting result in the dashboard can hand off the
// exact comparison to a terminal, a CI step, or a bug report without
// retyping the snippets. Mirrors the copy-json/copy-md tests for the same
// page so the surface stays consistent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("compare page exposes a copy-curl button on the result", async () => {
  const src = await read("app/compare/page.tsx");
  assert.match(src, /onClick=\{copyCurl\}/, "must wire the button to the copyCurl handler");
  assert.match(src, /copy curl/, "must label the button so users find it");
  assert.match(src, /aria-label="Copy cURL command to clipboard"/, "must expose an a11y label for screen readers");
});

test("copyCurl writes the built curl command to the clipboard", async () => {
  const src = await read("app/compare/page.tsx");
  assert.match(src, /const copyCurl = useCallback\(/, "must define a stable copyCurl callback");
  assert.match(src, /await navigator\.clipboard\.writeText\(cmd\)/, "must actually write the curl command");
  assert.match(src, /setCurlCopied\(true\)/, "must flip the copied flag for visual confirmation");
  assert.match(src, /setTimeout\(\(\) => setCurlCopied\(false\), 1400\)/, "must reset the copied flag so the button does not stick");
});

test("copyCurl is a no-op until a comparison has been run", async () => {
  const src = await read("app/compare/page.tsx");
  const idx = src.indexOf("const copyCurl");
  assert.ok(idx > 0, "copyCurl must be defined");
  const tail = src.slice(idx, idx + 200);
  assert.match(tail, /if \(!result\) return;/, "copyCurl must early-return when no result is loaded");
});

test("copyCurl surfaces clipboard failures instead of swallowing them", async () => {
  const src = await read("app/compare/page.tsx");
  // Blocked clipboard (insecure context, denied permission, missing API) is
  // a real failure mode; silently doing nothing leaves the user thinking
  // the copy worked. Pin the visible error surface.
  assert.match(src, /setCurlCopyError\(/, "must capture a copy error in state");
  assert.match(src, /copy failed: \{curlCopyError\}/, "must render the error inline so the user sees the failure");
});

test("buildCurlCommand targets POST /v1/compare with a bearer placeholder", async () => {
  const src = await read("app/compare/page.tsx");
  assert.match(src, /const buildCurlCommand = useCallback\(/, "must define a shared curl builder");
  // Must hit the public versioned compare endpoint, not the internal /api/compare.
  assert.match(src, /\/v1\/compare/, "must target the public /v1/compare endpoint");
  // Never serialize a real key into the clipboard; require an env-var placeholder.
  assert.match(src, /\$CODECLONE_API_KEY/, "must use the CODECLONE_API_KEY env-var placeholder, not a real key");
  assert.match(src, /Content-Type: application\/json/, "must declare the JSON content type");
});

test("buildCurlCommand omits the language field when set to auto", async () => {
  const src = await read("app/compare/page.tsx");
  const idx = src.indexOf("const buildCurlCommand");
  assert.ok(idx > 0, "buildCurlCommand must be defined");
  const body = src.slice(idx, idx + 1200);
  // "auto" is a UI hint, not an API value. Send only when the user picked
  // a concrete language so the server's tokenizer auto-detect can run.
  assert.match(body, /language\s*!==\s*"auto"/, "must skip the language field when the picker is on auto");
});
