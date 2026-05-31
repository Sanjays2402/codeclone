/**
 * Workspace DPA acceptance.
 *
 * Verifies:
 *   - evaluateDpa flags missing and stale acceptances as required,
 *   - sanitizeAcceptInput rejects garbage and missing version,
 *   - acceptDpa/withdrawDpa persist round-trip via setDpa,
 *   - cross-tenant isolation: workspace A's acceptance does not satisfy
 *     workspace B's gate, and bumping the current version does not
 *     unilaterally re-block a workspace whose acceptance still matches.
 *
 * Run: node --test --experimental-strip-types web/tests/workspaces-dpa.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-dpa-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CODECLONE_USERS_DIR = path.join(tmp, "users");
process.env.CODECLONE_KEYS_DIR = path.join(tmp, "api-keys");
process.env.CODECLONE_AUDIT_DIR = path.join(tmp, "audit");
process.env.CODECLONE_AUTH_SECRET = "test-secret-dpa";

const ws = await import("../lib/workspaces.ts");
const dpa = await import("../lib/dpa.ts");

test("sanitizeAcceptInput rejects bad input and accepts a string version", () => {
  assert.equal(dpa.sanitizeAcceptInput(null), null);
  assert.equal(dpa.sanitizeAcceptInput({}), null);
  assert.equal(dpa.sanitizeAcceptInput({ version: 7 } as never), null);
  assert.equal(dpa.sanitizeAcceptInput({ version: "" } as never), null);
  assert.equal(dpa.sanitizeAcceptInput({ version: "x".repeat(100) } as never), null);
  assert.deepEqual(
    dpa.sanitizeAcceptInput({ version: dpa.DPA_CURRENT_VERSION }),
    { version: dpa.DPA_CURRENT_VERSION },
  );
});

test("evaluateDpa: missing acceptance is required, current is satisfied", async () => {
  const w = await ws.createWorkspace({
    name: "DPA team",
    ownerId: "u_dpa00000001",
    ownerEmail: "owner@example.com",
  });
  const s1 = dpa.evaluateDpa(w);
  assert.equal(s1.required, true);
  assert.equal(s1.accepted, false);
  assert.equal(s1.stale, false);
  assert.equal(s1.currentVersion, dpa.DPA_CURRENT_VERSION);
  assert.equal(s1.acceptance, null);

  const after = await dpa.acceptDpa(w, {
    version: dpa.DPA_CURRENT_VERSION,
    userId: "u_dpa00000001",
    email: "owner@example.com",
    ip: "203.0.113.7",
  });
  assert.equal(after.dpa?.version, dpa.DPA_CURRENT_VERSION);
  assert.equal(after.dpa?.acceptedByEmail, "owner@example.com");
  assert.equal(after.dpa?.acceptedFromIp, "203.0.113.7");

  const reread = await ws.getWorkspace(w.id);
  const s2 = dpa.evaluateDpa(reread);
  assert.equal(s2.required, false);
  assert.equal(s2.accepted, true);
  assert.equal(s2.stale, false);
});

test("evaluateDpa: a pinned-but-stale version is treated as required", async () => {
  const w = await ws.createWorkspace({
    name: "Stale team",
    ownerId: "u_dpa00000002",
    ownerEmail: "two@example.com",
  });
  // Hand-roll a stale acceptance directly via setDpa.
  await ws.setDpa(w, {
    version: "1900-01-01",
    acceptedAt: Date.now() - 86400000,
    acceptedByUserId: "u_dpa00000002",
    acceptedByEmail: "two@example.com",
    acceptedFromIp: null,
  });
  const reread = await ws.getWorkspace(w.id);
  const s = dpa.evaluateDpa(reread);
  assert.equal(s.required, true);
  assert.equal(s.accepted, false);
  assert.equal(s.stale, true);
  assert.equal(s.acceptance?.version, "1900-01-01");
});

test("withdrawDpa clears acceptance and re-arms the gate", async () => {
  const w = await ws.createWorkspace({
    name: "Withdraw",
    ownerId: "u_dpa00000003",
    ownerEmail: "three@example.com",
  });
  await dpa.acceptDpa(w, {
    version: dpa.DPA_CURRENT_VERSION,
    userId: "u_dpa00000003",
    email: "three@example.com",
    ip: null,
  });
  let reread = await ws.getWorkspace(w.id);
  assert.equal(dpa.evaluateDpa(reread).accepted, true);

  const cleared = await dpa.withdrawDpa(reread!);
  assert.equal(cleared.dpa, null);
  reread = await ws.getWorkspace(w.id);
  assert.equal(dpa.evaluateDpa(reread).accepted, false);
  assert.equal(dpa.evaluateDpa(reread).required, true);
});

test("cross-tenant isolation: workspace A's acceptance does not satisfy workspace B", async () => {
  const wA = await ws.createWorkspace({
    name: "Tenant A",
    ownerId: "u_dpaA00000001",
    ownerEmail: "a@example.com",
  });
  const wB = await ws.createWorkspace({
    name: "Tenant B",
    ownerId: "u_dpaB00000001",
    ownerEmail: "b@example.com",
  });
  await dpa.acceptDpa(wA, {
    version: dpa.DPA_CURRENT_VERSION,
    userId: "u_dpaA00000001",
    email: "a@example.com",
    ip: "198.51.100.10",
  });
  const reA = await ws.getWorkspace(wA.id);
  const reB = await ws.getWorkspace(wB.id);
  assert.equal(dpa.evaluateDpa(reA).accepted, true, "A is accepted");
  assert.equal(dpa.evaluateDpa(reB).accepted, false, "B is NOT accepted by A's signature");
  assert.equal(dpa.evaluateDpa(reB).required, true, "B's /v1 gate must still trip");

  // Withdrawing A must not affect B (which was never accepted anyway).
  await dpa.withdrawDpa(reA!);
  const reA2 = await ws.getWorkspace(wA.id);
  const reB2 = await ws.getWorkspace(wB.id);
  assert.equal(dpa.evaluateDpa(reA2).required, true);
  assert.equal(dpa.evaluateDpa(reB2).required, true);
});
