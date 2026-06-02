// /r/<id> "download md" wiring.
//
// Pins the public share viewer's one-click Markdown download so a
// reviewer who only has the public share link can drop a clean PR /
// ticket / Slack summary without having to re-run the comparison
// locally or screen-scrape the page. Source-level so it runs with
// the same node --test rig as the rest of the suite, no jsdom or
// next runtime needed, and so it dodges the well-known "route.ts
// imports next/server" problem that blocks loading App Router route
// handlers under raw node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildShareMarkdown } from "../lib/share-markdown.ts";
import type { ShareRecord } from "../lib/share.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("public share page exposes a download-md button next to the json/pdf buttons", async () => {
  const src = await read("app/r/[id]/page.tsx");
  assert.match(src, /download md/, "must label the button so users find it");
  assert.match(src, /MarkdownLogo/, "must use the MarkdownLogo icon to signal Markdown");
  assert.match(
    src,
    /href=\{`\/api\/share\/\$\{id\}\?format=md&download=1`\}/,
    "must point at the share endpoint with format=md and the download flag",
  );
  assert.match(
    src,
    /download=\{`codeclone-share-\$\{id\}\.md`\}/,
    "must request a sensible .md filename on the client",
  );
  // The pre-existing json and pdf buttons must still be present so we
  // did not regress those affordances when adding the md one.
  assert.match(src, /download json/, "json download must remain alongside the new md button");
  assert.match(src, /download pdf/, "pdf download must remain alongside the new md button");
});

test("share GET route serves a markdown branch on ?format=md", async () => {
  const src = await read("app/api/share/[id]/route.ts");
  assert.match(src, /format === "md"/, "must accept ?format=md");
  assert.match(src, /buildShareMarkdown\(rec\)/, "must build the report from the loaded record");
  assert.match(
    src,
    /content-type[^\n]*text\/markdown;\s*charset=utf-8/i,
    "must serve a text/markdown content type",
  );
  assert.match(
    src,
    /content-disposition[^\n]*attachment;\s*filename="codeclone-share-\$\{id\}\.md"/i,
    "must set Content-Disposition: attachment with a sensible .md filename when ?download=1",
  );
  assert.match(src, /"cache-control":\s*"no-store"/, "must not let intermediaries cache the download");
  // The plain GET behavior and the json download branch must still
  // be there so existing programmatic readers do not regress.
  assert.match(src, /return NextResponse\.json\(rec\);/, "plain GET must still return JSON");
  assert.match(src, /download === "1"/, "json ?download=1 branch must remain");
});

function fakeRecord(overrides: Partial<ShareRecord> = {}): ShareRecord {
  const base: ShareRecord = {
    v: 3,
    id: "shr_test123",
    createdAt: Date.UTC(2025, 0, 15, 12, 30, 0),
    language: "javascript",
    a: "function add(x, y) { return x + y; }",
    b: "function add(a, b) { return a + b; }",
    result: {
      language: "javascript",
      method: "shingle-jaccard",
      latency_ms: 4.25,
      bytes: { a: 36, b: 36 },
      scores: {
        shingleJaccard: 0.872,
        tokenJaccard: 0.5,
        containment: 0.9,
        shared: { shingles: 28, tokens: 6 },
        size: { aShingles: 32, bShingles: 32, aTokens: 10, bTokens: 10 },
        matchedTokens: ["add", "return"],
      } as ShareRecord["result"]["scores"],
      alignment: { rows: [], summary: { matched: 0, addedA: 0, addedB: 0 } } as unknown as ShareRecord["result"]["alignment"],
      clone: { type: "type-2", label: "near duplicate", confidence: 0.91 } as ShareRecord["result"]["clone"],
    },
  };
  return { ...base, ...overrides };
}

test("buildShareMarkdown emits a paste-ready report with scores, snippets, and share id", () => {
  const md = buildShareMarkdown(fakeRecord());
  assert.match(md, /^# codeclone comparison/m, "must start with a top-level heading");
  assert.match(md, /share: `\/r\/shr_test123`/, "must cite the share id so the report is traceable");
  assert.match(md, /clone: \*\*near duplicate\*\*/, "must surface the clone verdict");
  assert.match(md, /\| shingle jaccard \(5-gram\) \| 87\.2% \|/, "must render shingle jaccard as a percentage");
  assert.match(md, /\| token jaccard \| 50\.0% \|/, "must render token jaccard");
  assert.match(md, /\| containment \(min-side\) \| 90\.0% \|/, "must render containment");
  assert.match(md, /## shared identifiers \(2\)/, "must list shared identifiers when present");
  assert.match(md, /`add`, `return`/, "must format identifiers as inline code");
  assert.match(md, /```javascript\nfunction add\(x, y\)/, "must fence snippet A with the language");
  assert.match(md, /```javascript\nfunction add\(a, b\)/, "must fence snippet B with the same language");
});

test("buildShareMarkdown surfaces optional title and tags when set", () => {
  const md = buildShareMarkdown(
    fakeRecord({ title: "case-2025-0142", tags: ["soc2", "ci"] }),
  );
  assert.match(md, /- title: case-2025-0142/, "must surface the saved title");
  assert.match(md, /- tags: `soc2`, `ci`/, "must surface tags as inline code");
});

test("buildShareMarkdown omits the language hint on the fence when language is auto", () => {
  const md = buildShareMarkdown(fakeRecord({ language: "auto" }));
  assert.match(md, /```\nfunction add\(x, y\)/, "auto-language must drop the fence hint");
  assert.doesNotMatch(md, /```auto\n/, "must never serialize a literal 'auto' fence language");
});
