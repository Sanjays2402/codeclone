/**
 * Run with: node --test --experimental-strip-types web/tests/snippets.test.ts
 *
 * Black-box test for the snippets library. Uses a temp directory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-snippets-"));
process.env.CODECLONE_SNIPPETS_DIR = tmp;

const {
  createSnippet,
  loadSnippet,
  updateSnippet,
  listSnippets,
  deleteSnippet,
  countSnippets,
  SnippetError,
  MAX_BODY_BYTES,
} = await import("../lib/snippets.ts");

const USER = "user_abc123";

test("snippets: create, load, list, update, delete round trip", async () => {
  const rec = await createSnippet(USER, {
    title: "  Canonical Quicksort  ",
    language: "Python",
    body: "def qs(a):\n    return a\n",
    tags: ["Baseline", "baseline", "BAD!!!", "ref"],
  });
  assert.equal(rec.v, 1);
  assert.equal(rec.userId, USER);
  assert.equal(rec.title, "Canonical Quicksort");
  assert.equal(rec.language, "python");
  assert.deepEqual(rec.tags, ["baseline", "bad", "ref"]);

  const loaded = await loadSnippet(USER, rec.id);
  assert.ok(loaded);
  assert.equal(loaded!.id, rec.id);

  // user isolation
  const other = await loadSnippet("user_xyz999", rec.id);
  assert.equal(other, null);

  const list = await listSnippets(USER);
  assert.equal(list.length, 1);

  const updated = await updateSnippet(USER, rec.id, {
    title: "Renamed",
    tags: ["new"],
  });
  assert.ok(updated);
  assert.equal(updated!.title, "Renamed");
  assert.deepEqual(updated!.tags, ["new"]);

  // search by query
  const found = await listSnippets(USER, { q: "renamed" });
  assert.equal(found.length, 1);
  const notFound = await listSnippets(USER, { q: "nope-xyz" });
  assert.equal(notFound.length, 0);

  // filter by tag
  const byTag = await listSnippets(USER, { tag: "new" });
  assert.equal(byTag.length, 1);

  const ok = await deleteSnippet(USER, rec.id);
  assert.equal(ok, true);
  const after = await loadSnippet(USER, rec.id);
  assert.equal(after, null);
});

test("snippets: validates required fields", async () => {
  await assert.rejects(
    () =>
      createSnippet(USER, {
        title: "",
        language: "python",
        body: "x",
      }),
    SnippetError,
  );
  await assert.rejects(
    () =>
      createSnippet(USER, {
        title: "ok",
        language: "",
        body: "x",
      }),
    SnippetError,
  );
  await assert.rejects(
    () =>
      createSnippet(USER, {
        title: "ok",
        language: "python",
        body: "   \n  ",
      }),
    SnippetError,
  );
});

test("snippets: truncates oversize bodies", async () => {
  const big = "a".repeat(MAX_BODY_BYTES + 1024);
  const rec = await createSnippet(USER, {
    title: "Big",
    language: "python",
    body: big,
  });
  assert.ok(Buffer.byteLength(rec.body, "utf8") <= MAX_BODY_BYTES);
  await deleteSnippet(USER, rec.id);
});

test("snippets: countSnippets reflects state", async () => {
  const before = await countSnippets(USER);
  const r = await createSnippet(USER, {
    title: "t",
    language: "go",
    body: "package main",
  });
  const after = await countSnippets(USER);
  assert.equal(after, before + 1);
  await deleteSnippet(USER, r.id);
});
