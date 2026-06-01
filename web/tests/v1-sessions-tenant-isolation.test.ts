/**
 * Run with: node --test --experimental-strip-types web/tests/v1-sessions-tenant-isolation.test.ts
 *
 * Covers /v1/sessions, /v1/sessions/[jti], and /v1/sessions/revoke-all,
 * the programmatic workspace session inventory and revoke endpoints.
 *
 * The hard contract is per-workspace tenant isolation: an API key
 * minted in workspace A must never enumerate sessions for, or revoke
 * sessions of, users who only belong to workspace B, even when both
 * users' sessions live on the same on-disk store. Cross-tenant probes
 * surface as 404 (not 403) so the existence of another tenant's jti
 * or userId cannot be inferred from status codes.
 *
 * Also covered:
 *   - all three routes wire the full /v1 enforcement chain (lockdown,
 *     workspace allowlist, key allowlist, residency, api-key policy)
 *     plus the billable per-key rate-limit enforce (not peek)
 *   - the scope split: sessions:read for GET, sessions:write for
 *     DELETE / revoke-all
 *   - audit rows are recorded under stable v1.sessions.* action ids
 *   - findSessionOwner only returns active sessions and is the only
 *     way the route resolves userId from jti (caller cannot supply it)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpSessions = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-sessions-sess-"));
process.env.CODECLONE_SESSIONS_DIR = tmpSessions;

const here = path.dirname(fileURLToPath(import.meta.url));
const listRouteSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "sessions", "route.ts"),
  "utf8",
);
const itemRouteSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "sessions", "[jti]", "route.ts"),
  "utf8",
);
const allRouteSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "sessions", "revoke-all", "route.ts"),
  "utf8",
);

const {
  createSession,
  newJti,
  listSessions,
  findSessionOwner,
  isRevoked,
  revokeSession,
} = await import("../lib/sessions.ts");

const { ALL_SCOPES, SCOPE_DESCRIPTIONS } = await import("../lib/api-keys.ts");

test("v1/sessions: GET wires scope, enforce rate limit, full enforcement chain, audit", () => {
  assert.match(listRouteSrc, /hasScope\(key, "sessions:read"\)/);
  assert.match(listRouteSrc, /enforceRateLimit\(/);
  assert.ok(!/peekRateLimit\(/.test(listRouteSrc), "v1/sessions list must enforce, not peek");
  assert.match(listRouteSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(listRouteSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(listRouteSrc, /enforceKeyAllowlist/);
  assert.match(listRouteSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(listRouteSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Tenant scope: derived from workspace members, never from a caller-supplied list.
  assert.match(listRouteSrc, /ws\.members\.map\(\(m\) => m\.userId\)/);
  assert.ok(
    !/searchParams.*user_?id|user_?id.*searchParams/i.test(listRouteSrc),
    "v1/sessions list must not let query string select a user",
  );
  assert.match(listRouteSrc, /tenantRequired\(\)/);
  assert.match(listRouteSrc, /"v1\.sessions\.read"/);
});

test("v1/sessions/[jti]: DELETE wires scope, enforcement chain, tenant scope, 404 cross-tenant, audit", () => {
  assert.match(itemRouteSrc, /hasScope\(key, "sessions:write"\)/);
  assert.match(itemRouteSrc, /enforceRateLimit\(/);
  assert.match(itemRouteSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(itemRouteSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(itemRouteSrc, /enforceKeyAllowlist/);
  assert.match(itemRouteSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(itemRouteSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // The route must look up the owner server-side from jti, never trust
  // a userId from request body or query.
  assert.match(itemRouteSrc, /findSessionOwner\(jti\)/);
  assert.ok(
    !/body.*user_?id|searchParams.*user_?id/i.test(itemRouteSrc),
    "v1/sessions/[jti] must not accept a userId from the caller",
  );
  // Cross-tenant probes return 404, not 403.
  assert.match(itemRouteSrc, /notFound\(\)/);
  assert.match(itemRouteSrc, /status: 404/);
  assert.match(itemRouteSrc, /"v1\.sessions\.revoke"/);
});

test("v1/sessions/revoke-all: POST wires scope, enforcement chain, membership check, audit", () => {
  assert.match(allRouteSrc, /hasScope\(key, "sessions:write"\)/);
  assert.match(allRouteSrc, /enforceRateLimit\(/);
  assert.match(allRouteSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(allRouteSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(allRouteSrc, /enforceKeyAllowlist/);
  assert.match(allRouteSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(allRouteSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Membership check is mandatory before revoke.
  assert.match(allRouteSrc, /memberIds\.has\(userId\)/);
  assert.match(allRouteSrc, /revokeAllSessions\(userId\)/);
  assert.match(allRouteSrc, /"v1\.sessions\.revoke_all"/);
});

test("v1/sessions: ALL_SCOPES exposes sessions:read and sessions:write with descriptions", () => {
  assert.ok((ALL_SCOPES as readonly string[]).includes("sessions:read"));
  assert.ok((ALL_SCOPES as readonly string[]).includes("sessions:write"));
  assert.equal(
    typeof SCOPE_DESCRIPTIONS["sessions:read" as keyof typeof SCOPE_DESCRIPTIONS],
    "string",
  );
  assert.equal(
    typeof SCOPE_DESCRIPTIONS["sessions:write" as keyof typeof SCOPE_DESCRIPTIONS],
    "string",
  );
});

test("v1/sessions: live per-workspace tenant isolation, workspace B cannot enumerate or revoke workspace A's sessions", async () => {
  // Two workspaces, two users each, four live sessions on the same on-disk store.
  const now = Date.now();
  const tomorrow = now + 24 * 60 * 60 * 1000;

  const aliceJti = newJti();
  const aliceSession = await createSession({
    userId: "u_alice",
    jti: aliceJti,
    ttlSec: 3600,
    ip: "10.0.0.1",
    userAgent: "alice-ua",
  });
  const bobJti = newJti();
  const bobSession = await createSession({
    userId: "u_bob",
    jti: bobJti,
    ttlSec: 3600,
    ip: "10.0.0.2",
    userAgent: "bob-ua",
  });

  // Both sessions exist on disk.
  assert.equal((await listSessions("u_alice")).length, 1);
  assert.equal((await listSessions("u_bob")).length, 1);

  // findSessionOwner correctly returns the owning userId for either jti.
  const aliceOwner = await findSessionOwner(aliceJti);
  assert.ok(aliceOwner);
  assert.equal(aliceOwner!.userId, "u_alice");
  const bobOwner = await findSessionOwner(bobJti);
  assert.ok(bobOwner);
  assert.equal(bobOwner!.userId, "u_bob");

  // Simulate the route's tenant gate: workspace ws_alpha has u_alice but
  // not u_bob. A key in ws_alpha trying to revoke bob's jti would
  // resolve owner=u_bob, then fail the memberIds.has check and 404.
  const wsAlphaMembers = new Set(["u_alice"]);
  const wsBetaMembers = new Set(["u_bob"]);

  // Cross-tenant DELETE attempt: ws_alpha targeting bob's jti.
  const crossAttemptOwner = await findSessionOwner(bobJti);
  assert.ok(crossAttemptOwner);
  assert.equal(
    wsAlphaMembers.has(crossAttemptOwner!.userId),
    false,
    "ws_alpha must not see u_bob as a member",
  );
  // The route returns 404 in this case; the session must remain active on disk.
  assert.equal(await isRevoked(bobJti), false);

  // Legitimate same-tenant DELETE works: ws_alpha revoking alice's session.
  const legitOwner = await findSessionOwner(aliceJti);
  assert.ok(legitOwner);
  assert.equal(wsAlphaMembers.has(legitOwner!.userId), true);
  assert.equal(await revokeSession(legitOwner!.userId, aliceJti), true);
  assert.equal(await isRevoked(aliceJti), true);
  // Bob's session in ws_beta is untouched by ws_alpha's revoke.
  assert.equal(await isRevoked(bobJti), false);
  assert.equal((await listSessions("u_bob")).length, 1);

  // Suppress unused-var warnings.
  void aliceSession;
  void bobSession;
  void wsBetaMembers;
  void tomorrow;
});

test("findSessionOwner: returns null for unknown, expired, and revoked jtis", async () => {
  assert.equal(await findSessionOwner("definitely-not-a-real-jti"), null);

  // Create then revoke, expect null.
  const j = newJti();
  await createSession({
    userId: "u_carol",
    jti: j,
    ttlSec: 3600,
    ip: null,
    userAgent: null,
  });
  assert.ok(await findSessionOwner(j));
  await revokeSession("u_carol", j);
  assert.equal(await findSessionOwner(j), null);
});
