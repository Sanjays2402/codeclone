/**
 * Run with: node --test --experimental-strip-types web/tests/share-export.test.ts
 *
 * Black-box test for the bulk history exporter (CSV + JSON).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-shares-export-"));
process.env.CODECLONE_SHARES_DIR = tmp;

const { createShare, exportShares } = await import("../lib/share.ts");

function fakeResult(j = 0.42) {
  return {
    language: "python",
    scores: { shingleJaccard: j, tokenJaccard: 0.5, containment: 0.6 },
    alignment: { rows: [] },
    clone: {
      label: "Type-2",
      confidence: 0.7,
      structuralSim: 0.5,
      rawTokenSim: 0.6,
      rationale: [],
    },
    bytes: { a: 10, b: 12 },
    latency_ms: 1,
    method: "test",
  } as any;
}

test("exportShares: CSV has header + one row per share, properly quoted", async () => {
  const a = await createShare({
    a: "def f():\n  return 1\n",
    b: "def g():\n  return 1\n",
    language: "python",
    title: 'Has, comma "and" quote',
    tags: ["alpha"],
    result: fakeResult(0.9),
  });
  await createShare({
    a: "x = 1\n",
    b: "y = 1\n",
    language: "python",
    tags: ["beta"],
    result: fakeResult(0.1),
  });

  const out = await exportShares({ format: "csv", origin: "https://example.test" });
  assert.equal(out.contentType, "text/csv; charset=utf-8");
  assert.equal(out.count, 2);
  const lines = out.body.trim().split("\n");
  assert.equal(lines.length, 3, "header + 2 rows");
  assert.ok(lines[0].startsWith("id,created_at,updated_at,title,language,clone_label"));
  // Find the row for share `a` and assert quoting + url shape
  const row = lines.slice(1).find((l) => l.includes(a.id));
  assert.ok(row, "row for created share present");
  assert.ok(row!.includes('"Has, comma ""and"" quote"'), "title quoted per RFC 4180");
  assert.ok(row!.includes(`https://example.test/r/${a.id}`), "url uses origin");

  // Tag filter narrows the export
  const onlyAlpha = await exportShares({ format: "csv", tag: "alpha" });
  assert.equal(onlyAlpha.count, 1);
});

test("exportShares: JSON shape is stable", async () => {
  const out = await exportShares({ format: "json" });
  assert.equal(out.contentType, "application/json; charset=utf-8");
  const parsed = JSON.parse(out.body);
  assert.equal(typeof parsed.exportedAt, "string");
  assert.equal(parsed.count, parsed.items.length);
  for (const it of parsed.items) {
    assert.equal(typeof it.id, "string");
    assert.equal(typeof it.url, "string");
    assert.ok(it.url.endsWith(`/r/${it.id}`));
  }
});
