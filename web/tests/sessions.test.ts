/**
 * Server-side session tracking: creation, listing, per-user isolation,
 * single revoke, revoke-all, and TTL persistence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-sessions-"));
process.env.CODECLONE_SESSIONS_DIR = path.join(tmp, "sessions");
process.env.CODECLONE_USERS_DIR = path.join(tmp, "users");
process.env.CODECLONE_AUTH_LINKS_DIR = path.join(tmp, "links");
process.env.CODECLONE_AUTH_SECRET = "test-secret-do-not-use-in-prod";

const sessions = await import("../lib/sessions.ts");
const auth = await import("../lib/auth.ts");

test("createSession persists and listSessions returns only the owner's records", async () => {
  const jtiA1 = sessions.newJti();
  const jtiA2 = sessions.newJti();
  const jtiB1 = sessions.newJti();
  await sessions.createSession({ userId: "userA", jti: jtiA1, ttlSec: 3600, ip: "1.1.1.1", userAgent: "uaA1" });
  await sessions.createSession({ userId: "userA", jti: jtiA2, ttlSec: 3600, ip: "1.1.1.2", userAgent: "uaA2" });
  await sessions.createSession({ userId: "userB", jti: jtiB1, ttlSec: 3600, ip: "2.2.2.2", userAgent: "uaB1" });

  const a = await sessions.listSessions("userA");
  const b = await sessions.listSessions("userB");
  assert.equal(a.length, 2, "user A sees 2");
  assert.equal(b.length, 1, "user B sees 1");
  // Cross-tenant isolation: A's session ids never leak into B's list.
  const aIds = new Set(a.map((s) => s.jti));
  for (const s of b) assert.ok(!aIds.has(s.jti), "no cross-user leakage");
});

test("revokeSession blocks future cookie verification for that jti only", async () => {
  const userId = "u_testCC1";
  const jti1 = sessions.newJti();
  const jti2 = sessions.newJti();
  await sessions.createSession({ userId, jti: jti1, ttlSec: 3600, ip: null, userAgent: null });
  await sessions.createSession({ userId, jti: jti2, ttlSec: 3600, ip: null, userAgent: null });

  const usersDir = process.env.CODECLONE_USERS_DIR!;
  await fs.mkdir(usersDir, { recursive: true });
  await fs.writeFile(
    path.join(usersDir, `${userId}.json`),
    JSON.stringify({ v: 1, id: userId, email: "c@x.test", createdAt: Date.now() }),
  );

  const cookie1 = auth.signSession(userId, 3600, jti1);
  const cookie2 = auth.signSession(userId, 3600, jti2);
  const cookieHeader1 = `${auth.COOKIE_NAME}=${encodeURIComponent(cookie1)}`;
  const cookieHeader2 = `${auth.COOKIE_NAME}=${encodeURIComponent(cookie2)}`;

  const ctxBefore = await auth.currentSessionFromCookieHeader(cookieHeader1);
  assert.ok(ctxBefore, "session is valid before revoke");

  await sessions.revokeSession(userId, jti1);

  const ctxAfter = await auth.currentSessionFromCookieHeader(cookieHeader1);
  assert.equal(ctxAfter, null, "revoked session no longer authenticates");

  const ctxOther = await auth.currentSessionFromCookieHeader(cookieHeader2);
  assert.ok(ctxOther, "sibling session is unaffected");
  assert.equal(ctxOther!.jti, jti2);
});

test("revokeAllSessions can preserve the current session", async () => {
  const jtiX = sessions.newJti();
  const jtiY = sessions.newJti();
  const jtiZ = sessions.newJti();
  await sessions.createSession({ userId: "userD", jti: jtiX, ttlSec: 3600, ip: null, userAgent: null });
  await sessions.createSession({ userId: "userD", jti: jtiY, ttlSec: 3600, ip: null, userAgent: null });
  await sessions.createSession({ userId: "userD", jti: jtiZ, ttlSec: 3600, ip: null, userAgent: null });

  const n = await sessions.revokeAllSessions("userD", { exceptJti: jtiY });
  assert.equal(n, 2);
  const left = await sessions.listSessions("userD");
  assert.equal(left.length, 1);
  assert.equal(left[0].jti, jtiY);
});

test("clampTtl bounds and getUserTtl round-trip", async () => {
  assert.equal(sessions.clampTtl(0), sessions.MIN_TTL_SEC);
  assert.equal(sessions.clampTtl(10_000_000_000), sessions.MAX_TTL_SEC);
  assert.equal(sessions.clampTtl(NaN), sessions.DEFAULT_TTL_SEC);

  const saved = await sessions.setUserTtl("userE", 60 * 60 * 8);
  assert.equal(saved, 60 * 60 * 8);
  const got = await sessions.getUserTtl("userE");
  assert.equal(got, 60 * 60 * 8);

  // Out of range is clamped.
  const clamped = await sessions.setUserTtl("userE", 1);
  assert.equal(clamped, sessions.MIN_TTL_SEC);
});

test("touchSession updates lastSeenAt and IP", async () => {
  const jti = sessions.newJti();
  await sessions.createSession({ userId: "userF", jti, ttlSec: 3600, ip: "9.9.9.9", userAgent: "old" });
  const before = (await sessions.getSession("userF", jti))!;
  // backdate so the throttle does not skip the write
  const back = { ...before, lastSeenAt: Date.now() - 5 * 60_000 };
  await fs.writeFile(
    path.join(process.env.CODECLONE_SESSIONS_DIR!, "userF", `${jti}.json`),
    JSON.stringify(back),
  );
  await sessions.touchSession("userF", jti, "8.8.8.8", "new");
  const after = (await sessions.getSession("userF", jti))!;
  assert.equal(after.ip, "8.8.8.8");
  assert.equal(after.userAgent, "new");
  assert.ok(after.lastSeenAt > back.lastSeenAt);
});
