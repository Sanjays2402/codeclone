// /r/<id> "download json" wiring.
//
// Pins the public share viewer's one-click JSON download so consumers of a
// shared comparison can ingest the raw record (snippets, scores, alignment,
// clone label) into their own tooling without screen-scraping the page or
// running the PDF through OCR. Source-level so it runs with the same
// node --test rig as the rest of the suite, no jsdom required, and so it
// dodges the well-known "route.ts imports next/server" problem that
// blocks loading App Router route handlers under raw node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("public share page exposes a download-json button next to the pdf button", async () => {
  const src = await read("app/r/[id]/page.tsx");
  assert.match(src, /download json/, "must label the button so users find it");
  assert.match(src, /BracketsCurly/, "must use the BracketsCurly icon to signal JSON");
  assert.match(
    src,
    /href=\{`\/api\/share\/\$\{id\}\?download=1`\}/,
    "must point at the share JSON endpoint with the download flag",
  );
  assert.match(
    src,
    /download=\{`codeclone-share-\$\{id\}\.json`\}/,
    "must request a sensible filename on the client",
  );
  // The pdf button must still be present so we did not regress an
  // existing affordance.
  assert.match(src, /download pdf/, "pdf download must remain alongside the new json button");
});

test("share GET route opts into a download-as-attachment branch on ?download=1", async () => {
  const src = await read("app/api/share/[id]/route.ts");
  // The download branch must read the query string off the actual
  // request (so the existing _req parameter rename is intentional)
  // and must set both Content-Disposition: attachment and a stable
  // codeclone-share-<id>.json filename so `curl -OJ` (and the
  // anchor's download attribute) drop a real file.
  assert.match(src, /download === "1"/, "must accept ?download=1");
  assert.match(
    src,
    /content-disposition[^\n]*attachment;\s*filename="codeclone-share-\$\{id\}\.json"/i,
    "must set Content-Disposition: attachment with a sensible filename",
  );
  assert.match(src, /"cache-control":\s*"no-store"/, "must not let intermediaries cache the download");
  // The plain GET behavior must be preserved so existing programmatic
  // readers do not regress to forced-download responses.
  assert.match(src, /return NextResponse\.json\(rec\);/, "plain GET must still return JSON without attachment headers");
});
