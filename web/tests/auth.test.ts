/**
 * Auth: magic-link issuance, consumption, and session-cookie roundtrip.
 *
 * Runs against a temp users/links dir so it leaves no trace.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-auth-"));
process.env.CODECLONE_USERS_DIR = path.join(tmp, "users");
process.env.CODECLONE_AUTH_LINKS_DIR = path.join(tmp, "links");
process.env.CODECLONE_AUTH_SECRET = "test-secret-do-not-use-in-prod";

const auth = await import("../lib/auth.ts");

test("normalizeEmail accepts valid and rejects junk", () => {
  assert.equal(auth.normalizeEmail("Foo@Example.COM"), "foo@example.com");
  assert.equal(auth.normalizeEmail("  bar@baz.io "), "bar@baz.io");
  assert.equal(auth.normalizeEmail("not-an-email"), null);
  assert.equal(auth.normalizeEmail(""), null);
  assert.equal(auth.normalizeEmail(42 as unknown), null);
});

test("magic link issue, consume, and one-shot semantics", async () => {
  const issued = await auth.issueMagicLink("alice@example.com", "https://x.test", "/history");
  assert.ok(issued.url.includes("/api/auth/verify?token="));
  assert.ok(issued.url.includes("redirect=%2Fhistory"));
  // First consume succeeds and creates the user.
  const u = await auth.consumeMagicLink(`${issued.id}.${issued.secret}`);
  assert.ok(u, "user returned");
  assert.equal(u!.email, "alice@example.com");
  // Replays fail.
  const replay = await auth.consumeMagicLink(`${issued.id}.${issued.secret}`);
  assert.equal(replay, null);
  // Wrong secret fails.
  const issued2 = await auth.issueMagicLink("bob@example.com", "https://x.test");
  const bad = await auth.consumeMagicLink(`${issued2.id}.totally-wrong-secret-value`);
  assert.equal(bad, null);
  // Malformed tokens fail safely.
  assert.equal(await auth.consumeMagicLink("garbage"), null);
  assert.equal(await auth.consumeMagicLink(""), null);
});

test("user is deterministic per email and persists to disk", async () => {
  const a1 = await auth.findOrCreateUser("carol@example.com");
  const a2 = await auth.findOrCreateUser("carol@example.com");
  assert.equal(a1.id, a2.id);
  assert.equal(a1.createdAt, a2.createdAt, "second call returns the stored record");
  const onDisk = await auth.getUser(a1.id);
  assert.ok(onDisk);
  assert.equal(onDisk!.email, "carol@example.com");
});

test("session cookie signs, verifies, and rejects tampering", () => {
  const token = auth.signSession("u_abc123def4");
  const ok = auth.verifySession(token);
  assert.ok(ok);
  assert.equal(ok!.uid, "u_abc123def4");

  // Tamper with the body.
  const [body, sig] = token.split(".");
  const tampered = Buffer.from('{"uid":"attacker","iat":0,"exp":9999999999}').toString("base64url") + "." + sig;
  assert.equal(auth.verifySession(tampered), null);

  // Tamper with the signature.
  assert.equal(auth.verifySession(body + ".AAAA"), null);
  assert.equal(auth.verifySession(""), null);
  assert.equal(auth.verifySession(null), null);
});

test("currentUserFromCookieHeader parses real Cookie header", async () => {
  const user = await auth.findOrCreateUser("dave@example.com");
  const cookie = auth.signSession(user.id);
  const header = `foo=bar; ${auth.COOKIE_NAME}=${encodeURIComponent(cookie)}; baz=qux`;
  const got = await auth.currentUserFromCookieHeader(header);
  assert.ok(got);
  assert.equal(got!.email, "dave@example.com");
  assert.equal(await auth.currentUserFromCookieHeader(null), null);
  assert.equal(await auth.currentUserFromCookieHeader(""), null);
});
