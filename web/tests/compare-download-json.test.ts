// Compare page "download json" button wiring.
// Pins the client-side JSON export on /compare so users can save a
// comparison (inputs + scores + alignment + clone label) without minting
// a public /r/<id> share link. Source-level so it runs with the same
// node --test rig the rest of the suite uses, no jsdom required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("compare page exposes a download-json button on the result", async () => {
  const src = await read("app/compare/page.tsx");
  assert.match(src, /onClick=\{downloadJson\}/, "must wire the button to the downloadJson handler");
  assert.match(src, /download json/, "must label the button so users find it");
  assert.match(src, /DownloadSimple/, "must use the DownloadSimple icon");
});

test("downloadJson builds a JSON blob with inputs, result, and a schema tag", async () => {
  const src = await read("app/compare/page.tsx");
  assert.match(src, /const downloadJson = useCallback\(/, "must define a stable downloadJson callback");
  assert.match(src, /schema: "codeclone\.compare\.result\/v1"/, "must stamp a versioned schema tag so consumers can parse safely");
  assert.match(src, /inputs: \{ a, b, language \}/, "must include the snippets and language so the export is reproducible");
  assert.match(src, /JSON\.stringify\(payload, null, 2\)/, "must pretty-print so the file is human-readable");
  assert.match(src, /type: "application\/json"/, "must set the JSON MIME type so browsers handle it correctly");
  assert.match(src, /URL\.createObjectURL\(blob\)/, "must create an object URL for the download anchor");
  assert.match(src, /URL\.revokeObjectURL\(url\)/, "must release the object URL after the click");
  assert.match(src, /link\.download = `codeclone-compare-\$\{stamp\}\.json`/, "must use a timestamped, namespaced filename");
});

test("downloadJson is a no-op until a comparison has been run", async () => {
  const src = await read("app/compare/page.tsx");
  // The handler must early-return when result is null so users can't
  // download an empty/placeholder file by tabbing to a hidden control.
  assert.match(src, /if \(!result\) return;/, "must early-return when no result is loaded");
});
