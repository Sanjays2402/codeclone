/**
 * Run with: node --test --experimental-strip-types web/tests/share.test.ts
 *
 * Black-box test for the share store. Uses a temp directory so it never
 * touches real data.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-shares-"));
process.env.CODECLONE_SHARES_DIR = tmp;

const {
  createShare,
  loadShare,
  updateShare,
  listShares,
  deleteShare,
  MAX_SNIPPET_BYTES,
} = await import("../lib/share.ts");

function fakeResult() {
  return {
    language: "javascript",
    scores: { shingleJaccard: 0.42, tokenJaccard: 0.5, containment: 0.6 },
    alignment: { rows: [] },
    clone: {
      label: "Type-2",
      confidence: 0.7,
      structuralSim: 0.5,
      rawTokenSim: 0.6,
      rationale: [],
    },
    bytes: { a: 33, b: 31 },
    latency_ms: 1.23,
    method: "test",
  } as any;
}

test("share lib: create, load, update, list, delete round trip", async () => {
  const rec = await createShare({
    a: "function add(a,b){ return a+b; }\n",
    b: "function sum(x,y){ return x+y; }\n",
    language: "javascript",
    title: "  Adders side by side  ",
    tags: ["Quick Test", "demo", "demo", "BAD!!!"],
    result: fakeResult(),
  });
  assert.equal(rec.v, 3);
  assert.equal(rec.language, "javascript");
  assert.equal(rec.title, "Adders side by side");
  assert.deepEqual(rec.tags, ["quick-test", "demo"]);

  const loaded = await loadShare(rec.id);
  assert.ok(loaded);
  assert.equal(loaded!.id, rec.id);

  const renamed = await updateShare(rec.id, { title: "New title", tags: ["alpha"] });
  assert.ok(renamed);
  assert.equal(renamed!.title, "New title");
  assert.deepEqual(renamed!.tags, ["alpha"]);

  const cleared = await updateShare(rec.id, { title: null, tags: null });
  assert.equal(cleared!.title, undefined);
  assert.equal(cleared!.tags, undefined);

  const list1 = await listShares();
  assert.ok(list1.some((s) => s.id === rec.id));

  await updateShare(rec.id, { tags: ["search-me"] });
  const filtered = await listShares({ tag: "search-me" });
  assert.ok(filtered.some((s) => s.id === rec.id));
  const miss = await listShares({ tag: "nope" });
  assert.equal(miss.find((s) => s.id === rec.id), undefined);

  assert.equal(await deleteShare(rec.id), true);
  assert.equal(await loadShare(rec.id), null);
});

test("share lib: rejects empty and oversized snippets", async () => {
  await assert.rejects(
    () => createShare({ a: "", b: "x", language: "js", result: fakeResult() }),
    /non-empty/,
  );
  const big = "x".repeat(MAX_SNIPPET_BYTES + 1);
  await assert.rejects(
    () => createShare({ a: big, b: "y", language: "js", result: fakeResult() }),
    /at most/,
  );
});

test("share lib: bad ids return null/false", async () => {
  assert.equal(await loadShare("../etc/passwd"), null);
  assert.equal(await loadShare(""), null);
  assert.equal(await deleteShare("../etc/passwd"), false);
});
