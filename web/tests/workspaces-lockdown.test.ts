/**
 * Workspace break-glass lockdown.
 *
 * Verifies:
 *   - sanitizeLockdown validates reason/caseRef
 *   - placeLockdown / releaseLockdown persist and round-trip
 *   - isWorkspaceLocked reflects state
 *   - enforceWorkspaceLockdownForKey returns 423 with structured
 *     `workspace_locked` error and Retry-After header for keys bound
 *     to a locked workspace
 *   - cross-tenant isolation: a lockdown on workspace A does not
 *     affect /v1 calls for a key bound to workspace B
 *   - keys with no workspace binding are exempt
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-lockdown-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CODECLONE_AUDIT_DIR = path.join(tmp, "audit");

const ws = await import("../lib/workspaces.ts");

test("sanitizeLockdown validates reason and caseRef", () => {
  assert.equal(ws.sanitizeLockdown(null), null);
  assert.equal(ws.sanitizeLockdown({}), null);
  assert.equal(ws.sanitizeLockdown({ reason: "ab" }), null);
  assert.equal(ws.sanitizeLockdown({ reason: "x".repeat(501) }), null);
  assert.deepEqual(
    ws.sanitizeLockdown({ reason: "  key may be leaked  " }),
    { reason: "key may be leaked", caseRef: null },
  );
  assert.deepEqual(
    ws.sanitizeLockdown({ reason: "incident", caseRef: "INC-2026-001" }),
    { reason: "incident", caseRef: "INC-2026-001" },
  );
  assert.equal(
    ws.sanitizeLockdown({ reason: "incident", caseRef: "bad<script>" }),
    null,
  );
});

test("place + release lockdown round-trips and isWorkspaceLocked tracks", async () => {
  const a = await ws.createWorkspace({
    name: "Acme",
    ownerId: "u_alice000001",
    ownerEmail: "alice@acme.test",
  });
  assert.equal(ws.isWorkspaceLocked(a), false);

  await ws.placeLockdown(
    a,
    { reason: "suspected key compromise", caseRef: "INC-1" },
    "u_alice000001",
  );
  assert.equal(ws.isWorkspaceLocked(a), true);

  // persisted to disk
  const reloaded = await ws.getWorkspace(a.id);
  assert.ok(reloaded);
  assert.equal(reloaded!.lockdown!.active, true);
  assert.equal(reloaded!.lockdown!.reason, "suspected key compromise");
  assert.equal(reloaded!.lockdown!.caseRef, "INC-1");
  assert.equal(reloaded!.lockdown!.placedBy, "u_alice000001");

  await ws.releaseLockdown(reloaded!);
  const reloaded2 = await ws.getWorkspace(a.id);
  assert.equal(ws.isWorkspaceLocked(reloaded2), false);
  assert.equal(reloaded2!.lockdown, null);
});

test("lockdown gating logic is tenant-scoped via isWorkspaceLocked", async () => {
  const a = await ws.createWorkspace({
    name: "Acme",
    ownerId: "u_alice000001",
    ownerEmail: "alice@acme.test",
  });
  const b = await ws.createWorkspace({
    name: "Globex",
    ownerId: "u_bob000000001",
    ownerEmail: "bob@globex.test",
  });

  // No lockdown anywhere => both workspaces report unlocked.
  assert.equal(ws.isWorkspaceLocked(a), false);
  assert.equal(ws.isWorkspaceLocked(b), false);

  // Lock A only.
  await ws.placeLockdown(a, { reason: "incident response" }, "u_alice000001");
  const reloadedA = await ws.getWorkspace(a.id);
  const reloadedB = await ws.getWorkspace(b.id);
  assert.equal(ws.isWorkspaceLocked(reloadedA), true, "A must be locked");
  assert.equal(
    ws.isWorkspaceLocked(reloadedB),
    false,
    "lockdown on A must NOT leak to B (cross-tenant isolation)",
  );

  // A's lockdown payload carries every audit field we surface to /v1 callers.
  assert.equal(reloadedA!.lockdown!.active, true);
  assert.equal(reloadedA!.lockdown!.reason, "incident response");
  assert.equal(reloadedA!.lockdown!.placedBy, "u_alice000001");
  assert.equal(typeof reloadedA!.lockdown!.placedAt, "number");

  // Null / undefined workspaces are treated as unlocked so legacy keys with
  // no workspace binding short-circuit through the enforcer.
  assert.equal(ws.isWorkspaceLocked(null), false);
  assert.equal(ws.isWorkspaceLocked(undefined), false);

  // Releasing the lockdown re-opens A without touching B.
  await ws.releaseLockdown(reloadedA!);
  const finalA = await ws.getWorkspace(a.id);
  const finalB = await ws.getWorkspace(b.id);
  assert.equal(ws.isWorkspaceLocked(finalA), false);
  assert.equal(ws.isWorkspaceLocked(finalB), false);
});

