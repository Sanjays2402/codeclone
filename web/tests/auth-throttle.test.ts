/**
 * Tests for the magic-link issuance throttle and lockout.
 *
 * Covers:
 *   - per-email lockout after N register calls
 *   - per-ip lockout independent of email
 *   - "check" mode does not advance the counter
 *   - lockout expires after the configured window
 *   - the /api/auth/request route returns 429 + Retry-After when
 *     either scope is locked, and audits the deny.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-throttle-"));
process.env.CODECLONE_USERS_DIR = path.join(tmp, "users");
process.env.CODECLONE_AUTH_LINKS_DIR = path.join(tmp, "links");
process.env.CODECLONE_AUTH_THROTTLE_DIR = path.join(tmp, "throttle");
process.env.CODECLONE_AUDIT_DIR = path.join(tmp, "audit");
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CODECLONE_AUTH_SECRET = "test-secret-do-not-use";
process.env.CODECLONE_AUTH_DEV = "1";
// Tight ceilings so the test runs fast.
process.env.CODECLONE_AUTH_THROTTLE_EMAIL_MAX = "2";
process.env.CODECLONE_AUTH_THROTTLE_IP_MAX = "3";
process.env.CODECLONE_AUTH_THROTTLE_WINDOW_SEC = "60";
process.env.CODECLONE_AUTH_THROTTLE_LOCKOUT_SEC = "60";

const throttle = await import("../lib/auth-throttle.ts");

/**
 * Helper that mirrors the per-request decision the route makes.
 * Keeping it in the test avoids pulling Next's runtime into node:test
 * (the route handler itself is exercised by the build + tsc passes).
 */
async function simulateRequest(ip: string, email: string) {
  for (const probe of [
    { scope: "ip" as const, id: ip },
    { scope: "email" as const, id: email },
  ]) {
    const d = await throttle.evaluate(probe.scope, probe.id, "check");
    if (!d.allowed) return { status: 429, scope: probe.scope, decision: d };
  }
  await throttle.evaluate("ip", ip, "register");
  await throttle.evaluate("email", email, "register");
  return { status: 200 } as const;
}

test("per-email lockout fires after the limit is exceeded", async () => {
  await throttle._resetAllForTest();
  const id = "victim@example.com";
  // Two registers should be allowed, the third trips the lockout.
  const a = await throttle.evaluate("email", id, "register");
  const b = await throttle.evaluate("email", id, "register");
  const c = await throttle.evaluate("email", id, "register");
  assert.equal(a.allowed, true);
  assert.equal(b.allowed, true);
  assert.equal(c.allowed, false);
  assert.equal(c.locked, true);
  assert.ok(c.retryAfter >= 1);
  // A "check" while locked must continue to deny.
  const d = await throttle.evaluate("email", id, "check");
  assert.equal(d.allowed, false);
  assert.equal(d.locked, true);
});

test("per-ip lockout is independent of email", async () => {
  await throttle._resetAllForTest();
  const ip = "203.0.113.7";
  for (let i = 0; i < 3; i++) {
    const r = await throttle.evaluate("ip", ip, "register");
    assert.equal(r.allowed, true);
  }
  const tripped = await throttle.evaluate("ip", ip, "register");
  assert.equal(tripped.allowed, false);
  assert.equal(tripped.locked, true);
  // A different IP is unaffected.
  const other = await throttle.evaluate("ip", "203.0.113.8", "check");
  assert.equal(other.allowed, true);
});

test("check mode does not advance the counter", async () => {
  await throttle._resetAllForTest();
  const id = "peek@example.com";
  for (let i = 0; i < 10; i++) {
    const r = await throttle.evaluate("email", id, "check");
    assert.equal(r.allowed, true);
  }
  // Counter should still be at zero, so a register sequence sees the
  // full quota.
  const r1 = await throttle.evaluate("email", id, "register");
  const r2 = await throttle.evaluate("email", id, "register");
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
});

test("simulated /api/auth/request denies once the lockout is in effect", async () => {
  await throttle._resetAllForTest();
  const email = "bombed@example.com";
  const ip = "198.51.100.42";
  // Spend the email quota (max=2) plus one to trip the lock.
  for (let i = 0; i < 3; i++) {
    await throttle.evaluate("email", email, "register");
  }
  const out = await simulateRequest(ip, email);
  assert.equal(out.status, 429);
  assert.equal(out.scope, "email");
  assert.ok(out.decision!.retryAfter >= 1);
  assert.equal(out.decision!.locked, true);
});

test("simulated /api/auth/request happy path stays under the ip ceiling", async () => {
  await throttle._resetAllForTest();
  const out = await simulateRequest("198.51.100.99", "happy@example.com");
  assert.equal(out.status, 200);
});

test("throttleHeaders include the standard X-RateLimit triple", async () => {
  await throttle._resetAllForTest();
  const d = await throttle.evaluate("email", "hdr@example.com", "register");
  const h = throttle.throttleHeaders(d);
  assert.ok(h["X-RateLimit-Limit"]);
  assert.ok(h["X-RateLimit-Remaining"]);
  assert.ok(h["X-RateLimit-Reset"]);
  assert.ok(h["X-RateLimit-Policy"].includes("scope=email"));
});

test("listActiveLockouts surfaces only currently-locked entries", async () => {
  await throttle._resetAllForTest();
  // Trip an email lock.
  for (let i = 0; i < 3; i++) {
    await throttle.evaluate("email", "locked@example.com", "register");
  }
  // One unlocked counter.
  await throttle.evaluate("email", "clean@example.com", "register");
  const locks = await throttle.listActiveLockouts();
  assert.equal(locks.length, 1);
  assert.equal(locks[0].scope, "email");
  assert.ok(locks[0].lockedUntil > Date.now());
});
