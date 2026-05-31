/**
 * Workspace legal hold.
 *
 * Verifies:
 *   - sanitizeLegalHold validates reason/caseRef
 *   - placeLegalHold / releaseLegalHold persist
 *   - setRetention refuses to weaken (clear or shorten) while held
 *     (LegalHoldError) but allows lengthening
 *   - cross-tenant isolation: a hold on workspace A does not affect
 *     destructive operations on workspace B
 *   - permission denial: non-owner cannot manage (canManage = false)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-hold-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");

const ws = await import("../lib/workspaces.ts");

test("sanitizeLegalHold validates reason and caseRef", () => {
  assert.equal(ws.sanitizeLegalHold(null), null);
  assert.equal(ws.sanitizeLegalHold({}), null);
  assert.equal(ws.sanitizeLegalHold({ reason: "ab" }), null); // too short
  assert.equal(ws.sanitizeLegalHold({ reason: "x".repeat(501) }), null);
  assert.deepEqual(
    ws.sanitizeLegalHold({ reason: "  pending litigation  " }),
    { reason: "pending litigation", caseRef: null },
  );
  assert.deepEqual(
    ws.sanitizeLegalHold({ reason: "audit", caseRef: "LIT-2026-001" }),
    { reason: "audit", caseRef: "LIT-2026-001" },
  );
  // Bad caseRef chars are rejected (not silently dropped) so callers
  // can't smuggle arbitrary text into the audit log.
  assert.equal(
    ws.sanitizeLegalHold({ reason: "audit", caseRef: "bad<script>" }),
    null,
  );
});

test("place + release legal hold persists and is owner-gated", async () => {
  const a = await ws.createWorkspace({
    name: "Acme",
    ownerId: "u_alice000001",
    ownerEmail: "alice@acme.test",
  });
  // Add a viewer; they should not be able to manage.
  const invite = await ws.issueInvite({
    workspace: a,
    email: "viewer@acme.test",
    role: "viewer",
    invitedBy: "u_alice000001",
    origin: "https://x.test",
  });
  await ws.acceptInvite({
    token: invite.token,
    userId: "u_viewer00001",
    userEmail: "viewer@acme.test",
  });
  const reloaded = (await ws.getWorkspace(a.id))!;
  assert.equal(ws.canManage(reloaded, "u_alice000001"), true);
  assert.equal(ws.canManage(reloaded, "u_viewer00001"), false);

  assert.equal(ws.isOnLegalHold(reloaded), false);
  const placed = await ws.placeLegalHold(
    reloaded,
    { reason: "pending litigation", caseRef: "LIT-1" },
    "u_alice000001",
  );
  assert.equal(ws.isOnLegalHold(placed), true);
  const fromDisk = (await ws.getWorkspace(a.id))!;
  assert.equal(fromDisk.legalHold?.reason, "pending litigation");
  assert.equal(fromDisk.legalHold?.caseRef, "LIT-1");
  assert.equal(fromDisk.legalHold?.placedBy, "u_alice000001");

  const released = await ws.releaseLegalHold(fromDisk);
  assert.equal(ws.isOnLegalHold(released), false);
  const afterRelease = (await ws.getWorkspace(a.id))!;
  assert.equal(afterRelease.legalHold, null);
});

test("setRetention refuses to weaken while held; lengthen is allowed", async () => {
  const a = await ws.createWorkspace({
    name: "Beta",
    ownerId: "u_owner0000b1",
    ownerEmail: "owner@beta.test",
  });
  // Start with a 30-day retention policy.
  let cur = await ws.setRetention(a, { auditDays: 30 }, "u_owner0000b1");
  assert.equal(cur.retention?.auditDays, 30);

  // Place hold.
  cur = await ws.placeLegalHold(cur, { reason: "preserve evidence" }, "u_owner0000b1");

  // Clear (auditDays: 0) -> blocked.
  await assert.rejects(
    () => ws.setRetention(cur, { auditDays: 0 }, "u_owner0000b1"),
    (err: unknown) => err instanceof ws.LegalHoldError,
  );
  // Shorten -> blocked.
  await assert.rejects(
    () => ws.setRetention(cur, { auditDays: 7 }, "u_owner0000b1"),
    (err: unknown) => err instanceof ws.LegalHoldError,
  );
  // Lengthen -> allowed.
  const lengthened = await ws.setRetention(cur, { auditDays: 365 }, "u_owner0000b1");
  assert.equal(lengthened.retention?.auditDays, 365);
  // No-op (same value) -> allowed.
  const same = await ws.setRetention(lengthened, { auditDays: 365 }, "u_owner0000b1");
  assert.equal(same.retention?.auditDays, 365);

  // Release lets us shorten again.
  const released = await ws.releaseLegalHold(same);
  const shortened = await ws.setRetention(released, { auditDays: 7 }, "u_owner0000b1");
  assert.equal(shortened.retention?.auditDays, 7);
});

test("cross-tenant isolation: hold on A does not affect B", async () => {
  const a = await ws.createWorkspace({
    name: "Tenant A",
    ownerId: "u_aowner00001",
    ownerEmail: "a@a.test",
  });
  const b = await ws.createWorkspace({
    name: "Tenant B",
    ownerId: "u_bowner00001",
    ownerEmail: "b@b.test",
  });

  await ws.setRetention(a, { auditDays: 90 }, "u_aowner00001");
  await ws.setRetention(b, { auditDays: 90 }, "u_bowner00001");

  const heldA = await ws.placeLegalHold(
    (await ws.getWorkspace(a.id))!,
    { reason: "litigation A" },
    "u_aowner00001",
  );
  assert.equal(ws.isOnLegalHold(heldA), true);
  // B should be completely unaffected.
  const freshB = (await ws.getWorkspace(b.id))!;
  assert.equal(ws.isOnLegalHold(freshB), false);
  // And destructive ops on B (shortening retention, clearing) still work.
  const shortenedB = await ws.setRetention(freshB, { auditDays: 7 }, "u_bowner00001");
  assert.equal(shortenedB.retention?.auditDays, 7);
  const clearedB = await ws.setRetention(shortenedB, { auditDays: 0 }, "u_bowner00001");
  assert.equal(clearedB.retention, null);

  // Meanwhile the same shortening on A still rejects.
  await assert.rejects(
    () => ws.setRetention(heldA, { auditDays: 7 }, "u_aowner00001"),
    (err: unknown) => err instanceof ws.LegalHoldError,
  );
});
