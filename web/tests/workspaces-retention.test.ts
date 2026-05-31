/**
 * Workspace audit retention.
 *
 * Verifies:
 *   - sanitizeRetention clamps to bounds and accepts 0 = unlimited
 *   - setRetention persists and clears
 *   - retentionCutoffMs returns null when unset, a sensible past ts otherwise
 *   - listAudit hides entries older than the per-workspace cutoff
 *   - previewWorkspaceRetention counts only affected entries and only for
 *     the requested workspace (cross-tenant isolation guard)
 *   - one workspace's policy does not affect another workspace's entries
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-ret-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CODECLONE_AUDIT_DIR = path.join(tmp, "audit");
process.env.CODECLONE_AUTH_SECRET = "test-secret-for-retention";

const ws = await import("../lib/workspaces.ts");
const audit = await import("../lib/audit.ts");

test("sanitizeRetention clamps to bounds and respects 0", () => {
  assert.deepEqual(ws.sanitizeRetention({ auditDays: 0 }), { auditDays: 0 });
  assert.deepEqual(ws.sanitizeRetention({ auditDays: -5 }), { auditDays: 0 });
  const huge = ws.sanitizeRetention({ auditDays: 9999999 });
  assert.ok(huge);
  assert.equal(huge!.auditDays, ws.RETENTION_BOUNDS.auditDays.max);
  const tiny = ws.sanitizeRetention({ auditDays: 0.4 });
  assert.deepEqual(tiny, { auditDays: 0 });
  assert.equal(ws.sanitizeRetention(null), null);
  assert.equal(ws.sanitizeRetention({ auditDays: "x" as unknown } as never), null);
});

test("setRetention persists, clears, and exposes a cutoff", async () => {
  const w = await ws.createWorkspace({
    name: "Retention team",
    ownerId: "u_retowner0001",
    ownerEmail: "owner@example.com",
  });
  assert.equal(ws.retentionCutoffMs(w), null);
  const after = await ws.setRetention(w, { auditDays: 30 }, "u_retowner0001");
  assert.equal(after.retention?.auditDays, 30);
  assert.equal(after.retention?.updatedBy, "u_retowner0001");
  const cutoff = ws.retentionCutoffMs(after);
  assert.ok(cutoff != null && cutoff < Date.now());
  const reread = await ws.getWorkspace(w.id);
  assert.equal(reread?.retention?.auditDays, 30);
  const cleared = await ws.setRetention(reread!, null, "u_retowner0001");
  assert.equal(cleared.retention, null);
  assert.equal(ws.retentionCutoffMs(cleared), null);
});

test("listAudit hides workspace entries older than the cutoff and isolates tenants", async () => {
  const owner1 = "u_ten1owner001";
  const owner2 = "u_ten2owner001";
  const w1 = await ws.createWorkspace({ name: "Tenant 1", ownerId: owner1, ownerEmail: "t1@example.com" });
  const w2 = await ws.createWorkspace({ name: "Tenant 2", ownerId: owner2, ownerEmail: "t2@example.com" });

  // Record entries for both workspaces, then back-date some by rewriting
  // the on-disk JSONL files to simulate an older audit history.
  await audit.recordAudit(undefined, {
    action: "test.recent",
    actorId: owner1,
    actorEmail: "t1@example.com",
    workspaceId: w1.id,
    target: { type: "workspace", id: w1.id },
  });
  await audit.recordAudit(undefined, {
    action: "test.recent",
    actorId: owner2,
    actorEmail: "t2@example.com",
    workspaceId: w2.id,
    target: { type: "workspace", id: w2.id },
  });

  // Synthesize an "old" entry for w1 by writing directly to a past day file.
  const auditDir = process.env.CODECLONE_AUDIT_DIR!;
  await fs.mkdir(auditDir, { recursive: true });
  const oldTs = Date.now() - 60 * 86400 * 1000; // 60 days ago
  const oldDay = new Date(oldTs).toISOString().slice(0, 10);
  const oldEntry = {
    v: 1,
    id: "aud_old_w1_001",
    ts: oldTs,
    actorId: owner1,
    actorEmail: "t1@example.com",
    workspaceId: w1.id,
    action: "test.old",
    target: { type: "workspace", id: w1.id },
    status: "ok" as const,
    ip: null,
  };
  await fs.appendFile(path.join(auditDir, `${oldDay}.jsonl`), JSON.stringify(oldEntry) + "\n", "utf8");

  // Without retention: the old entry is visible to a w1 member.
  const allFor1 = await audit.listAudit({ workspaceId: w1.id, limit: 100 });
  assert.ok(allFor1.some((e) => e.id === "aud_old_w1_001"), "expected old entry visible without retention");

  // With a 30-day retention cutoff on w1 only: the old entry is hidden.
  const cutoffs = new Map<string, number>([[w1.id, Date.now() - 30 * 86400 * 1000]]);
  const filtered = await audit.listAudit({
    workspaceId: w1.id,
    limit: 100,
    retentionCutoffByWorkspace: cutoffs,
  });
  assert.ok(!filtered.some((e) => e.id === "aud_old_w1_001"), "old entry must be hidden by retention");
  assert.ok(filtered.some((e) => e.action === "test.recent"), "recent entry must still be visible");

  // Cross-tenant isolation: w2's entries are not affected by w1's cutoff.
  const t2Visible = await audit.listAudit({
    workspaceId: w2.id,
    limit: 100,
    retentionCutoffByWorkspace: cutoffs,
  });
  assert.equal(t2Visible.length, 1, "w2 entries must not be affected by w1's retention policy");
  assert.equal(t2Visible[0]!.workspaceId, w2.id);
});

test("previewWorkspaceRetention counts only the target workspace", async () => {
  const ownerA = "u_prevowner001";
  const ownerB = "u_prevowner002";
  const wa = await ws.createWorkspace({ name: "Preview A", ownerId: ownerA, ownerEmail: "a@example.com" });
  const wb = await ws.createWorkspace({ name: "Preview B", ownerId: ownerB, ownerEmail: "b@example.com" });

  const auditDir = process.env.CODECLONE_AUDIT_DIR!;
  await fs.mkdir(auditDir, { recursive: true });
  const oldTs = Date.now() - 120 * 86400 * 1000;
  const oldDay = new Date(oldTs).toISOString().slice(0, 10);
  const lines: string[] = [];
  for (let i = 0; i < 3; i++) {
    lines.push(JSON.stringify({
      v: 1, id: `aud_old_a_${i}`, ts: oldTs + i, actorId: ownerA, actorEmail: "a@example.com",
      workspaceId: wa.id, action: "test.old", target: { type: "workspace", id: wa.id }, status: "ok", ip: null,
    }));
  }
  lines.push(JSON.stringify({
    v: 1, id: "aud_old_b_0", ts: oldTs, actorId: ownerB, actorEmail: "b@example.com",
    workspaceId: wb.id, action: "test.old", target: { type: "workspace", id: wb.id }, status: "ok", ip: null,
  }));
  await fs.appendFile(path.join(auditDir, `${oldDay}.jsonl`), lines.join("\n") + "\n", "utf8");

  const cutoff = Date.now() - 30 * 86400 * 1000;
  const prevA = await audit.previewWorkspaceRetention(wa.id, cutoff);
  assert.equal(prevA.workspaceId, wa.id);
  assert.equal(prevA.affectedEntries, 3, "preview must count only target workspace entries");
  assert.ok(prevA.affectedFiles.length >= 1);
  assert.ok(prevA.scannedEntries >= 4, "should scan everything in the day file");

  const prevB = await audit.previewWorkspaceRetention(wb.id, cutoff);
  assert.equal(prevB.affectedEntries, 1, "B's preview is independent of A");
});
