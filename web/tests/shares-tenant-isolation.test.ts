/**
 * Run with: node --test --experimental-strip-types web/tests/shares-tenant-isolation.test.ts
 *
 * Proves the workspace-scoping enforcement for saved comparisons.
 *
 * Before this feature, any caller that knew a share id could load,
 * patch, or delete it because shares were a global namespace. This
 * test verifies that a load/update/delete call carrying a different
 * workspaceId returns null and never mutates the underlying file, and
 * that legacy unscoped records only flow through callers that
 * explicitly opt into `allowLegacy`.
 *
 * Black-box: only exercises lib/share.ts so the same guarantees hold
 * regardless of which route (browser /api/share/* or programmatic
 * /v1/shares/*) is invoked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-shares-iso-"));
process.env.CODECLONE_SHARES_DIR = tmp;

const {
  createShare,
  loadShare,
  updateShare,
  deleteShare,
  listSharesPage,
} = await import("../lib/share.ts");

function fakeResult(score = 0.5) {
  return {
    language: "javascript",
    scores: { shingleJaccard: score, tokenJaccard: 0.4, containment: 0.6 },
    alignment: { rows: [] },
    clone: {
      label: "Type-2",
      confidence: 0.7,
      structuralSim: 0.5,
      rawTokenSim: 0.6,
      rationale: [],
    },
    bytes: { a: 10, b: 12 },
    latency_ms: 1.23,
    method: "test",
  } as unknown as Parameters<typeof createShare>[0]["result"];
}

test("createShare persists workspaceId and load/update/delete are scoped", async () => {
  const wsA = "ws_alpha1";
  const wsB = "ws_bravo2";
  const recA = await createShare({
    a: "function a() { return 1 }",
    b: "function b() { return 2 }",
    language: "javascript",
    title: "alpha share",
    workspaceId: wsA,
    result: fakeResult(0.7),
  });
  const recB = await createShare({
    a: "function c() { return 3 }",
    b: "function d() { return 4 }",
    language: "javascript",
    title: "bravo share",
    workspaceId: wsB,
    result: fakeResult(0.3),
  });
  assert.equal(recA.workspaceId, wsA);
  assert.equal(recB.workspaceId, wsB);

  // wsB cannot read wsA's share.
  const crossRead = await loadShare(recA.id, { workspaceId: wsB });
  assert.equal(crossRead, null, "cross-tenant load must return null");

  // wsA can read its own share.
  const ownRead = await loadShare(recA.id, { workspaceId: wsA });
  assert.ok(ownRead);
  assert.equal(ownRead!.title, "alpha share");

  // wsB cannot patch wsA's title.
  const crossUpdate = await updateShare(
    recA.id,
    { title: "pwned" },
    { workspaceId: wsB },
  );
  assert.equal(crossUpdate, null, "cross-tenant update must return null");
  const reread = await loadShare(recA.id, { workspaceId: wsA });
  assert.equal(reread!.title, "alpha share", "file must not be mutated");

  // wsB cannot delete wsA's share.
  const crossDelete = await deleteShare(recA.id, { workspaceId: wsB });
  assert.equal(crossDelete, false, "cross-tenant delete must return false");
  const stillThere = await loadShare(recA.id, { workspaceId: wsA });
  assert.ok(stillThere, "share must still exist after attempted cross-delete");

  // Owner can delete.
  const ownDelete = await deleteShare(recA.id, { workspaceId: wsA });
  assert.equal(ownDelete, true);
  const gone = await loadShare(recA.id, { workspaceId: wsA });
  assert.equal(gone, null);
});

test("listSharesPage scopes items and facets to the calling workspace", async () => {
  const wsX = "ws_xray11";
  const wsY = "ws_yodel2";
  await createShare({
    a: "let x=1", b: "let y=2", language: "javascript",
    title: "x-only", workspaceId: wsX, result: fakeResult(0.5),
  });
  await createShare({
    a: "let p=1", b: "let q=2", language: "python",
    title: "y-only", workspaceId: wsY, result: fakeResult(0.5),
  });

  const xPage = await listSharesPage({ workspaceId: wsX });
  assert.ok(xPage.items.every((s) => s.workspaceId === wsX),
    "no cross-tenant items must leak into wsX page");
  assert.ok(xPage.items.some((s) => s.title === "x-only"));
  assert.ok(!xPage.items.some((s) => s.title === "y-only"));

  // Facets must also be scoped: python (wsY only) must not appear in
  // wsX's language facet histogram.
  const languages = xPage.facets.languages.map((f) => f.name);
  assert.ok(!languages.includes("python"),
    "language facet must not leak languages from other tenants");
});

test("legacy unscoped shares require allowLegacy to be returned", async () => {
  // Hand-write a v2 record with no workspaceId to simulate a legacy
  // share created before this feature shipped.
  const legacyId = "legacy0001";
  const legacy = {
    v: 2,
    id: legacyId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    language: "javascript",
    title: "legacy",
    a: "old", b: "old",
    result: fakeResult(0.1),
  };
  fs.writeFileSync(path.join(tmp, `${legacyId}.json`), JSON.stringify(legacy));

  const scopedNoLegacy = await loadShare(legacyId, { workspaceId: "ws_alpha1" });
  assert.equal(scopedNoLegacy, null,
    "scoped load without allowLegacy must hide legacy records");

  const scopedWithLegacy = await loadShare(legacyId, {
    workspaceId: "ws_alpha1",
    allowLegacy: true,
  });
  assert.ok(scopedWithLegacy, "allowLegacy unlocks unscoped records for migration");
});
