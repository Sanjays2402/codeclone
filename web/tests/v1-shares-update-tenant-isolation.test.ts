/**
 * Run with: node --test --experimental-strip-types web/tests/v1-shares-update-tenant-isolation.test.ts
 *
 * Proves the workspace-scoping and validation guarantees of the new
 * programmatic PATCH /v1/shares/[id] endpoint.
 *
 * The route handler imports next/server and cannot be loaded under
 * raw `node --test`, so this follows the same two-layer pattern used
 * by v1-keys-update-tenant-isolation.test.ts:
 *
 *   1) Black-box assertions on `updateShare` proving cross-tenant
 *      PATCH returns null, same-tenant PATCH writes a real diff,
 *      and legacy unscoped records are still reachable to legacy
 *      (workspace-less) callers.
 *   2) Source-level assertions that the route file actually wires
 *      `shares:write`, the workspace gate, the input validators,
 *      audit (with diff), and the dry-run preview path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-shares-patch-"));
process.env.CODECLONE_SHARES_DIR = tmp;

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const { createShare, loadShare, updateShare } = await import("../lib/share.ts");

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

const WS_A = "ws_alpha";
const WS_B = "ws_bravo";

const recA = await createShare({
  a: "aaaa",
  b: "aaab",
  language: "javascript",
  workspaceId: WS_A,
  title: "alpha original",
  tags: ["a"],
  result: fakeResult(0.91),
});
const recB = await createShare({
  a: "bbbb",
  b: "bbbc",
  language: "python",
  workspaceId: WS_B,
  title: "bravo original",
  result: fakeResult(0.55),
});

test("PATCH /v1/shares: cross-tenant update returns null and on-disk record is untouched", async () => {
  const scopeB = { workspaceId: WS_B, allowLegacy: false } as const;
  const cross = await updateShare(recA.id, { title: "pwned", tags: ["x"] }, scopeB);
  assert.equal(cross, null, "cross-tenant PATCH must return null");
  const reread = await loadShare(recA.id);
  assert.ok(reread);
  assert.equal(reread!.title, "alpha original", "title must not change");
  assert.deepEqual(reread!.tags ?? [], ["a"], "tags must not change");
});

test("PATCH /v1/shares: same-tenant update writes a real diff and bumps updatedAt", async () => {
  const scopeA = { workspaceId: WS_A, allowLegacy: false } as const;
  const before = await loadShare(recA.id, scopeA);
  assert.ok(before);
  const updated = await updateShare(
    recA.id,
    { title: "alpha renamed", tags: ["soc2", "case-1234"] },
    scopeA,
  );
  assert.ok(updated, "same-tenant PATCH must succeed");
  assert.equal(updated!.title, "alpha renamed");
  assert.deepEqual(updated!.tags, ["soc2", "case-1234"]); // insertion order, dedup, lowercased
  assert.ok((updated!.updatedAt ?? 0) >= (before!.createdAt ?? 0), "updatedAt must be set");
});

test("PATCH /v1/shares: clearing title/tags with null round-trips", async () => {
  const scopeB = { workspaceId: WS_B, allowLegacy: false } as const;
  const cleared = await updateShare(recB.id, { title: null, tags: null }, scopeB);
  assert.ok(cleared);
  assert.equal(cleared!.title, undefined, "title must be cleared");
  assert.equal(cleared!.tags, undefined, "tags must be cleared");
});

const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/v1/shares/[id]/route.ts"),
  "utf8",
);

test("v1/shares/[id] route wires PATCH with scope, tenant gate, audit, and dry-run", () => {
  assert.match(routeSrc, /export async function PATCH/);
  assert.match(routeSrc, /hasScope\(key,\s*"shares:write"\)/);
  // Workspace-scoped load + update.
  assert.match(routeSrc, /loadShare\(id,\s*scope\)/);
  assert.match(routeSrc, /updateShare\(id,\s*patch,\s*scope\)/);
  // Input validators: rejects non-string title and non-array tags.
  assert.match(routeSrc, /title must be a string or null/);
  assert.match(routeSrc, /tags must be an array of strings or null/);
  // Audited with a before/after diff for SOC2 evidence.
  assert.match(routeSrc, /tryRecordAudit[\s\S]*v1\.shares\.update"/);
  assert.match(routeSrc, /diff:\s*\{[\s\S]*before:[\s\S]*after:/);
  // Dry-run preview path is wired.
  assert.match(routeSrc, /isDryRun\(req,\s*body\)/);
  assert.match(routeSrc, /v1\.shares\.update\.dry_run"/);
  // Tenant-gate enforcement chain matches the rest of /v1/shares/[id].
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
});
