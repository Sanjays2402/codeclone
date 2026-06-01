/**
 * Run with: node --test --experimental-strip-types web/tests/v1-allowlist-tenant-isolation.test.ts
 *
 * Covers /v1/allowlist, the programmatic workspace IP allowlist
 * management endpoint used by SOAR / IGA pipelines (block an attacker
 * IP from a SIEM alert, sync a corporate VPN egress block on a cron,
 * pull state for SOC2 CC6.6 evidence).
 *
 * The route source is asserted to wire:
 *   - scope checks (allowlist:read for GET, allowlist:write for
 *     PUT/POST/DELETE)
 *   - billable per-key rate-limit enforce (not peek)
 *   - full workspace enforcement chain (lockdown, ws allowlist,
 *     key allowlist, residency, api-key policy)
 *   - tenant scoping via key.workspaceId only (no path that lets URL,
 *     query string, or body select a different workspace)
 *   - owner-role gate for all writes (canManage), member gate for reads
 *   - audit rows under stable v1.allowlist.* action ids with before/after
 *     diffs on writes
 *
 * The live test then exercises the same primitives the route uses
 * (findByPlaintext, hasScope, canManage, getActiveMember,
 * setIpAllowlist) across two real workspaces on the same on-disk store
 * to prove cross-tenant isolation end to end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-allow-keys-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-allow-rl-"));
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-allow-ws-"));
process.env.CODECLONE_KEYS_DIR = tmpKeys;
process.env.CODECLONE_RATELIMIT_DIR = tmpRl;
process.env.CODECLONE_WORKSPACES_DIR = tmpWs;

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "allowlist", "route.ts"),
  "utf8",
);

const { ALL_SCOPES, SCOPE_DESCRIPTIONS, createKey, findByPlaintext, hasScope } = await import(
  "../lib/api-keys.ts"
);
const {
  createWorkspace,
  getWorkspace,
  setIpAllowlist,
  canManage,
  getActiveMember,
} = await import("../lib/workspaces.ts");
const { sanitizeCidrList, MAX_CIDR_ENTRIES } = await import("../lib/ip-allowlist.ts");

test("v1/allowlist: route source wires scopes, enforce rate limit, full enforcement chain, audit", () => {
  // Scope is funneled through a shared `gate(req, scope)` helper and
  // passed to hasScope as a typed parameter.
  assert.match(routeSrc, /gate\(req, "allowlist:read"\)/);
  assert.match(routeSrc, /gate\(req, "allowlist:write"\)/);
  assert.match(routeSrc, /hasScope\(key, requiredScope\)/);
  assert.match(routeSrc, /enforceRateLimit\(/);
  assert.ok(!/peekRateLimit\(/.test(routeSrc), "v1/allowlist must enforce, not peek");
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Tenant scope is taken from the API key, never from request input.
  assert.match(routeSrc, /key\.workspaceId/);
  assert.ok(
    !/searchParams.*workspace|workspace.*searchParams/i.test(routeSrc),
    "v1/allowlist must not let query string select workspace",
  );
  // Owner-only writes mirror the dashboard rule.
  assert.match(routeSrc, /canManage\(/);
  assert.match(routeSrc, /getActiveMember\(/);
  // Audit rows for all four verbs.
  assert.match(routeSrc, /"v1\.allowlist\.read"/);
  assert.match(routeSrc, /"v1\.allowlist\.replace"/);
  assert.match(routeSrc, /"v1\.allowlist\.append"/);
  assert.match(routeSrc, /"v1\.allowlist\.clear"/);
  // Writes record before/after diffs.
  assert.match(routeSrc, /diff:\s*\{\s*before/);
});

test("v1/allowlist: ALL_SCOPES exposes allowlist:read and allowlist:write with descriptions", () => {
  assert.ok((ALL_SCOPES as readonly string[]).includes("allowlist:read"));
  assert.ok((ALL_SCOPES as readonly string[]).includes("allowlist:write"));
  assert.equal(
    typeof SCOPE_DESCRIPTIONS["allowlist:read" as keyof typeof SCOPE_DESCRIPTIONS],
    "string",
  );
  assert.equal(
    typeof SCOPE_DESCRIPTIONS["allowlist:write" as keyof typeof SCOPE_DESCRIPTIONS],
    "string",
  );
});

test("v1/allowlist: live cross-tenant isolation at the store + auth layer the route uses", async () => {
  const wsA = await createWorkspace({
    name: "Alpha",
    ownerId: "u_alice",
    ownerEmail: "alice@alpha.test",
  });
  const wsB = await createWorkspace({
    name: "Beta",
    ownerId: "u_bob",
    ownerEmail: "bob@beta.test",
  });

  const wsARec0 = await getWorkspace(wsA.id);
  const wsBRec0 = await getWorkspace(wsB.id);
  await setIpAllowlist(wsARec0!, ["10.0.0.0/8"]);
  await setIpAllowlist(wsBRec0!, ["203.0.113.0/24"]);

  const keyA = await createKey("alice-key", {
    userId: "u_alice",
    workspaceId: wsA.id,
    scopes: ["allowlist:read", "allowlist:write"],
  });
  const keyAReadOnly = await createKey("alice-ro", {
    userId: "u_alice",
    workspaceId: wsA.id,
    scopes: ["allowlist:read"],
  });
  const orphanKey = await createKey("orphan", {
    userId: "u_stranger",
    workspaceId: wsA.id,
    scopes: ["allowlist:write"],
  });
  const keyB = await createKey("bob-key", {
    userId: "u_bob",
    workspaceId: wsB.id,
    scopes: ["allowlist:read", "allowlist:write"],
  });

  const recA = await findByPlaintext(keyA.plaintext);
  const recARO = await findByPlaintext(keyAReadOnly.plaintext);
  const recOrphan = await findByPlaintext(orphanKey.plaintext);
  const recB = await findByPlaintext(keyB.plaintext);
  assert.ok(recA && recARO && recOrphan && recB);

  // Tenant binding: the route uses ONLY key.workspaceId to scope.
  assert.equal(recA!.workspaceId, wsA.id);
  assert.equal(recARO!.workspaceId, wsA.id);
  assert.equal(recOrphan!.workspaceId, wsA.id);
  assert.equal(recB!.workspaceId, wsB.id);

  // Scope gate (same hasScope call the route makes).
  assert.equal(hasScope(recA, "allowlist:read"), true);
  assert.equal(hasScope(recA, "allowlist:write"), true);
  assert.equal(hasScope(recARO, "allowlist:read"), true);
  assert.equal(
    hasScope(recARO, "allowlist:write"),
    false,
    "read-only key must NOT have write scope",
  );
  assert.equal(hasScope(recOrphan, "allowlist:write"), true);
  assert.equal(hasScope(recB, "allowlist:write"), true);

  // Owner / member gate (same canManage / getActiveMember check the route uses).
  const wsARec = await getWorkspace(wsA.id);
  const wsBRec = await getWorkspace(wsB.id);
  assert.equal(canManage(wsARec!, "u_alice"), true);
  assert.equal(
    canManage(wsARec!, "u_stranger"),
    false,
    "orphan user must not manage workspace A even though their key was minted there",
  );
  assert.equal(getActiveMember(wsARec!, "u_bob"), null, "bob is not a member of workspace A");
  assert.equal(canManage(wsBRec!, "u_bob"), true);
  assert.equal(canManage(wsBRec!, "u_alice"), false);

  // Read path: a workspace A key reading via key.workspaceId sees ONLY
  // workspace A's entries. There is no field on keyA that points at B.
  const ws_via_keyA = await getWorkspace(recA!.workspaceId!);
  assert.deepEqual(ws_via_keyA!.ipAllowlist, ["10.0.0.0/8"]);
  assert.notEqual(recA!.workspaceId, wsB.id);

  // Write path: a legitimate owner-write via keyA's workspaceId mutates
  // ONLY workspace A; B is untouched.
  await setIpAllowlist(ws_via_keyA!, sanitizeCidrList(["192.0.2.0/24"]).ok);
  const aAfter = await getWorkspace(wsA.id);
  const bAfter = await getWorkspace(wsB.id);
  assert.deepEqual(aAfter!.ipAllowlist, ["192.0.2.0/24"]);
  assert.deepEqual(
    bAfter!.ipAllowlist,
    ["203.0.113.0/24"],
    "workspace B must be untouched by a write performed via key A's workspaceId",
  );

  // Cap is real.
  assert.equal(MAX_CIDR_ENTRIES, 64);
});

test("sanitizeCidrList: dedupes and rejects malformed entries (route returns rejected list to caller)", () => {
  const { ok, rejected } = sanitizeCidrList([
    "10.0.0.0/8",
    "10.0.0.0/8",
    "not-a-cidr",
    "999.999.999.999/24",
  ]);
  assert.ok(ok.includes("10.0.0.0/8"));
  assert.equal(ok.filter((c) => c === "10.0.0.0/8").length, 1, "duplicate must be collapsed");
  assert.ok(rejected.length >= 1, "malformed inputs must surface in rejected");
});
