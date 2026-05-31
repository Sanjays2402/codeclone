/**
 * Workspace data residency policy.
 *
 * Verifies:
 *   - sanitizeResidency rejects bad regions and accepts known ones
 *   - setResidency persists and clears
 *   - residencyDecision returns the right (pinned, serving, match, enforced) tuple
 *   - enforceWorkspaceResidencyForKey blocks cross-region traffic with 451 when
 *     enforcement is on, and a different workspace pinned to the serving region
 *     is unaffected (cross-tenant isolation)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-res-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CODECLONE_AUDIT_DIR = path.join(tmp, "audit");
process.env.CODECLONE_AUTH_SECRET = "test-secret-for-residency";
process.env.CODECLONE_REGION = "us";

const ws = await import("../lib/workspaces.ts");
const enforce = await import("../lib/residency-enforce.ts");

test("sanitizeResidency rejects unknown region and accepts known", () => {
  assert.equal(ws.sanitizeResidency(null), null);
  assert.equal(ws.sanitizeResidency({ region: "mars" }), null);
  assert.deepEqual(ws.sanitizeResidency({ region: "eu", enforced: true }), {
    region: "eu",
    enforced: true,
  });
  assert.deepEqual(ws.sanitizeResidency({ region: "global", enforced: 0 }), {
    region: "global",
    enforced: false,
  });
});

test("setResidency persists, clears, and decides on serving region", async () => {
  const w = await ws.createWorkspace({
    name: "Residency one",
    ownerId: "u_resowner00001",
    ownerEmail: "owner@example.com",
  });
  assert.equal(w.residency ?? null, null);
  const eu = await ws.setResidency(w, { region: "eu", enforced: true }, "u_resowner00001");
  assert.equal(eu.residency?.region, "eu");
  assert.equal(eu.residency?.enforced, true);
  assert.equal(eu.residency?.updatedBy, "u_resowner00001");

  const decision = ws.residencyDecision(eu, "us");
  assert.equal(decision.match, false);
  assert.equal(decision.enforced, true);
  assert.equal(decision.pinned, "eu");
  assert.equal(decision.allowed, false);

  const sameRegion = ws.residencyDecision(eu, "eu");
  assert.equal(sameRegion.match, true);
  assert.equal(sameRegion.allowed, true);

  const cleared = await ws.setResidency(eu, null, "u_resowner00001");
  assert.equal(cleared.residency, null);
  const open = ws.residencyDecision(cleared, "us");
  assert.equal(open.allowed, true);
  assert.equal(open.pinned, "global");
});

test("enforceWorkspaceResidencyForKey returns 451 when pinned-and-enforced does not match", async () => {
  const w = await ws.createWorkspace({
    name: "Residency two",
    ownerId: "u_resowner00002",
    ownerEmail: "owner2@example.com",
  });
  await ws.setResidency(w, { region: "eu", enforced: true }, "u_resowner00002");

  const req = new Request("http://x/v1/compare", { method: "POST" });
  const resp = await enforce.enforceWorkspaceResidencyForKey(req, {
    id: "k_test_001",
    workspaceId: w.id,
    userId: "u_resowner00002",
    label: "ci",
  });
  assert.ok(resp);
  assert.equal(resp!.status, 451);
  const body = (await resp!.json()) as { error: { type: string; pinned_region: string; serving_region: string } };
  assert.equal(body.error.type, "residency_violation");
  assert.equal(body.error.pinned_region, "eu");
  assert.equal(body.error.serving_region, "us");
});

test("enforcement is skipped when policy is not enforced (warn only)", async () => {
  const w = await ws.createWorkspace({
    name: "Residency soft",
    ownerId: "u_resowner00003",
    ownerEmail: "owner3@example.com",
  });
  await ws.setResidency(w, { region: "eu", enforced: false }, "u_resowner00003");
  const req = new Request("http://x/v1/compare", { method: "POST" });
  const resp = await enforce.enforceWorkspaceResidencyForKey(req, {
    id: "k_test_002",
    workspaceId: w.id,
    userId: "u_resowner00003",
  });
  assert.equal(resp, null);
});

test("cross-tenant isolation: another workspace pinned to the serving region is unaffected by an EU workspace", async () => {
  const eu = await ws.createWorkspace({
    name: "EU pinned",
    ownerId: "u_resowner00004",
    ownerEmail: "eu@example.com",
  });
  await ws.setResidency(eu, { region: "eu", enforced: true }, "u_resowner00004");
  const us = await ws.createWorkspace({
    name: "US pinned",
    ownerId: "u_resowner00005",
    ownerEmail: "us@example.com",
  });
  await ws.setResidency(us, { region: "us", enforced: true }, "u_resowner00005");

  const req = new Request("http://x/v1/compare", { method: "POST" });
  const euResp = await enforce.enforceWorkspaceResidencyForKey(req, {
    id: "k_eu_only",
    workspaceId: eu.id,
    userId: "u_resowner00004",
  });
  assert.ok(euResp, "EU workspace must be blocked on a US node");
  assert.equal(euResp!.status, 451);

  const usResp = await enforce.enforceWorkspaceResidencyForKey(req, {
    id: "k_us_only",
    workspaceId: us.id,
    userId: "u_resowner00005",
  });
  assert.equal(usResp, null, "US workspace must pass on a US node");
});

test("currentServingRegion defaults to global when unset or junk", () => {
  const saved = process.env.CODECLONE_REGION;
  process.env.CODECLONE_REGION = "";
  assert.equal(ws.currentServingRegion(), "global");
  process.env.CODECLONE_REGION = "atlantis";
  assert.equal(ws.currentServingRegion(), "global");
  process.env.CODECLONE_REGION = "APAC";
  assert.equal(ws.currentServingRegion(), "apac");
  process.env.CODECLONE_REGION = saved ?? "us";
});
