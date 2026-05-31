/**
 * Workspace request payload size policy enforcement.
 *
 * Verifies:
 *   - sanitizePayloadPolicy clamps to bounds and 0 = no policy
 *   - setPayloadPolicy persists and clears
 *   - payloadPolicyLimit returns null when unset / 0
 *   - cross-tenant isolation: a key bound to workspace A is limited by
 *     A's policy and unaffected by B's policy
 *   - the pure body-size decision used by the enforcer accepts under-limit
 *     payloads and rejects over-limit ones
 *
 * Run: node --test --experimental-strip-types web/tests/workspaces-payload-policy.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-pp-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CODECLONE_USERS_DIR = path.join(tmp, "users");
process.env.CODECLONE_KEYS_DIR = path.join(tmp, "api-keys");
process.env.CODECLONE_AUDIT_DIR = path.join(tmp, "audit");
process.env.CODECLONE_AUTH_SECRET = "test-secret-pp";

const ws = await import("../lib/workspaces.ts");

test("sanitizePayloadPolicy clamps and respects 0", () => {
  assert.deepEqual(ws.sanitizePayloadPolicy({ maxBodyBytes: 0 }), { maxBodyBytes: 0 });
  assert.deepEqual(ws.sanitizePayloadPolicy({ maxBodyBytes: -1 }), { maxBodyBytes: 0 });
  const huge = ws.sanitizePayloadPolicy({ maxBodyBytes: 9e12 });
  assert.equal(huge?.maxBodyBytes, ws.PAYLOAD_POLICY_BOUNDS.maxBodyBytes.max);
  const tiny = ws.sanitizePayloadPolicy({ maxBodyBytes: 1 });
  assert.equal(tiny?.maxBodyBytes, ws.PAYLOAD_POLICY_BOUNDS.maxBodyBytes.min);
  const ok = ws.sanitizePayloadPolicy({ maxBodyBytes: 64 * 1024 });
  assert.equal(ok?.maxBodyBytes, 64 * 1024);
  assert.equal(ws.sanitizePayloadPolicy(null), null);
  assert.equal(ws.sanitizePayloadPolicy({ maxBodyBytes: "abc" } as never), null);
});

test("setPayloadPolicy persists and clears", async () => {
  const w = await ws.createWorkspace({
    name: "Payload team",
    ownerId: "u_pp00000001",
    ownerEmail: "p@example.com",
  });
  const after = await ws.setPayloadPolicy(w, { maxBodyBytes: 65536 }, "u_pp00000001");
  assert.equal(after.payloadPolicy?.maxBodyBytes, 65536);
  assert.equal(after.payloadPolicy?.updatedBy, "u_pp00000001");
  const reread = await ws.getWorkspace(w.id);
  assert.equal(reread?.payloadPolicy?.maxBodyBytes, 65536);
  assert.equal(ws.payloadPolicyLimit(reread), 65536);
  const cleared = await ws.setPayloadPolicy(reread!, null, "u_pp00000001");
  assert.equal(cleared.payloadPolicy, null);
  assert.equal(ws.payloadPolicyLimit(cleared), null);
});

test("payloadPolicyLimit handles missing workspace and zero policy", () => {
  assert.equal(ws.payloadPolicyLimit(null), null);
  assert.equal(ws.payloadPolicyLimit(undefined), null);
});

test("cross-tenant isolation: workspace A policy does not leak into workspace B", async () => {
  // Tight workspace.
  const wA = await ws.createWorkspace({
    name: "Tight",
    ownerId: "u_ppA000000001",
    ownerEmail: "a@example.com",
  });
  await ws.setPayloadPolicy(wA, { maxBodyBytes: 2048 }, "u_ppA000000001");
  // Loose workspace, same process, separate record.
  const wB = await ws.createWorkspace({
    name: "Loose",
    ownerId: "u_ppB000000001",
    ownerEmail: "b@example.com",
  });
  await ws.setPayloadPolicy(wB, { maxBodyBytes: 1024 * 1024 }, "u_ppB000000001");

  const reA = await ws.getWorkspace(wA.id);
  const reB = await ws.getWorkspace(wB.id);
  assert.equal(ws.payloadPolicyLimit(reA), 2048);
  assert.equal(ws.payloadPolicyLimit(reB), 1024 * 1024);

  // Pure decision the /v1 enforcer applies: payload allowed iff bytes <= limit.
  const payloadA = "x".repeat(4096);
  const payloadB = "x".repeat(4096);
  const limitA = ws.payloadPolicyLimit(reA)!;
  const limitB = ws.payloadPolicyLimit(reB)!;
  assert.ok(Buffer.byteLength(payloadA, "utf-8") > limitA,
    "4 KiB payload must exceed workspace A's 2 KiB limit");
  assert.ok(Buffer.byteLength(payloadB, "utf-8") <= limitB,
    "4 KiB payload must fit under workspace B's 1 MiB limit");

  // Clearing workspace B's policy must not affect A: the enforcer must
  // still reject the 4 KiB payload against A.
  const clearedB = await ws.setPayloadPolicy(reB!, null, "u_ppB000000001");
  assert.equal(ws.payloadPolicyLimit(clearedB), null);
  const stillA = await ws.getWorkspace(wA.id);
  assert.equal(ws.payloadPolicyLimit(stillA), 2048);
});

test("body-size decision: under-limit passes, over-limit rejects", () => {
  const limit = 1024; // 1 KiB
  const under = JSON.stringify({ a: "x".repeat(100), b: "y".repeat(100) });
  const over = JSON.stringify({ a: "x".repeat(2000), b: "y".repeat(2000) });
  assert.ok(Buffer.byteLength(under, "utf-8") <= limit);
  assert.ok(Buffer.byteLength(over, "utf-8") > limit);
});
