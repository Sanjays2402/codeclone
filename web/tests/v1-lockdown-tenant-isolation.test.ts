/**
 * Run with: node --test --experimental-strip-types web/tests/v1-lockdown-tenant-isolation.test.ts
 *
 * Covers /v1/lockdown, the programmatic workspace break-glass
 * lockdown endpoint used by SIEM / SOAR playbooks to halt all /v1
 * traffic during a credential-compromise incident without a human
 * dashboard login (and to release it the same way).
 *
 * The route source is asserted to wire:
 *   - scope checks (lockdown:read for GET, lockdown:write for
 *     POST/DELETE)
 *   - billable per-key rate-limit enforce (not peek)
 *   - workspace policy chain MINUS the lockdown gate itself (so the
 *     SOAR playbook can release an active lockdown). All other gates
 *     are present: workspace IP allowlist, key IP allowlist,
 *     residency, api-key policy.
 *   - tenant scoping via key.workspaceId only (no path that lets URL,
 *     query string, or body select a different workspace)
 *   - owner-role gate for writes (canManage), member gate for reads
 *   - audit rows under stable v1.lockdown.* action ids with
 *     before/after diffs on writes
 *
 * The live test then exercises the same primitives the route uses
 * (findByPlaintext, hasScope, canManage, getActiveMember,
 * placeLockdown, releaseLockdown, isWorkspaceLocked) across two real
 * workspaces on the same on-disk store to prove cross-tenant
 * isolation end to end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-lockdown-keys-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-lockdown-rl-"));
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-lockdown-ws-"));
process.env.CODECLONE_KEYS_DIR = tmpKeys;
process.env.CODECLONE_RATELIMIT_DIR = tmpRl;
process.env.CODECLONE_WORKSPACES_DIR = tmpWs;

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "lockdown", "route.ts"),
  "utf8",
);

const { ALL_SCOPES, SCOPE_DESCRIPTIONS, createKey, findByPlaintext, hasScope } = await import(
  "../lib/api-keys.ts"
);
const {
  createWorkspace,
  getWorkspace,
  canManage,
  getActiveMember,
  placeLockdown,
  releaseLockdown,
  isWorkspaceLocked,
  sanitizeLockdown,
} = await import("../lib/workspaces.ts");

test("v1/lockdown: route source wires scopes, enforce rate limit, policy chain (minus lockdown), audit", () => {
  assert.match(routeSrc, /gate\(req, "lockdown:read", "\/v1\/lockdown"\)/);
  assert.match(routeSrc, /gate\(req, "lockdown:write", "\/v1\/lockdown"\)/);
  assert.match(routeSrc, /hasScope\(key, requiredScope\)/);
  assert.match(routeSrc, /enforceRateLimit\(/);
  assert.ok(!/peekRateLimit\(/.test(routeSrc), "v1/lockdown must enforce, not peek");
  // Deliberate carve-out: lockdown enforce MUST NOT run on this route or
  // an active lockdown soft-bricks the workspace from API release.
  assert.ok(
    !/enforceWorkspaceLockdownForKey/.test(routeSrc),
    "v1/lockdown must not run the lockdown enforce gate or an active lockdown cannot be lifted programmatically",
  );
  // Every other policy gate is still on.
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Tenant scope is taken from the API key, never from request input.
  assert.match(routeSrc, /key\.workspaceId/);
  assert.ok(
    !/searchParams.*workspace|workspace.*searchParams/i.test(routeSrc),
    "v1/lockdown must not let query string select workspace",
  );
  // Owner-only writes mirror the dashboard rule.
  assert.match(routeSrc, /canManage\(/);
  assert.match(routeSrc, /getActiveMember\(/);
  // Audit rows for all three verbs.
  assert.match(routeSrc, /"v1\.lockdown\.read"/);
  assert.match(routeSrc, /"v1\.lockdown\.place"/);
  assert.match(routeSrc, /"v1\.lockdown\.release"/);
  // Writes record before/after diffs.
  assert.match(routeSrc, /diff:\s*\{\s*before/);
  // Release requires the workspace slug as a confirmation token.
  assert.match(routeSrc, /confirm.*ws\.slug|ws\.slug.*confirm/s);
});

test("v1/lockdown: ALL_SCOPES exposes lockdown:read and lockdown:write with descriptions", () => {
  assert.ok((ALL_SCOPES as readonly string[]).includes("lockdown:read"));
  assert.ok((ALL_SCOPES as readonly string[]).includes("lockdown:write"));
  assert.equal(
    typeof SCOPE_DESCRIPTIONS["lockdown:read" as keyof typeof SCOPE_DESCRIPTIONS],
    "string",
  );
  assert.equal(
    typeof SCOPE_DESCRIPTIONS["lockdown:write" as keyof typeof SCOPE_DESCRIPTIONS],
    "string",
  );
});

test("sanitizeLockdown: validates reason length and caseRef charset", () => {
  assert.equal(sanitizeLockdown(null), null);
  assert.equal(sanitizeLockdown({ reason: "x" }), null, "reason < 3 must be rejected");
  assert.equal(sanitizeLockdown({ reason: "a".repeat(501) }), null, "reason > 500 must be rejected");
  const ok = sanitizeLockdown({ reason: "credential compromise", caseRef: "PD-1042" });
  assert.deepEqual(ok, { reason: "credential compromise", caseRef: "PD-1042" });
  assert.equal(
    sanitizeLockdown({ reason: "credential compromise", caseRef: "bad<chars>" }),
    null,
    "malformed caseRef must reject the whole input",
  );
});

test("v1/lockdown: live cross-tenant isolation at the store + auth layer the route uses", async () => {
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

  const keyA = await createKey("alice-key", {
    userId: "u_alice",
    workspaceId: wsA.id,
    scopes: ["lockdown:read", "lockdown:write"],
  });
  const keyAReadOnly = await createKey("alice-ro", {
    userId: "u_alice",
    workspaceId: wsA.id,
    scopes: ["lockdown:read"],
  });
  const orphanKey = await createKey("orphan", {
    userId: "u_stranger",
    workspaceId: wsA.id,
    scopes: ["lockdown:write"],
  });
  const keyB = await createKey("bob-key", {
    userId: "u_bob",
    workspaceId: wsB.id,
    scopes: ["lockdown:read", "lockdown:write"],
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
  assert.equal(hasScope(recA, "lockdown:read"), true);
  assert.equal(hasScope(recA, "lockdown:write"), true);
  assert.equal(hasScope(recARO, "lockdown:read"), true);
  assert.equal(
    hasScope(recARO, "lockdown:write"),
    false,
    "read-only key must NOT have write scope",
  );
  assert.equal(hasScope(recOrphan, "lockdown:write"), true);
  assert.equal(hasScope(recB, "lockdown:write"), true);

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

  // Write path: a legitimate owner-write via keyA's workspaceId mutates
  // ONLY workspace A; B is untouched.
  const wsAForWrite = await getWorkspace(recA!.workspaceId!);
  await placeLockdown(
    wsAForWrite!,
    sanitizeLockdown({ reason: "key compromise", caseRef: "PD-1" })!,
    "u_alice",
  );
  const aAfter = await getWorkspace(wsA.id);
  const bAfter = await getWorkspace(wsB.id);
  assert.equal(isWorkspaceLocked(aAfter), true, "workspace A must be locked after place");
  assert.equal(
    isWorkspaceLocked(bAfter),
    false,
    "workspace B must be untouched by a place performed via key A's workspaceId",
  );
  assert.equal(aAfter!.lockdown?.placedBy, "u_alice");
  assert.equal(aAfter!.lockdown?.caseRef, "PD-1");

  // Release path: same key.workspaceId, only A flips back, B is untouched.
  await releaseLockdown(aAfter!);
  const aReleased = await getWorkspace(wsA.id);
  const bAfterRelease = await getWorkspace(wsB.id);
  assert.equal(isWorkspaceLocked(aReleased), false);
  assert.equal(isWorkspaceLocked(bAfterRelease), false);

  // Cross-tenant: keyB cannot resolve to workspace A. There is no
  // request field on this route that lets a caller switch tenants.
  assert.notEqual(recB!.workspaceId, wsA.id);
});

test("v1/lockdown: release confirm token equals workspace slug, not workspace id", async () => {
  const ws = await createWorkspace({
    name: "Acme Corp",
    ownerId: "u_owner",
    ownerEmail: "owner@acme.test",
  });
  // slug derives from the name and is the confirmation token the route accepts.
  assert.equal(typeof ws.slug, "string");
  assert.ok(ws.slug.length > 0);
  // The slug is independent of the id; a SOAR misconfig that sends
  // workspace_id as confirm would be rejected. Route source enforces this.
  assert.notEqual(ws.slug, ws.id);
});
