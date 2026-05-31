/**
 * Workspace session policy enforcement.
 *
 * Verifies:
 *   - sanitizeSessionPolicy clamps to bounds and accepts 0 = unlimited
 *   - setSessionPolicy persists and clears
 *   - effectiveSessionPolicyForUser picks the strictest non-zero values
 *     across multiple workspaces
 *   - currentSessionFromCookieHeader rejects sessions that exceed the
 *     workspace's max lifetime or idle timeout (the real enforcement path)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-sp-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CODECLONE_USERS_DIR = path.join(tmp, "users");
process.env.CODECLONE_SESSIONS_DIR = path.join(tmp, "sessions");
process.env.CODECLONE_AUTH_LINKS_DIR = path.join(tmp, "links");
process.env.CODECLONE_AUTH_SECRET = "test-secret-for-session-policy";

const ws = await import("../lib/workspaces.ts");
const auth = await import("../lib/auth.ts");
const sessions = await import("../lib/sessions.ts");

test("sanitizeSessionPolicy clamps to bounds and respects 0", () => {
  assert.deepEqual(
    ws.sanitizeSessionPolicy({ maxLifetimeSec: 0, idleTimeoutSec: 0 }),
    { maxLifetimeSec: 0, idleTimeoutSec: 0, maxConcurrentSessions: 0 },
  );
  const huge = ws.sanitizeSessionPolicy({ maxLifetimeSec: 9999999999, idleTimeoutSec: 9999999999 });
  assert.ok(huge);
  assert.equal(huge!.maxLifetimeSec, ws.SESSION_POLICY_BOUNDS.maxLifetime.max);
  assert.equal(huge!.idleTimeoutSec, ws.SESSION_POLICY_BOUNDS.idleTimeout.max);
  const tiny = ws.sanitizeSessionPolicy({ maxLifetimeSec: 1, idleTimeoutSec: 1 });
  assert.ok(tiny);
  assert.equal(tiny!.maxLifetimeSec, ws.SESSION_POLICY_BOUNDS.maxLifetime.min);
  assert.equal(tiny!.idleTimeoutSec, ws.SESSION_POLICY_BOUNDS.idleTimeout.min);
  assert.equal(ws.sanitizeSessionPolicy(null), null);
  assert.equal(ws.sanitizeSessionPolicy({ maxLifetimeSec: "x" as unknown } as never), null);
});

test("setSessionPolicy persists and clears", async () => {
  const w = await ws.createWorkspace({
    name: "Policy team",
    ownerId: "u_owner000001",
    ownerEmail: "owner@example.com",
  });
  const after = await ws.setSessionPolicy(w, { maxLifetimeSec: 3600, idleTimeoutSec: 900 }, "u_owner000001");
  assert.equal(after.sessionPolicy?.maxLifetimeSec, 3600);
  assert.equal(after.sessionPolicy?.idleTimeoutSec, 900);
  assert.equal(after.sessionPolicy?.updatedBy, "u_owner000001");
  const reread = await ws.getWorkspace(w.id);
  assert.equal(reread?.sessionPolicy?.maxLifetimeSec, 3600);
  const cleared = await ws.setSessionPolicy(reread!, null, "u_owner000001");
  assert.equal(cleared.sessionPolicy, null);
});

test("effectiveSessionPolicyForUser picks strictest non-zero across workspaces", async () => {
  const uid = "u_multi0000001";
  const w1 = await ws.createWorkspace({ name: "WS One", ownerId: uid, ownerEmail: "m@example.com" });
  const w2 = await ws.createWorkspace({ name: "WS Two", ownerId: uid, ownerEmail: "m@example.com" });
  await ws.setSessionPolicy(w1, { maxLifetimeSec: 86400, idleTimeoutSec: 0 }, uid);
  await ws.setSessionPolicy(w2, { maxLifetimeSec: 3600, idleTimeoutSec: 600 }, uid);
  const eff = await ws.effectiveSessionPolicyForUser(uid);
  assert.equal(eff.maxLifetimeSec, 3600, "should pick smaller max");
  assert.equal(eff.idleTimeoutSec, 600, "should pick the only non-zero idle");
  // User in no workspace with a policy: 0/0.
  const lone = await ws.effectiveSessionPolicyForUser("u_lonely000001");
  assert.equal(lone.maxLifetimeSec, 0);
  assert.equal(lone.idleTimeoutSec, 0);
});

test("currentSessionFromCookieHeader enforces workspace max lifetime", async () => {
  const user = await auth.findOrCreateUser("policy-enforce@example.com");
  const w = await ws.createWorkspace({
    name: "Enforce team",
    ownerId: user.id,
    ownerEmail: user.email,
  });
  await ws.setSessionPolicy(w, { maxLifetimeSec: 3600, idleTimeoutSec: 0 }, user.id);

  const jti = sessions.newJti();
  const rec = await sessions.createSession({
    userId: user.id,
    jti,
    ttlSec: 60 * 60 * 24 * 30,
    ip: null,
    userAgent: null,
  });
  rec.createdAt = Date.now() - 2 * 3600 * 1000;
  rec.lastSeenAt = Date.now();
  await fs.writeFile(
    path.join(process.env.CODECLONE_SESSIONS_DIR!, encodeURIComponent(user.id), `${jti}.json`),
    JSON.stringify(rec) + "\n",
    "utf8",
  );

  const cookie = `${auth.COOKIE_NAME}=${auth.signSession(user.id, 60 * 60 * 24 * 30, jti)}`;
  const ctx = await auth.currentSessionFromCookieHeader(cookie);
  assert.equal(ctx, null, "expired-by-policy session must be rejected");

  await ws.setSessionPolicy((await ws.getWorkspace(w.id))!, null, user.id);
  const ctx2 = await auth.currentSessionFromCookieHeader(cookie);
  assert.ok(ctx2, "session must be accepted once policy is cleared");
  assert.equal(ctx2!.user.id, user.id);
});

test("currentSessionFromCookieHeader enforces workspace idle timeout", async () => {
  const user = await auth.findOrCreateUser("idle-enforce@example.com");
  const w = await ws.createWorkspace({
    name: "Idle team",
    ownerId: user.id,
    ownerEmail: user.email,
  });
  await ws.setSessionPolicy(w, { maxLifetimeSec: 0, idleTimeoutSec: 600 }, user.id);

  const jti = sessions.newJti();
  const rec = await sessions.createSession({
    userId: user.id,
    jti,
    ttlSec: 60 * 60 * 24 * 30,
    ip: null,
    userAgent: null,
  });
  rec.lastSeenAt = Date.now() - 20 * 60 * 1000;
  await fs.writeFile(
    path.join(process.env.CODECLONE_SESSIONS_DIR!, encodeURIComponent(user.id), `${jti}.json`),
    JSON.stringify(rec) + "\n",
    "utf8",
  );

  const cookie = `${auth.COOKIE_NAME}=${auth.signSession(user.id, 60 * 60 * 24 * 30, jti)}`;
  const ctx = await auth.currentSessionFromCookieHeader(cookie);
  assert.equal(ctx, null, "idle session must be rejected by workspace policy");
});
