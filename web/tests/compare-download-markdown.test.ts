// Compare page "download md" button wiring.
// Pins the client-side Markdown export on /compare so users can paste a
// comparison summary (scores, clone verdict, matched tokens, fenced
// snippets) directly into a PR description, code-review comment, ticket,
// or Slack thread without minting a public /r/<id> share link. Source-level
// so it runs with the same node --test rig the rest of the suite uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("compare page exposes a download-markdown button on the result", async () => {
  const src = await read("app/compare/page.tsx");
  assert.match(src, /onClick=\{downloadMarkdown\}/, "must wire the button to the downloadMarkdown handler");
  assert.match(src, /download md/, "must label the button so users find it");
});

test("downloadMarkdown builds a Markdown report with scores, clone verdict, and fenced snippets", async () => {
  const src = await read("app/compare/page.tsx");
  assert.match(src, /const downloadMarkdown = useCallback\(/, "must define a stable downloadMarkdown callback");
  assert.match(src, /# codeclone comparison/, "must include a top-level heading so the report is readable when pasted");
  assert.match(src, /## scores/, "must include the scores section");
  assert.match(src, /shingle jaccard \(5-gram\)/, "must surface the primary metric in the table");
  assert.match(src, /token jaccard/, "must surface token jaccard in the table");
  assert.match(src, /containment \(min-side\)/, "must surface containment in the table");
  assert.match(src, /## snippet A/, "must include snippet A under its own heading");
  assert.match(src, /## snippet B/, "must include snippet B under its own heading");
  assert.match(src, /"```" \+ fence/, "must open a fenced code block tagged with the language so PR renderers highlight it");
  assert.match(src, /type: "text\/markdown"/, "must set the Markdown MIME type so browsers handle it correctly");
  assert.match(src, /URL\.createObjectURL\(blob\)/, "must create an object URL for the download anchor");
  assert.match(src, /URL\.revokeObjectURL\(url\)/, "must release the object URL after the click");
  assert.match(src, /link\.download = `codeclone-compare-\$\{stamp\}\.md`/, "must use a timestamped, namespaced filename");
});

test("downloadMarkdown is a no-op until a comparison has been run", async () => {
  const src = await read("app/compare/page.tsx");
  // Both download handlers must early-return when result is null so users
  // can't download an empty/placeholder file by tabbing to a hidden control.
  const mdIdx = src.indexOf("const downloadMarkdown");
  assert.ok(mdIdx > 0, "downloadMarkdown must be defined");
  const tail = src.slice(mdIdx, mdIdx + 200);
  assert.match(tail, /if \(!result\) return;/, "downloadMarkdown must early-return when no result is loaded");
});
