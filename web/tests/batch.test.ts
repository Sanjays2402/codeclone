/**
 * Run with: node --test --experimental-strip-types web/tests/batch.test.ts
 *
 * Black-box test for the shared batch helper used by /api/batch and
 * /v1/batch. No network, no FS.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { parseBatch, runBatch, BATCH_LIMITS } = await import("../lib/batch.ts");

test("batch: rejects fewer than 2 snippets", () => {
  const r = parseBatch({ snippets: [{ code: "x" }] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /at least 2/i);
});

test("batch: rejects non-array snippets", () => {
  const r = parseBatch({ snippets: "nope" as unknown });
  assert.equal(r.ok, false);
});

test("batch: rejects empty snippet", () => {
  const r = parseBatch({ snippets: [{ code: "a" }, { code: "   " }] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /#2 is empty/);
});

test("batch: enforces per-snippet byte cap", () => {
  const big = "x".repeat(BATCH_LIMITS.MAX_BYTES_EACH + 1);
  const r = parseBatch({ snippets: [{ code: "a" }, { code: big }] });
  assert.equal(r.ok, false);
});

test("batch: enforces snippet count cap", () => {
  const snippets = Array.from({ length: BATCH_LIMITS.MAX_SNIPPETS + 1 }, (_, i) => ({
    code: `let x${i} = ${i};\n`,
  }));
  const r = parseBatch({ snippets });
  assert.equal(r.ok, false);
});

test("batch: deduplicates colliding ids", () => {
  const r = parseBatch({
    snippets: [
      { id: "dup", code: "a = 1\n" },
      { id: "dup", code: "b = 2\n" },
      { id: "dup", code: "c = 3\n" },
    ],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    const ids = r.snippets.map((s) => s.id);
    assert.equal(new Set(ids).size, 3);
    assert.equal(ids[0], "dup");
  }
});

test("batch: defaults language to 'auto'", () => {
  const r = parseBatch({ snippets: [{ code: "a\n" }, { code: "b\n" }] });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.language, "auto");
});

test("batch: respects provided language", () => {
  const r = parseBatch({
    snippets: [{ code: "a\n" }, { code: "b\n" }],
    language: "  python  ",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.language, "python");
});

test("runBatch: symmetric matrix, diagonal is 1, identical snippets score 1", () => {
  const parsed = parseBatch({
    snippets: [
      { id: "a", code: "function add(a, b) { return a + b; }\n" },
      { id: "b", code: "function add(a, b) { return a + b; }\n" },
      { id: "c", code: "function mul(x, y) { return x * y; }\n" },
    ],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const out = runBatch(parsed.snippets, parsed.language);
  assert.equal(out.n, 3);
  // diagonal
  for (let i = 0; i < 3; i++) assert.equal(out.matrix[i][i], 1);
  // symmetry
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      assert.equal(out.matrix[i][j], out.matrix[j][i]);
    }
  }
  // identical pair should be 1
  assert.equal(out.matrix[0][1], 1);
  // n*(n-1)/2 cells
  assert.equal(out.cells.length, 3);
  assert.ok(out.latency_ms >= 0);
});
