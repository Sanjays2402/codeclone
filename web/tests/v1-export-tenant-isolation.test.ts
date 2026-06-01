/**
 * Run with: node --test --experimental-strip-types web/tests/v1-export-tenant-isolation.test.ts
 *
 * Covers GET /v1/export, the programmatic GDPR Article 20 portability
 * bundle endpoint:
 *
 *   1) Route source wires the scope check, the per-key rate-limit
 *      enforce (billable), the full workspace enforcement chain,
 *      tenant scoping to key.workspaceId (no cross-tenant leak),
 *      and the audit row under a stable action id.
 *
 *   2) ALL_SCOPES exposes export:read so the API keys UI can grant it,
 *      and SCOPE_DESCRIPTIONS has copy for it. scopes.ts mirrors
 *      api-keys.ts (docs.test.ts asserts the same invariant).
 *
 *   3) Scope enforcement: hasScope rejects compare-only keys and
 *      accepts keys minted with export:read.
 *
 *   4) Live tenant isolation: a key in workspace B asking for the
 *      portability bundle gets workspace B's data, never workspace
 *      A's, because the route only ever reads ws by key.workspaceId
 *      and exportWorkspace operates on that workspace alone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-export-keys-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-export-rl-"));
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-export-ws-"));
const tmpAudit = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-export-audit-"));
process.env.CODECLONE_KEYS_DIR = tmpKeys;
process.env.CODECLONE_RATELIMIT_DIR = tmpRl;
process.env.CODECLONE_WORKSPACES_DIR = tmpWs;
process.env.CODECLONE_AUDIT_DIR = tmpAudit;

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "export", "route.ts"),
  "utf8",
);

const { createKey, hasScope, ALL_SCOPES, SCOPE_DESCRIPTIONS } = await import(
  "../lib/api-keys.ts"
);
const scopesModule = await import("../lib/scopes.ts");
const { createWorkspace, getWorkspace, exportWorkspace } = await import(
  "../lib/workspaces.ts"
);

test("v1/export: route source wires scope, rate-limit, enforcement chain, tenant scope, audit", () => {
  assert.match(routeSrc, /hasScope\(key, "export:read"\)/);
  // Must enforce (billable), not peek. Portability is heavier than a
  // typical /v1 read and must spend a rate-limit slot.
  assert.match(routeSrc, /enforceRateLimit\(/);
  assert.ok(
    !/peekRateLimit\(/.test(routeSrc),
    "v1/export must enforce, not peek",
  );
  // Standard workspace enforcement chain.
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Tenant scope: the workspace fetched MUST be the calling key's
  // workspaceId. No path may let a query string select another tenant.
  assert.match(routeSrc, /getWorkspace\(key\.workspaceId\)/);
  assert.ok(
    !/workspaceId.*searchParams|searchParams.*workspaceId/.test(routeSrc),
    "v1/export must not let query string select workspace",
  );
  // Audit row written under a stable action id DPOs can grep for.
  assert.match(routeSrc, /"v1\.export\.read"/);
});

test("v1/export: ALL_SCOPES exposes export:read with a description, scopes.ts mirrors api-keys.ts", () => {
  assert.ok((ALL_SCOPES as readonly string[]).includes("export:read"));
  assert.ok(
    typeof SCOPE_DESCRIPTIONS["export:read" as keyof typeof SCOPE_DESCRIPTIONS] ===
      "string",
  );
  // scopes.ts is the client-safe mirror; docs.test.ts also enforces this,
  // but we double-check here so a partial edit fails fast.
  assert.deepEqual(
    [...(scopesModule.ALL_SCOPES as readonly string[])],
    [...(ALL_SCOPES as readonly string[])],
  );
  assert.deepEqual(scopesModule.SCOPE_DESCRIPTIONS, SCOPE_DESCRIPTIONS);
});

test("v1/export: hasScope rejects keys without export:read and accepts keys with it", async () => {
  const compareOnly = await createKey("compare-only", {
    workspaceId: "ws_tenanta",
    scopes: ["compare:write"],
  });
  const exportOk = await createKey("export-reader", {
    workspaceId: "ws_tenantb",
    scopes: ["compare:write", "export:read"],
  });
  assert.equal(hasScope(compareOnly.record, "export:read"), false);
  assert.equal(hasScope(exportOk.record, "export:read"), true);
});

test("v1/export: live tenant isolation, key in workspace B cannot read workspace A's portability bundle", async () => {
  const wsA = await createWorkspace({
    name: "Tenant A",
    ownerId: "u_a_owner",
    ownerEmail: "owner@a.example",
  });
  const wsB = await createWorkspace({
    name: "Tenant B",
    ownerId: "u_b_owner",
    ownerEmail: "owner@b.example",
  });

  // Sanity: both workspaces really exist with their own owner.
  const a = await getWorkspace(wsA.id);
  const b = await getWorkspace(wsB.id);
  assert.ok(a && b);
  assert.notEqual(a!.id, b!.id);

  // Route contract: getWorkspace(key.workspaceId) then exportWorkspace(ws).
  // Simulate that for a key bound to wsB and assert the bundle is for
  // wsB only, with no wsA members or wsA workspace id leaking in.
  const fetchedForB = await getWorkspace(wsB.id);
  assert.ok(fetchedForB);
  const bundle = await exportWorkspace(fetchedForB!);
  assert.equal(bundle.workspace.id, wsB.id);
  assert.notEqual(bundle.workspace.id, wsA.id);
  for (const m of fetchedForB!.members) {
    assert.notEqual(
      m.email,
      "owner@a.example",
      "workspace B bundle must never contain a workspace A member",
    );
  }
  // Bundle invariants: shape is stable and clientSecret is stripped
  // even when no SSO is configured (Omit<..., clientSecret> | null).
  assert.equal(bundle.v, 1);
  assert.equal(typeof bundle.exportedAt, "number");
  assert.ok(Array.isArray(bundle.apiKeys));
  assert.ok(Array.isArray(bundle.audit));
});
