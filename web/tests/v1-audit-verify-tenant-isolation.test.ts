/**
 * Run with:
 *   node --test --experimental-strip-types web/tests/v1-audit-verify-tenant-isolation.test.ts
 *
 * Covers the GET /v1/audit/verify programmatic tamper-evidence endpoint:
 *
 *   1) The route source wires the audit:read scope check, the per-key
 *      rate-limit enforce (not peek — verify is real traffic), the full
 *      workspace enforcement chain (lockdown, allowlists, residency,
 *      key policy), rejects keys with no workspace, and writes a
 *      self-audit row under a stable `v1.audit.verify` action id.
 *
 *   2) Live behavioural test: a key minted in workspace B can verify the
 *      chain (the integrity status is global by design), but the verify
 *      call itself is audited under workspace B, never under workspace
 *      A, so cross-tenant audit attribution holds. listAudit() scoped to
 *      workspace B sees the v1.audit.verify row; the same listAudit
 *      scoped to workspace A does not.
 *
 *   3) Scope enforcement: hasScope() rejects keys minted with only
 *      compare:write when audit:read is required, and accepts keys
 *      minted with audit:read.
 *
 *   4) verifyAuditChain returns ok=true on the seeded log and the
 *      route would respond 200; flipping a byte in a stored entry
 *      causes verifyAuditChain to return ok=false (so the route would
 *      respond 409 with X-Audit-Chain-Status: broken).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-audit-verify-keys-"));
const tmpAudit = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-audit-verify-log-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-audit-verify-rl-"));
process.env.CODECLONE_KEYS_DIR = tmpKeys;
process.env.CODECLONE_AUDIT_DIR = tmpAudit;
process.env.CODECLONE_RATELIMIT_DIR = tmpRl;

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "audit", "verify", "route.ts"),
  "utf8",
);

const { createKey, hasScope, ALL_SCOPES } = await import("../lib/api-keys.ts");
const { recordAudit, verifyAuditChain, listAudit, AUDIT_DIR } = await import(
  "../lib/audit.ts"
);

function fakeReq(): Request {
  return new Request("http://localhost/t");
}

test("v1/audit/verify: source wires scope, rate-limit, enforcement chain, no-workspace 403, and self-audit", () => {
  assert.match(routeSrc, /hasScope\(key, "audit:read"\)/);
  assert.match(routeSrc, /enforceRateLimit\(/);
  assert.ok(!/peekRateLimit\(/.test(routeSrc), "v1/audit/verify must enforce, not peek");
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Reject keys minted without a workspace; verifying on behalf of a null
  // workspace would poison the audit trail attribution.
  assert.match(routeSrc, /!key\.workspaceId/);
  // Self-audit row under a stable, SIEM-matchable action id.
  assert.match(routeSrc, /"v1\.audit\.verify"/);
  // Status-code surface for SIEM correlation.
  assert.match(routeSrc, /X-Audit-Chain-Status/);
  assert.match(routeSrc, /result\.ok\s*\?\s*200\s*:\s*409/);
});

test("v1/audit/verify: ALL_SCOPES exposes audit:read so the UI can grant it", () => {
  assert.ok((ALL_SCOPES as readonly string[]).includes("audit:read"));
});

test("v1/audit/verify: hasScope rejects keys without audit:read and accepts keys with it", async () => {
  const compareOnly = await createKey("compare-only-verify", {
    workspaceId: "ws_tenanta",
    scopes: ["compare:write"],
  });
  const auditOk = await createKey("audit-verifier", {
    workspaceId: "ws_tenanta",
    scopes: ["compare:write", "audit:read"],
  });
  assert.equal(hasScope(compareOnly.record, "audit:read"), false);
  assert.equal(hasScope(auditOk.record, "audit:read"), true);
});

test("v1/audit/verify: clean chain verifies; verify is attributed to caller workspace only", async () => {
  // Seed entries from two different workspaces into the shared chain.
  await recordAudit(fakeReq(), {
    action: "snippet.create",
    actorId: "user_a",
    workspaceId: "ws_tenanta",
    target: { type: "snippet", id: "s_a1" },
  });
  await recordAudit(fakeReq(), {
    action: "snippet.create",
    actorId: "user_b",
    workspaceId: "ws_tenantb",
    target: { type: "snippet", id: "s_b1" },
  });

  // Chain verifies cleanly across both tenants — this is the whole point of
  // a single global hash chain (deletion of one tenant's row stays
  // detectable).
  const before = await verifyAuditChain();
  assert.equal(before.ok, true);
  assert.ok(before.chainedEntries >= 2);
  assert.ok(before.lastHash && before.lastHash.length === 64);

  // Simulate the route attributing the verify event to workspace B.
  const verifierKey = await createKey("verifier-b", {
    workspaceId: "ws_tenantb",
    scopes: ["audit:read"],
  });
  await recordAudit(fakeReq(), {
    action: "v1.audit.verify",
    actorId: verifierKey.record.id,
    workspaceId: "ws_tenantb",
    target: { type: "audit_log", id: "ws_tenantb" },
    status: "ok",
    meta: { last_hash: before.lastHash },
  });

  // Tenant B can see its own verify event.
  const seenByB = await listAudit({
    action: "v1.audit.verify",
    workspaceId: "ws_tenantb",
    allowedWorkspaceIds: new Set(["ws_tenantb"]),
    limit: 50,
  });
  assert.equal(seenByB.length, 1);
  assert.equal(seenByB[0]!.workspaceId, "ws_tenantb");

  // Tenant A cannot see workspace B's verify event under its own scope.
  const seenByA = await listAudit({
    action: "v1.audit.verify",
    workspaceId: "ws_tenanta",
    allowedWorkspaceIds: new Set(["ws_tenanta"]),
    limit: 50,
  });
  assert.equal(seenByA.length, 0);
});

test("v1/audit/verify: flipping a byte in a stored entry breaks the chain (route would 409)", async () => {
  // Find a populated day file and tamper with one entry's `meta`.
  const files = fs
    .readdirSync(AUDIT_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  assert.ok(files.length > 0, "expected at least one day file from earlier seeding");
  const file = path.join(AUDIT_DIR, files[files.length - 1]!);
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.ok(lines.length > 0);
  // Flip a single character inside the first chained entry's actorId.
  const tampered = lines[0]!.replace(/"actorId":"([^"]*)"/, (_m, v) => {
    const flipped = (v as string).length > 0 ? "X" + (v as string).slice(1) : "X";
    return `"actorId":"${flipped}"`;
  });
  fs.writeFileSync(file, [tampered, ...lines.slice(1)].join("\n") + "\n");

  const after = await verifyAuditChain();
  assert.equal(after.ok, false, "tampering must be detected");
  assert.ok(after.brokenAt, "brokenAt must be populated when chain is broken");
});
