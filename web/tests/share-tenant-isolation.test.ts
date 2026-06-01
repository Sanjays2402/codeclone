/**
 * Run with: node --test --experimental-strip-types web/tests/share-tenant-isolation.test.ts
 *
 * Proves that lib/share's ScopeHint cleanly partitions saved comparisons
 * across workspaces. Before this change, /api/share and the v1 share
 * routes loaded any record by id regardless of which workspace the
 * caller belonged to, so a signed-in user on workspace "ws_b" could
 * read, patch, delete, list, and export shares owned by "ws_a".
 *
 * This test exercises the library directly: it creates one share owned
 * by ws_a, one owned by ws_b, and one legacy unscoped record, then
 * walks every public mutation path with a ws_b scope and asserts the
 * ws_a record is invisible while the ws_b record and (when allowLegacy
 * is true) the legacy record are reachable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-share-iso-"));
process.env.CODECLONE_SHARES_DIR = tmp;

const share = await import("../lib/share.ts");
const { createShare, loadShare, updateShare, deleteShare, listSharesPage, exportShares } = share;

function fakeResult(score = 0.42) {
  return {
    language: "javascript",
    scores: {
      shingleJaccard: score,
      cosine: score,
      levenshtein: score,
      ast: score,
    } as any,
    alignment: { rows: [] } as any,
    clone: { label: "near-duplicate", reason: "test" } as any,
    bytes: { a: 4, b: 4 },
    latency_ms: 1,
    method: "test",
  };
}

const recA = await createShare({
  a: "aaaa",
  b: "aaab",
  language: "javascript",
  workspaceId: "ws_alpha",
  result: fakeResult(0.91),
});
const recB = await createShare({
  a: "bbbb",
  b: "bbbc",
  language: "python",
  workspaceId: "ws_bravo",
  result: fakeResult(0.55),
});
// Simulate a legacy v2 record with no workspaceId by writing one directly.
const legacyId = "legacy01abcd";
fs.writeFileSync(
  path.join(tmp, `${legacyId}.json`),
  JSON.stringify({
    v: 2,
    id: legacyId,
    createdAt: Date.now() - 86_400_000,
    language: "go",
    a: "leg1",
    b: "leg2",
    result: fakeResult(0.12),
  }),
);

const scopeB = { workspaceId: "ws_bravo", allowLegacy: true } as const;

test("loadShare with ws_bravo scope hides ws_alpha records", async () => {
  const seen = await loadShare(recA.id, scopeB);
  assert.equal(seen, null, "must not return another tenant's share");
  const own = await loadShare(recB.id, scopeB);
  assert.ok(own && own.id === recB.id, "must return own tenant's share");
  const legacy = await loadShare(legacyId, scopeB);
  assert.ok(legacy && legacy.id === legacyId, "allowLegacy must surface unscoped records");
});

test("loadShare without allowLegacy excludes legacy records", async () => {
  const legacy = await loadShare(legacyId, { workspaceId: "ws_bravo" });
  assert.equal(legacy, null, "strict scope must drop legacy records");
});

test("updateShare with ws_bravo scope cannot mutate ws_alpha record", async () => {
  const r = await updateShare(recA.id, { title: "pwned" }, scopeB);
  assert.equal(r, null, "must refuse to patch another tenant's share");
  const reread = await loadShare(recA.id);
  assert.notEqual(reread?.title, "pwned", "record on disk must be untouched");
});

test("deleteShare with ws_bravo scope cannot delete ws_alpha record", async () => {
  const ok = await deleteShare(recA.id, scopeB);
  assert.equal(ok, false, "must refuse to delete another tenant's share");
  const still = await loadShare(recA.id);
  assert.ok(still, "record must still exist after a cross-tenant delete attempt");
});

test("listSharesPage scoped to ws_bravo never includes ws_alpha rows", async () => {
  const page = await listSharesPage({ workspaceId: "ws_bravo", allowLegacy: true, limit: 50 });
  const ids = page.items.map((i) => i.id).sort();
  assert.ok(ids.includes(recB.id));
  assert.ok(ids.includes(legacyId));
  assert.ok(!ids.includes(recA.id), `ws_alpha share ${recA.id} leaked into ws_bravo list`);
  // Facets must also be tenant-local: ws_alpha was javascript with a
  // near-duplicate label, so a scoped ws_bravo facet view that omits
  // legacy must not show "javascript" at all.
  const strict = await listSharesPage({ workspaceId: "ws_bravo", limit: 50 });
  const langs = strict.facets.languages.map((l) => l.name);
  assert.ok(!langs.includes("javascript"), "facet leak: ws_alpha language reached ws_bravo");
});

test("exportShares scoped to ws_bravo excludes ws_alpha rows", async () => {
  const out = await exportShares({ format: "json", workspaceId: "ws_bravo", allowLegacy: true });
  const parsed = JSON.parse(out.body) as { items: { id: string }[] };
  const ids = parsed.items.map((i) => i.id);
  assert.ok(ids.includes(recB.id));
  assert.ok(!ids.includes(recA.id), `export leaked ws_alpha share ${recA.id}`);
});

test("legacy callers (no scope) still see every record for back-compat", async () => {
  const page = await listSharesPage({ limit: 50 });
  const ids = page.items.map((i) => i.id);
  assert.ok(ids.includes(recA.id) && ids.includes(recB.id) && ids.includes(legacyId));
});
