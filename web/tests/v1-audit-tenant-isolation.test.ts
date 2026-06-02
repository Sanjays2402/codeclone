/**
 * Run with: node --test --experimental-strip-types web/tests/v1-audit-tenant-isolation.test.ts
 *
 * Covers the GET /v1/audit programmatic SIEM-stream endpoint:
 *
 *   1) The route file wires the scope check, the per-key rate-limit
 *      enforce, the full workspace enforcement chain (lockdown,
 *      allowlists, residency, key policy), the WorkspaceScope
 *      filter on listAudit(), and the self-audit row.
 *
 *   2) Live behavioural test of the underlying listAudit() with an
 *      allowedWorkspaceIds set: entries written for workspace A must
 *      be invisible when only workspace B is allowed, and null-actor
 *      legacy entries must be excluded from any scoped Bearer view.
 *      This is the cross-tenant isolation evidence: a customer API
 *      key minted in workspace B can never tail workspace A's audit
 *      log, even though both tenants share one JSONL store.
 *
 *   3) Scope enforcement: hasScope() rejects keys minted with only
 *      compare:write when audit:read is required, and accepts keys
 *      minted with audit:read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-audit-keys-"));
const tmpAudit = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-audit-log-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-audit-rl-"));
process.env.CODECLONE_KEYS_DIR = tmpKeys;
process.env.CODECLONE_AUDIT_DIR = tmpAudit;
process.env.CODECLONE_RATELIMIT_DIR = tmpRl;

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "audit", "route.ts"),
  "utf8",
);

const { createKey, hasScope, ALL_SCOPES } = await import("../lib/api-keys.ts");
const { recordAudit, listAudit } = await import("../lib/audit.ts");

test("v1/audit: route source wires scope, rate-limit, enforcement chain, tenant scope, and self-audit", () => {
  assert.match(routeSrc, /hasScope\(key, "audit:read"\)/);
  // Must call enforce, not peek — /v1/audit is real traffic against the
  // per-key window so a SIEM forwarder can't be used as a free heartbeat.
  assert.match(routeSrc, /enforceRateLimit\(/);
  assert.ok(!/peekRateLimit\(/.test(routeSrc), "v1/audit must enforce, not peek");
  // Standard workspace enforcement chain.
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Tenant scope: allowedWorkspaceIds must be built from the key's workspace.
  assert.match(routeSrc, /allowedWorkspaceIds[\s\S]*?key\.workspaceId/);
  // selfActorId must NOT admit user-mode null-workspace entries to API callers.
  assert.match(routeSrc, /selfActorId:\s*undefined/);
  // Self-audit row written under a stable action id SIEM rules can match.
  assert.match(routeSrc, /"v1\.audit\.read"/);
});

test("v1/audit: ALL_SCOPES exposes audit:read so the UI can grant it", () => {
  assert.ok((ALL_SCOPES as readonly string[]).includes("audit:read"));
});

test("v1/audit: hasScope rejects keys without audit:read and accepts keys with it", async () => {
  const compareOnly = await createKey("compare-only", {
    workspaceId: "ws_tenanta",
    scopes: ["compare:write"],
  });
  const auditOk = await createKey("audit-reader", {
    workspaceId: "ws_tenanta",
    scopes: ["compare:write", "audit:read"],
  });
  assert.equal(hasScope(compareOnly.record, "audit:read"), false);
  assert.equal(hasScope(auditOk.record, "audit:read"), true);
});

test("v1/audit: listAudit allowedWorkspaceIds gives strict cross-tenant isolation", async () => {
  // Seed three audit entries across two tenants plus one null-workspace
  // event (e.g. an anonymous sign-in failure) all into the same store.
  const fakeReq = new Request("http://test.local/seed", {
    headers: { "x-request-id": "seed00000000" },
  });
  await recordAudit(fakeReq, {
    action: "share.create",
    actorId: "u_alice",
    actorEmail: "alice@acme.com",
    workspaceId: "ws_tenanta",
    target: { type: "share", id: "s_a1" },
    status: "ok",
  });
  await recordAudit(fakeReq, {
    action: "share.create",
    actorId: "u_alice",
    actorEmail: "alice@acme.com",
    workspaceId: "ws_tenanta",
    target: { type: "share", id: "s_a2" },
    status: "ok",
  });
  await recordAudit(fakeReq, {
    action: "share.create",
    actorId: "u_bob",
    actorEmail: "bob@globex.com",
    workspaceId: "ws_tenantb",
    target: { type: "share", id: "s_b1" },
    status: "ok",
  });
  await recordAudit(fakeReq, {
    action: "auth.sign_in",
    actorId: "u_charlie",
    actorEmail: "charlie@example.com",
    workspaceId: null,
    target: { type: "session", id: "sess_x" },
    status: "ok",
  });

  // Tenant A's API-key view: only ws_tenanta entries; never the ws_tenantb
  // entry, never the null-workspace sign-in event (Bearer callers are not
  // users so selfActorId is undefined).
  const tenantAView = await listAudit({
    workspaceId: "ws_tenanta",
    allowedWorkspaceIds: new Set(["ws_tenanta"]),
    selfActorId: undefined,
    limit: 100,
  });
  assert.equal(tenantAView.length, 2);
  for (const e of tenantAView) {
    assert.equal(e.workspaceId, "ws_tenanta");
  }
  const aTargets = tenantAView.map((e) => e.target?.id).sort();
  assert.deepEqual(aTargets, ["s_a1", "s_a2"]);

  // Tenant B sees only its own entry.
  const tenantBView = await listAudit({
    workspaceId: "ws_tenantb",
    allowedWorkspaceIds: new Set(["ws_tenantb"]),
    selfActorId: undefined,
    limit: 100,
  });
  assert.equal(tenantBView.length, 1);
  assert.equal(tenantBView[0]!.workspaceId, "ws_tenantb");
  assert.equal(tenantBView[0]!.target?.id, "s_b1");

  // The empty-scope case (key with no workspace) must see nothing.
  const orphanView = await listAudit({
    allowedWorkspaceIds: new Set<string>(),
    selfActorId: undefined,
    limit: 100,
  });
  assert.equal(orphanView.length, 0);

  // Sanity: the unscoped admin view sees everything (this is the
  // dashboard/cookie-auth code path, not the Bearer path under test).
  const adminView = await listAudit({ limit: 100 });
  assert.ok(adminView.length >= 4, "unscoped listAudit should still see all rows");
});

test("v1/audit: route source advertises csv format alongside ndjson/json", () => {
  // The csv branch must exist, validate alongside ndjson/json, set the
  // SIEM-friendly content-type, and emit a workspace-tagged filename so
  // multi-tenant pulls don't overwrite each other.
  assert.match(routeSrc, /format !== "csv"/);
  assert.match(routeSrc, /text\/csv/);
  assert.match(routeSrc, /codeclone-audit-/);
  assert.match(routeSrc, /toCsv\(/);
});

test("v1/audit: toCsv emits RFC 4180-ish rows with header, escaping, and one line per entry", async () => {
  const { toCsv } = await import("../lib/audit.ts");
  const sample = [
    {
      v: 1 as const,
      id: "a1",
      ts: Date.UTC(2025, 0, 2, 3, 4, 5),
      actorId: "u_alice",
      actorEmail: "alice@acme.com",
      workspaceId: "ws_tenanta",
      action: "share.create",
      target: { type: "share", id: "s_a1" },
      status: "ok" as const,
      ip: "203.0.113.7",
      userAgent: null,
      requestId: "req_1",
    },
    {
      v: 1 as const,
      id: "a2",
      ts: Date.UTC(2025, 0, 2, 3, 4, 6),
      actorId: "u_bob",
      actorEmail: "bob@globex.com",
      workspaceId: "ws_tenanta",
      action: "share.create",
      // Exercise the escaper: the label contains a comma and a quote.
      target: { type: "share", id: 'has,"comma' },
      status: "denied" as const,
      ip: null,
      userAgent: null,
      requestId: null,
    },
  ];
  const csv = toCsv(sample);
  const lines = csv.split("\n");
  assert.equal(lines.length, 3, "header + two rows");
  assert.equal(
    lines[0],
    "ts,id,actorId,actorEmail,workspaceId,action,targetType,targetId,status,ip",
  );
  // ISO timestamp first column, no accidental locale formatting.
  assert.ok(lines[1]!.startsWith("2025-01-02T03:04:05.000Z,a1,u_alice,"));
  // Comma + quote in the targetId must be wrapped in double quotes with
  // internal quotes doubled, per RFC 4180.
  assert.match(lines[2]!, /"has,""comma"/);
  assert.ok(lines[2]!.endsWith(",denied,"));
});
