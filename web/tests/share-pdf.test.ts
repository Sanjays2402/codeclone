/**
 * Run with: node --test --experimental-strip-types web/tests/share-pdf.test.ts
 *
 * Validates the PDF report builder produces a non-trivial PDF for a share.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-shares-pdf-"));
process.env.CODECLONE_SHARES_DIR = tmp;

const { createShare } = await import("../lib/share.ts");
const { buildShareReportPdf } = await import("../lib/share-pdf.ts");

function fakeResult(j = 0.62) {
  return {
    language: "python",
    scores: {
      shingleJaccard: j,
      tokenJaccard: 0.55,
      containment: 0.71,
      shared: { tokens: 18, shingles: 9 },
      size: { aTokens: 30, bTokens: 28, aShingles: 22, bShingles: 21 },
      matchedTokens: ["def", "return"],
    },
    alignment: { rows: [] },
    clone: {
      type: "type-2",
      label: "Type-2 clone (renamed)",
      confidence: 0.74,
      structuralSim: 0.81,
      rawTokenSim: 0.55,
      rationale: [
        "Anonymized structural 4-gram Jaccard is high.",
        "Raw token Jaccard suggests identifier renaming.",
      ],
    },
    bytes: { a: 220, b: 232 },
    latency_ms: 3.2,
    method: "shingle+tokens",
  } as any;
}

test("buildShareReportPdf: produces a valid PDF binary for a saved share", async () => {
  const rec = await createShare({
    a: "def add(x, y):\n    # simple\n    return x + y\n",
    b: "def plus(a, b):\n    # also simple\n    return a + b\n",
    language: "python",
    title: "Adder vs Plus",
    tags: ["demo", "pdf-test"],
    result: fakeResult(),
  });

  const bytes = await buildShareReportPdf(rec, { origin: "http://localhost:3000" });

  assert.ok(bytes instanceof Uint8Array, "returns a Uint8Array");
  assert.ok(bytes.length > 1500, `PDF too small: ${bytes.length} bytes`);

  // PDF magic header.
  const head = Buffer.from(bytes.slice(0, 5)).toString("ascii");
  assert.equal(head, "%PDF-", `bad PDF header: ${JSON.stringify(head)}`);

  // EOF marker should appear near the end.
  const tail = Buffer.from(bytes.slice(Math.max(0, bytes.length - 32))).toString("ascii");
  assert.match(tail, /%%EOF\s*$/, "PDF missing %%EOF trailer");
});

test("buildShareReportPdf: handles non-Latin-1 characters without throwing", async () => {
  const rec = await createShare({
    a: "fn smile() { let s = \"\u263A\u2014cool\"; }",
    b: "fn smile2() { let s = \"\u263A cool\"; }",
    language: "rust",
    title: "Smiles \u2014 with em dash",
    tags: ["unicode"],
    result: fakeResult(0.33),
  });
  const bytes = await buildShareReportPdf(rec);
  assert.ok(bytes.length > 1000);
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString("ascii"), "%PDF-");
});
