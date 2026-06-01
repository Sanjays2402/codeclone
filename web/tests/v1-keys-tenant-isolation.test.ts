/**
 * Run with: node --test --experimental-strip-types web/tests/v1-keys-tenant-isolation.test.ts
 *
 * Covers /v1/keys and /v1/keys/[id], the programmatic workspace API
 * key inventory + rotation endpoints. These exist so enterprise
 * customers can wire CodeClone into the same SOAR / IGA pipelines
 * they already use for cloud IAM keys (SOC2 CC6.1 + CC6.3 rotation
 * evidence on a defined cadence, commonly 90 days).
 *
 * The hard contract is per-workspace tenant isolation: a key minted
 * in workspace A must never list, inspect, rotate, or revoke a key
 * in workspace B, even though both live on the same on-disk store.
 * Cross-tenant probes must surface as 404 (not 403) so the existence
 * of another tenant's key id cannot be inferred from status codes.
 *
 * Also covered:
 *   - both routes wire the full /v1 enforcement chain (lockdown,
 *     workspace allowlist, key allowlist, residency, api-key policy)
 *     plus the billable per-key rate-limit enforce (not peek)
 *   - the scope split: keys:read for GET, keys:write for POST/DELETE
 *   - self-target protection: a caller cannot rotate or revoke the
 *     key it is currently authenticating with
 *   - audit rows are recorded under stable v1.keys.* action ids
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-keys-keys-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-keys-rl-"));
process.env.CODECLONE_KEYS_DIR = tmpKeys;
process.env.CODECLONE_RATELIMIT_DIR = tmpRl;

const here = path.dirname(fileURLToPath(import.meta.url));
const listRouteSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "keys", "route.ts"),
  "utf8",
);
const itemRouteSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "keys", "[id]", "route.ts"),
  "utf8",
);
const rotateAliasSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "keys", "[id]", "rotate", "route.ts"),
  "utf8",
);

const {
  hasScope,
  ALL_SCOPES,
  SCOPE_DESCRIPTIONS,
  createKey,
  listKeysForWorkspace,
  loadKeyForWorkspace,
  rotateKeyForWorkspace,
  revokeKeyForWorkspace,
  loadKey,
} = await import("../lib/api-keys.ts");

test("v1/keys: list route wires scope, enforce-rate-limit, full enforcement chain, tenant scope, audit", () => {
  assert.match(listRouteSrc, /hasScope\(key, "keys:read"\)/);
  assert.match(listRouteSrc, /enforceRateLimit\(/);
  assert.ok(
    !/peekRateLimit\(/.test(listRouteSrc),
    "v1/keys must enforce, not peek the rate limit",
  );
  assert.match(listRouteSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(listRouteSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(listRouteSrc, /enforceKeyAllowlist/);
  assert.match(listRouteSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(listRouteSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Tenant scope: the store call is always bound to key.workspaceId.
  // No path that lets a query string or body pick a different workspace.
  assert.match(listRouteSrc, /listKeysForWorkspace\(key\.workspaceId\)/);
  assert.ok(
    !/workspaceId.*searchParams|searchParams.*workspaceId/.test(listRouteSrc),
    "v1/keys must not let query string select workspace",
  );
  // Unbound keys (no workspace) are rejected, not silently widened.
  assert.match(listRouteSrc, /tenantRequired\(\)/);
  assert.match(listRouteSrc, /"v1\.keys\.read"/);
});

test("v1/keys/[id]: inspect/rotate/revoke route wires scopes, enforce-rate-limit, full enforcement chain, tenant scope, audit", () => {
  assert.match(itemRouteSrc, /hasScope\(key, "keys:read"\)/);
  assert.match(itemRouteSrc, /hasScope\(key, "keys:write"\)/);
  assert.match(itemRouteSrc, /enforceRateLimit\(/);
  assert.ok(
    !/peekRateLimit\(/.test(itemRouteSrc),
    "v1/keys/[id] must enforce, not peek the rate limit",
  );
  assert.match(itemRouteSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(itemRouteSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(itemRouteSrc, /enforceKeyAllowlist/);
  assert.match(itemRouteSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(itemRouteSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Every store call is bound to key.workspaceId. No path that
  // accepts a workspaceId from the URL.
  assert.match(itemRouteSrc, /loadKeyForWorkspace\(id, key\.workspaceId!\)/);
  assert.match(itemRouteSrc, /rotateKeyForWorkspace\(id, key\.workspaceId!\)/);
  assert.match(itemRouteSrc, /revokeKeyForWorkspace\(id, key\.workspaceId!\)/);
  // Self-target protection: caller cannot brick or lock itself out.
  assert.match(itemRouteSrc, /id === key\.id/);
  assert.match(itemRouteSrc, /selfTarget\(\)/);
  // Cross-tenant probes return 404, not 403.
  assert.match(itemRouteSrc, /notFound\(\)/);
  assert.match(itemRouteSrc, /status: 404/);
  // Audit rows under stable action ids.
  assert.match(itemRouteSrc, /"v1\.keys\.inspect"/);
  assert.match(itemRouteSrc, /"v1\.keys\.rotate"/);
  assert.match(itemRouteSrc, /"v1\.keys\.revoke"/);
});

test("v1/keys/[id]/rotate: canonical subpath re-exports the POST handler", () => {
  assert.match(rotateAliasSrc, /export\s*\{\s*POST\s*\}\s*from\s*"\.\.\/route"/);
});

test("v1/keys: ALL_SCOPES exposes keys:read and keys:write with descriptions", () => {
  assert.ok((ALL_SCOPES as readonly string[]).includes("keys:read"));
  assert.ok((ALL_SCOPES as readonly string[]).includes("keys:write"));
  assert.equal(
    typeof SCOPE_DESCRIPTIONS["keys:read" as keyof typeof SCOPE_DESCRIPTIONS],
    "string",
  );
  assert.equal(
    typeof SCOPE_DESCRIPTIONS["keys:write" as keyof typeof SCOPE_DESCRIPTIONS],
    "string",
  );
});

test("v1/keys: hasScope enforces keys:read and keys:write independently", async () => {
  const readOnly = await createKey("keys-reader", {
    userId: "u_reader",
    workspaceId: "ws_reader01",
    scopes: ["keys:read"],
  });
  const writeOnly = await createKey("keys-writer", {
    userId: "u_writer",
    workspaceId: "ws_writer01",
    scopes: ["keys:write"],
  });
  const compareOnly = await createKey("compare-only", {
    userId: "u_other",
    workspaceId: "ws_other01",
    scopes: ["compare:write"],
  });
  assert.equal(hasScope(readOnly.record, "keys:read"), true);
  assert.equal(hasScope(readOnly.record, "keys:write"), false);
  assert.equal(hasScope(writeOnly.record, "keys:write"), true);
  assert.equal(hasScope(writeOnly.record, "keys:read"), false);
  assert.equal(hasScope(compareOnly.record, "keys:read"), false);
  assert.equal(hasScope(compareOnly.record, "keys:write"), false);
});

test("v1/keys: live per-workspace tenant isolation, workspace B's key can never see, rotate, or revoke workspace A's keys", async () => {
  // Two workspaces, fresh keys minted in each, same on-disk store.
  const aliceAdmin = await createKey("ws-a admin", {
    userId: "u_alice",
    workspaceId: "ws_alpha01",
    scopes: ["keys:read", "keys:write"],
  });
  const aliceData = await createKey("ws-a data", {
    userId: "u_alice",
    workspaceId: "ws_alpha01",
    scopes: ["compare:write"],
  });
  const bobAdmin = await createKey("ws-b admin", {
    userId: "u_bob",
    workspaceId: "ws_beta001",
    scopes: ["keys:read", "keys:write"],
  });
  const bobData = await createKey("ws-b data", {
    userId: "u_bob",
    workspaceId: "ws_beta001",
    scopes: ["compare:write"],
  });

  // Per-workspace inventory is partitioned.
  const alphaList = await listKeysForWorkspace("ws_alpha01");
  const betaList = await listKeysForWorkspace("ws_beta001");
  const alphaIds = new Set(alphaList.map((k) => k.id));
  const betaIds = new Set(betaList.map((k) => k.id));
  assert.ok(alphaIds.has(aliceAdmin.record.id));
  assert.ok(alphaIds.has(aliceData.record.id));
  assert.ok(!alphaIds.has(bobAdmin.record.id));
  assert.ok(!alphaIds.has(bobData.record.id));
  assert.ok(betaIds.has(bobAdmin.record.id));
  assert.ok(betaIds.has(bobData.record.id));
  assert.ok(!betaIds.has(aliceAdmin.record.id));
  assert.ok(!betaIds.has(aliceData.record.id));

  // Cross-tenant inspect: Bob's workspace trying to load Alice's key id
  // by guessing must come back null. The route surfaces this as 404.
  const crossLoad = await loadKeyForWorkspace(aliceData.record.id, "ws_beta001");
  assert.equal(
    crossLoad,
    null,
    "ws_beta001 must not be able to inspect ws_alpha01's key by id",
  );

  // Cross-tenant rotate: must come back null and must NOT mutate the
  // victim record's hash or prefix.
  const beforeAlice = await loadKey(aliceData.record.id);
  const crossRotate = await rotateKeyForWorkspace(aliceData.record.id, "ws_beta001");
  assert.equal(
    crossRotate,
    null,
    "ws_beta001 must not be able to rotate ws_alpha01's key",
  );
  const afterAlice = await loadKey(aliceData.record.id);
  assert.ok(beforeAlice && afterAlice);
  assert.equal(
    afterAlice!.hash,
    beforeAlice!.hash,
    "alice's key hash must be untouched by a cross-tenant rotate attempt",
  );
  assert.equal(
    afterAlice!.prefix,
    beforeAlice!.prefix,
    "alice's key prefix must be untouched by a cross-tenant rotate attempt",
  );

  // Cross-tenant revoke: must come back false and must NOT flip the
  // revoked bit on the victim.
  const crossRevoke = await revokeKeyForWorkspace(aliceData.record.id, "ws_beta001");
  assert.equal(
    crossRevoke,
    false,
    "ws_beta001 must not be able to revoke ws_alpha01's key",
  );
  const stillActive = await loadKey(aliceData.record.id);
  assert.ok(stillActive);
  assert.notEqual(
    stillActive!.revoked,
    true,
    "alice's key must remain active after a cross-tenant revoke attempt",
  );

  // And the legitimate operations on Bob's own workspace still work.
  const ownRotate = await rotateKeyForWorkspace(bobData.record.id, "ws_beta001");
  assert.ok(ownRotate, "ws_beta001 must be able to rotate its own key");
  assert.notEqual(
    ownRotate!.record.prefix,
    bobData.record.prefix,
    "rotation must change the prefix",
  );
  const ownRevoke = await revokeKeyForWorkspace(bobData.record.id, "ws_beta001");
  assert.equal(ownRevoke, true, "ws_beta001 must be able to revoke its own key");
});
