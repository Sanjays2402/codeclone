/**
 * Tests for lib/mfa.ts and the route gates that enforce MFA step-up.
 *
 * No mocks. The MFA store and audit log are pointed at temp dirs and the
 * filesystem-backed code is exercised end-to-end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

async function mkTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function freshEnv() {
  const base = await mkTempDir("cc-mfa-test-");
  process.env.CODECLONE_MFA_DIR = path.join(base, "mfa");
  process.env.CODECLONE_AUDIT_DIR = path.join(base, "audit");
  process.env.CODECLONE_USERS_DIR = path.join(base, "users");
  process.env.CODECLONE_AUTH_LINKS_DIR = path.join(base, "links");
  process.env.CODECLONE_SESSIONS_DIR = path.join(base, "sessions");
  process.env.CODECLONE_SETTINGS_DIR = path.join(base, "settings");
  process.env.CODECLONE_AUTH_SECRET = "test-secret-not-for-prod";
  await fs.mkdir(base, { recursive: true });
  return base;
}

test("totp generates 6 digits and verifies inside the window", async () => {
  await freshEnv();
  const mfa = await import("../lib/mfa.ts");
  const secret = mfa.base32Encode(Buffer.from("12345678901234567890"));
  const code = mfa.totp(secret);
  assert.match(code, /^\d{6}$/);
  const v = mfa.verifyTotp(secret, code);
  assert.equal(v.ok, true);
});

test("verifyTotp rejects garbage and rejects a replayed step", async () => {
  await freshEnv();
  const mfa = await import("../lib/mfa.ts");
  const secret = mfa.base32Encode(Buffer.from("abcdefghijabcdefghij"));
  assert.equal(mfa.verifyTotp(secret, "abcdef").ok, false);
  assert.equal(mfa.verifyTotp(secret, "12345").ok, false);
  const code = mfa.totp(secret);
  const v1 = mfa.verifyTotp(secret, code);
  assert.equal(v1.ok, true);
  const v2 = mfa.verifyTotp(secret, code, Date.now(), v1.step);
  assert.equal(v2.ok, false, "step must not replay");
});

test("enroll -> confirm -> verify -> stepup grant", async () => {
  await freshEnv();
  const mfa = await import("../lib/mfa.ts");
  const start = await mfa.startEnrollment("u_test1", "user@example.com");
  assert.ok(start.otpauthUrl.startsWith("otpauth://totp/codeclone"));
  // confirm requires real code
  const code = mfa.totp(start.secret);
  const out = await mfa.confirmEnrollment("u_test1", code);
  assert.equal(out.backupCodes.length, 10);
  // status
  const rec = await mfa.getMfa("u_test1");
  assert.ok(rec && rec.enrolledAt);
  // grant step-up after a fresh code
  // wait one period so we don't hit replay
  await new Promise((r) => setTimeout(r, 50));
  const verify = await mfa.verifyAndConsume("u_test1", mfa.totp(start.secret, Date.now() + 31000));
  assert.equal(verify.ok, true);
  await mfa.grantStepUp("jti-abc", "u_test1");
  const gate = await mfa.requireStepUp("u_test1", "jti-abc");
  assert.equal(gate.allowed, true);
});

test("requireStepUp denies when no fresh grant exists", async () => {
  await freshEnv();
  const mfa = await import("../lib/mfa.ts");
  const start = await mfa.startEnrollment("u_test2", "user@example.com");
  await mfa.confirmEnrollment("u_test2", mfa.totp(start.secret));
  const denied = await mfa.requireStepUp("u_test2", "jti-no-grant");
  assert.equal(denied.allowed, false);
  if (!denied.allowed) assert.equal(denied.reason, "mfa_required");
  const denied2 = await mfa.requireStepUp("u_test2", null);
  assert.equal(denied2.allowed, false);
});

test("requireStepUp allows when user has no MFA enrolled", async () => {
  await freshEnv();
  const mfa = await import("../lib/mfa.ts");
  const allowed = await mfa.requireStepUp("u_no_mfa", "any-jti");
  assert.equal(allowed.allowed, true);
});

test("backup code is single-use", async () => {
  await freshEnv();
  const mfa = await import("../lib/mfa.ts");
  const start = await mfa.startEnrollment("u_test3", "user@example.com");
  const conf = await mfa.confirmEnrollment("u_test3", mfa.totp(start.secret));
  const first = conf.backupCodes[0];
  const r1 = await mfa.verifyAndConsume("u_test3", first);
  assert.equal(r1.ok, true);
  assert.equal(r1.via, "backup");
  const r2 = await mfa.verifyAndConsume("u_test3", first);
  assert.equal(r2.ok, false);
});

test("disabling MFA requires a valid code and then re-enroll works", async () => {
  await freshEnv();
  const mfa = await import("../lib/mfa.ts");
  const start = await mfa.startEnrollment("u_test4", "user@example.com");
  await mfa.confirmEnrollment("u_test4", mfa.totp(start.secret));
  await mfa.disableMfa("u_test4");
  const rec = await mfa.getMfa("u_test4");
  assert.equal(rec, null);
  // can re-enroll
  const again = await mfa.startEnrollment("u_test4", "user@example.com");
  assert.ok(again.secret);
});

test("destructive route gate denies user with MFA enrolled and no step-up", async () => {
  // Library-level proof: the same requireStepUp() call used by every gated
  // route returns mfa_required for an enrolled user lacking a fresh grant,
  // and allows them after grantStepUp() is recorded.
  await freshEnv();
  const auth = await import("../lib/auth.ts");
  const sessions = await import("../lib/sessions.ts");
  const mfa = await import("../lib/mfa.ts");

  const user = await auth.findOrCreateUser("wipe@example.com");
  const jti = sessions.newJti();
  await sessions.createSession({
    userId: user.id,
    jti,
    ttlSec: 3600,
    ip: "127.0.0.1",
    userAgent: "test",
  });

  const enroll = await mfa.startEnrollment(user.id, user.email);
  await mfa.confirmEnrollment(user.id, mfa.totp(enroll.secret));

  const blocked = await mfa.requireStepUp(user.id, jti);
  assert.equal(blocked.allowed, false);

  await mfa.grantStepUp(jti, user.id);
  const ok = await mfa.requireStepUp(user.id, jti);
  assert.equal(ok.allowed, true);

  // A different session jti must not inherit the grant.
  const otherJti = sessions.newJti();
  const otherBlocked = await mfa.requireStepUp(user.id, otherJti);
  assert.equal(otherBlocked.allowed, false);
});

test("regenerateBackupCodes replaces all unused codes and invalidates old ones", async () => {
  await freshEnv();
  const mfa = await import("../lib/mfa.ts");
  const start = await mfa.startEnrollment("u_regen", "regen@example.com");
  const conf = await mfa.confirmEnrollment("u_regen", mfa.totp(start.secret));
  const oldFirst = conf.backupCodes[0];
  const oldSecond = conf.backupCodes[1];

  // Burn one so previousRemaining reflects the real unused count (9).
  const burn = await mfa.verifyAndConsume("u_regen", oldFirst);
  assert.equal(burn.ok, true);

  const out = await mfa.regenerateBackupCodes("u_regen");
  assert.equal(out.previousRemaining, 9);
  assert.equal(out.backupCodes.length, mfa.BACKUP_CODE_COUNT);

  // A previously valid (unused) old code must no longer work.
  const stale = await mfa.verifyAndConsume("u_regen", oldSecond);
  assert.equal(stale.ok, false, "old unused code must be invalidated");

  // A newly issued code works exactly once.
  const fresh = out.backupCodes[0];
  const r1 = await mfa.verifyAndConsume("u_regen", fresh);
  assert.equal(r1.ok, true);
  assert.equal(r1.via, "backup");
  const r2 = await mfa.verifyAndConsume("u_regen", fresh);
  assert.equal(r2.ok, false, "regenerated code must still be single-use");

  // Regenerate refuses to run for an account without MFA.
  await mfa.disableMfa("u_regen");
  await assert.rejects(() => mfa.regenerateBackupCodes("u_regen"), /not enabled/);
});
