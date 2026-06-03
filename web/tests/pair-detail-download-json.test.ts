// /pairs/[id] "Download JSON" button wiring.
//
// The pair detail page is where a researcher reviewing a flagged clone pair
// inspects the prefix, completion, similarity, and per-block alignment. The
// natural follow-up is "save this exact record" so it can be attached to a
// ticket, diffed against another corpus, or replayed locally. The dashboard
// already exposes the raw payload at GET /api/pairs/[id]; this pins a plain
// <a download> on top of that endpoint so the button is always one click
// away from the diff viewer and does not regress to a copy-paste workflow.
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

test("pair detail page exposes a Download JSON button on the header", async () => {
  const src = await read("app/pairs/[id]/page.tsx");
  assert.match(src, /Download JSON/, "must label the button so users find it next to the diff");
  assert.match(src, /DownloadSimple/, "must use the DownloadSimple icon to match the rest of the dashboard");
  assert.match(src, /import \{ DownloadSimple \} from "@phosphor-icons\/react\/dist\/ssr"/);
});

test("Download JSON button points at the existing /api/pairs/[id] endpoint", async () => {
  const src = await read("app/pairs/[id]/page.tsx");
  // The endpoint already returns the full pair record as JSON; we just want
  // a browser download instead of an in-tab render, so the href must be the
  // existing route and the anchor must carry a download attribute.
  assert.match(src, /const jsonHref = `\/api\/pairs\/\$\{encodeURIComponent\(pair\.id\)\}`/, "must build the href from the pair id, encoded for path safety");
  assert.match(src, /href=\{jsonHref\}/);
  assert.match(src, /download=\{jsonName\}/, "must set the download attribute so the file saves instead of navigating");
});

test("Download JSON filename is namespaced and stable per pair", async () => {
  const src = await read("app/pairs/[id]/page.tsx");
  // Filename must include the codeclone namespace and the short pair hash so
  // a researcher saving several pairs to disk doesn't end up with a folder
  // full of identically named downloads.
  assert.match(src, /const jsonName = `codeclone-pair-\$\{shortHash\(pair\.id, 12\)\}\.json`/);
});

test("API route at /api/pairs/[id] still returns the raw pair payload", async () => {
  const src = await read("app/api/pairs/[id]/route.ts");
  // Guard against the API contract drifting; the download button leans on
  // this route returning a JSON body of the pair (not a wrapped envelope),
  // so flag any regression that changes the response shape.
  assert.match(src, /export async function GET/);
  assert.match(src, /loadPair\(id\)/);
  assert.match(src, /return NextResponse\.json\(pair\)/, "route must return the pair record directly so the download is a self-contained JSON file");
});
