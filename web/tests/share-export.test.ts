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

test("exportShares: honors language, cloneLabel, minScore, maxScore filters", async () => {
  // Two shares already created above (python, j=0.9 + 0.1). Add a JS one.
  const jsResult = {
    language: "javascript",
    scores: { shingleJaccard: 0.5, tokenJaccard: 0.5, containment: 0.6 },
    alignment: { rows: [] },
    clone: {
      label: "Type-3",
      confidence: 0.7,
      structuralSim: 0.5,
      rawTokenSim: 0.6,
      rationale: [],
    },
    bytes: { a: 10, b: 12 },
    latency_ms: 1,
    method: "test",
  } as any;
  await createShare({
    a: "const x = 1;\n",
    b: "const y = 1;\n",
    language: "javascript",
    result: jsResult,
  });

  // language=python should drop the JS row.
  const pyOnly = await exportShares({ format: "json", language: "python" });
  const pyParsed = JSON.parse(pyOnly.body);
  assert.ok(pyParsed.count >= 2);
  for (const it of pyParsed.items) assert.equal(it.language, "python");

  // language=all is a no-op (UI sentinel).
  const allLangs = await exportShares({ format: "json", language: "all" });
  assert.ok(JSON.parse(allLangs.body).count >= pyParsed.count + 1);

  // cloneLabel filter narrows by label.
  const t3 = await exportShares({ format: "json", cloneLabel: "Type-3" });
  const t3Parsed = JSON.parse(t3.body);
  assert.equal(t3Parsed.count, 1);
  assert.equal(t3Parsed.items[0].cloneLabel, "Type-3");

  // minScore drops the low-similarity row.
  const hi = await exportShares({ format: "json", minScore: 0.8 });
  const hiParsed = JSON.parse(hi.body);
  assert.ok(hiParsed.count >= 1);
  for (const it of hiParsed.items) assert.ok(it.shingleJaccard >= 0.8);

  // maxScore drops the high-similarity row.
  const lo = await exportShares({ format: "json", maxScore: 0.2 });
  const loParsed = JSON.parse(lo.body);
  assert.ok(loParsed.count >= 1);
  for (const it of loParsed.items) assert.ok(it.shingleJaccard <= 0.2);
});
