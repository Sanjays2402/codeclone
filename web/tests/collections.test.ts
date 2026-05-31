/**
 * Run with: node --test --experimental-strip-types web/tests/collections.test.ts
 *
 * Black-box test for the collections store. Uses temp dirs so it never
 * touches real data.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpCol = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-col-"));
const tmpShares = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-shr-"));
process.env.CODECLONE_COLLECTIONS_DIR = tmpCol;
process.env.CODECLONE_SHARES_DIR = tmpShares;

const {
  createCollection,
  loadCollection,
  listCollections,
  updateCollection,
  deleteCollection,
  addItem,
  removeItem,
  expandCollection,
  isCollectionId,
} = await import("../lib/collections.ts");
const { createShare } = await import("../lib/share.ts");

function fakeResult(): any {
  return {
    language: "python",
    scores: {
      shingleJaccard: 0.42,
      tokenJaccard: 0.5,
      containment: 0.6,
      shared: { tokens: 5, shingles: 3 },
      size: { aTokens: 10, bTokens: 12, aShingles: 8, bShingles: 9 },
      matchedTokens: ["foo", "bar"],
    },
    alignment: { pairs: [], lengthA: 1, lengthB: 1 },
    clone: { type: "type-3" as const, label: "type-3 (near miss)", confidence: 0.7, structuralJaccard: 0.5 },
    bytes: { a: 100, b: 110 },
    latency_ms: 1.2,
    method: "shingle",
  };
}

test("collections: create requires a non-empty title", async () => {
  await assert.rejects(() => createCollection({ title: "" }), /title/);
  await assert.rejects(() => createCollection({ title: "   " }), /title/);
});

test("collections: create + load roundtrip", async () => {
  const rec = await createCollection({
    title: "  Sprint  14  dupes  ",
    description: "found during refactor",
  });
  assert.equal(rec.title, "Sprint 14 dupes");
  assert.equal(rec.description, "found during refactor");
  assert.equal(rec.shareIds.length, 0);
  assert.ok(isCollectionId(rec.id));
  const loaded = await loadCollection(rec.id);
  assert.ok(loaded);
  assert.equal(loaded?.title, "Sprint 14 dupes");
});

test("collections: add/remove items requires existing shares", async () => {
  const col = await createCollection({ title: "alpha" });
  await assert.rejects(
    () => addItem(col.id, "deadbeef00"),
    /share not found/,
  );
  const share = await createShare({
    a: "def f():\n  return 1\n",
    b: "def g():\n  return 2\n",
    language: "python",
    result: fakeResult(),
  });
  const c1 = await addItem(col.id, share.id);
  assert.ok(c1);
  assert.equal(c1?.shareIds[0], share.id);
  // idempotent
  const c2 = await addItem(col.id, share.id);
  assert.equal(c2?.shareIds.length, 1);
  const c3 = await removeItem(col.id, share.id);
  assert.equal(c3?.shareIds.length, 0);
});

test("collections: expand returns summaries and flags missing shares", async () => {
  const share = await createShare({
    a: "x = 1\n",
    b: "y = 1\n",
    language: "python",
    result: fakeResult(),
  });
  const col = await createCollection({
    title: "expandable",
    shareIds: [share.id],
  });
  // inject a dangling reference to simulate a deleted share
  const filePath = path.join(tmpCol, `${col.id}.json`);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  raw.shareIds.push("doesnotexist1");
  fs.writeFileSync(filePath, JSON.stringify(raw));
  const expanded = await expandCollection(col.id);
  assert.ok(expanded);
  assert.equal(expanded?.items.length, 2);
  assert.equal(expanded?.items[0].missing, undefined);
  assert.equal(expanded?.items[1].missing, true);
});

test("collections: update + list ordering by updatedAt", async () => {
  const a = await createCollection({ title: "older" });
  await new Promise((r) => setTimeout(r, 5));
  const b = await createCollection({ title: "newer" });
  await new Promise((r) => setTimeout(r, 5));
  const u = await updateCollection(a.id, { title: "older renamed" });
  assert.equal(u?.title, "older renamed");
  const page = await listCollections({ limit: 100 });
  // older was just updated, so it should now be first
  assert.equal(page.items[0].id, a.id);
  assert.ok(page.total >= 2);
  // ensure newer is in the list too
  assert.ok(page.items.some((x) => x.id === b.id));
});

test("collections: delete removes the file", async () => {
  const c = await createCollection({ title: "toremove" });
  assert.equal(await deleteCollection(c.id), true);
  assert.equal(await loadCollection(c.id), null);
  assert.equal(await deleteCollection(c.id), false);
});

test("collections: reject obviously invalid ids", () => {
  assert.equal(isCollectionId("abc"), false);
  assert.equal(isCollectionId("!!!!!!!!!"), false);
  assert.equal(isCollectionId("aZ09_-aaaa"), true);
});
