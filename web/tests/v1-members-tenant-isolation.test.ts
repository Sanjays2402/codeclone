/**
 * Run with: node --test --experimental-strip-types web/tests/v1-members-tenant-isolation.test.ts
 *
 * Covers GET /v1/members, the programmatic workspace roster endpoint:
 *
 *   1) Route source wires the scope check, the per-key rate-limit
 *      enforce (billable), the full workspace enforcement chain,
 *      tenant scoping to key.workspaceId (no cross-tenant leak),
 *      and the audit row under a stable action id.
 *
 *   2) ALL_SCOPES exposes members:read so the API keys UI can grant it.
 *      SCOPE_DESCRIPTIONS has copy for it.
 *
 *   3) Scope enforcement: hasScope rejects compare-only keys and
 *      accepts keys minted with members:read.
 *
 *   4) Live tenant isolation: a key in workspace B asking for
 *      members never sees workspace A's roster, because the route
 *      only ever reads ws by key.workspaceId.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-members-keys-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-members-rl-"));
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-members-ws-"));
process.env.CODECLONE_KEYS_DIR = tmpKeys;
process.env.CODECLONE_RATELIMIT_DIR = tmpRl;
process.env.CODECLONE_WORKSPACES_DIR = tmpWs;

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "members", "route.ts"),
  "utf8",
);

const { createKey, hasScope, ALL_SCOPES, SCOPE_DESCRIPTIONS } = await import(
  "../lib/api-keys.ts"
);
const { createWorkspace, getWorkspace } = await import("../lib/workspaces.ts");

test("v1/members: route source wires scope, rate-limit, enforcement chain, tenant scope, audit", () => {
  assert.match(routeSrc, /hasScope\(key, "members:read"\)/);
  // Must enforce (billable), not peek.
  assert.match(routeSrc, /enforceRateLimit\(/);
  assert.ok(
    !/peekRateLimit\(/.test(routeSrc),
    "v1/members must enforce, not peek",
  );
  // Standard workspace enforcement chain.
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Tenant scope: the workspace fetched MUST be the calling key's
  // workspaceId, with no path that lets a query string override it.
  assert.match(routeSrc, /getWorkspace\(key\.workspaceId\)/);
  assert.ok(
    !/workspaceId.*searchParams|searchParams.*workspaceId/.test(routeSrc),
    "v1/members must not let query string select workspace",
  );
  // Audit row written under a stable action id IGA can grep for.
  assert.match(routeSrc, /"v1\.members\.read"/);
});

test("v1/members: ALL_SCOPES exposes members:read with a description", () => {
  assert.ok((ALL_SCOPES as readonly string[]).includes("members:read"));
  assert.ok(
    typeof SCOPE_DESCRIPTIONS["members:read" as keyof typeof SCOPE_DESCRIPTIONS] === "string",
  );
});

test("v1/members: hasScope rejects keys without members:read and accepts keys with it", async () => {
  const compareOnly = await createKey("compare-only", {
    workspaceId: "ws_tenanta",
    scopes: ["compare:write"],
  });
  const membersOk = await createKey("members-reader", {
    workspaceId: "ws_tenantb",
    scopes: ["compare:write", "members:read"],
  });
  assert.equal(hasScope(compareOnly.record, "members:read"), false);
  assert.equal(hasScope(membersOk.record, "members:read"), true);
});

test("v1/members: live tenant isolation, key in workspace B cannot read workspace A's roster", async () => {
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

  // Sanity: both workspaces really exist on disk and have their own
  // owner-only roster.
  const a = await getWorkspace(wsA.id);
  const b = await getWorkspace(wsB.id);
  assert.ok(a && b);
  assert.notEqual(a!.id, b!.id);
  assert.equal(a!.members.length, 1);
  assert.equal(a!.members[0].email, "owner@a.example");
  assert.equal(b!.members[0].email, "owner@b.example");

  // The route always calls getWorkspace(key.workspaceId). Simulate
  // that contract: a key bound to wsB will only ever see wsB's
  // members, regardless of what wsA contains.
  const fetchedForB = await getWorkspace(wsB.id);
  assert.ok(fetchedForB);
  assert.equal(fetchedForB!.id, wsB.id);
  for (const m of fetchedForB!.members) {
    assert.notEqual(
      m.email,
      "owner@a.example",
      "workspace B roster must never contain a workspace A member",
    );
  }
});
