/**
 * Run with: node --test --experimental-strip-types web/tests/v1-whoami.test.ts
 *
 * Covers the GET /v1/whoami introspection endpoint at two layers:
 *
 *   1) Behaviour of the underlying primitives the route relies on:
 *      bearer extraction, key lookup by plaintext (must reject foreign
 *      tokens), peek-only rate-limit reads (must not consume a slot),
 *      revoked-key rejection, and expired-key rejection. This is the
 *      cross-tenant isolation evidence: a key minted in workspace A
 *      can never resolve to a record in workspace B, and rate-limit
 *      state read via peek() is never billed against the caller.
 *
 *   2) Source-level assertions that the route actually wires those
 *      primitives, including the audit log entry, the no-increment
 *      peek() path, and the standard workspace enforcement chain.
 *      A regression that swaps peek() for enforce() (or drops the
 *      audit row) fails this test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-whoami-keys-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-whoami-rl-"));
process.env.CODECLONE_KEYS_DIR = tmpKeys;
process.env.CODECLONE_RATELIMIT_DIR = tmpRl;

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "whoami", "route.ts"),
  "utf8",
);

const { createKey, findByPlaintext, extractBearer, revokeKey } = await import(
  "../lib/api-keys.ts"
);
const { peek, check, effectiveRpm, _resetForTest } = await import(
  "../lib/rate-limit.ts"
);

test("v1/whoami: foreign plaintext tokens never resolve to a real key (cross-tenant)", async () => {
  const a = await createKey("tenant-a-key", { workspaceId: "ws_tenanta", scopes: ["compare:write"] });
  const b = await createKey("tenant-b-key", { workspaceId: "ws_tenantb", scopes: ["compare:write"] });
  const aRec = await findByPlaintext(a.plaintext);
  const bRec = await findByPlaintext(b.plaintext);
  assert.ok(aRec && bRec);
  assert.equal(aRec!.workspaceId, "ws_tenanta");
  assert.equal(bRec!.workspaceId, "ws_tenantb");
  // A made-up token (or one belonging to no workspace) returns null.
  assert.equal(await findByPlaintext("cc_live_not_a_real_key_xxxxxxxxxxxxxxxxxx"), null);
  // Mutating the suffix of a valid plaintext must not resolve to either key.
  const tampered = a.plaintext.slice(0, -4) + "ZZZZ";
  assert.equal(await findByPlaintext(tampered), null);
});

test("v1/whoami: revoked and expired keys are rejected by the same lookup the route uses", async () => {
  const k = await createKey("to-revoke", { workspaceId: "ws_tenanta", scopes: ["compare:write"] });
  await revokeKey(k.record.id);
  assert.equal(await findByPlaintext(k.plaintext), null);

  const past = await createKey("already-expired", {
    workspaceId: "ws_tenanta",
    scopes: ["compare:write"],
    expiresInDays: 1,
  });
  // Hand-roll an expired record by rewriting the file: simplest portable path.
  const file = path.join(tmpKeys, `${past.record.id}.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.expiresAt = Date.now() - 60_000;
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(await findByPlaintext(past.plaintext), null);
});

test("v1/whoami: peek() reads the rate-limit window without consuming a slot", async () => {
  const k = await createKey("peek-key", { workspaceId: "ws_tenanta", scopes: ["compare:write"] });
  await _resetForTest(k.record.id);
  const rpm = effectiveRpm(k.record);

  // Two real requests burn two slots.
  await check(k.record.id, rpm);
  await check(k.record.id, rpm);

  // Many peeks must not move the counter.
  for (let i = 0; i < 25; i++) {
    const d = await peek(k.record.id, rpm);
    assert.equal(d.limit, rpm);
    assert.equal(d.remaining, rpm - 2, "peek must not increment the counter");
    assert.equal(d.allowed, true);
  }

  // Third real request still goes through and shows remaining == rpm - 3.
  const after = await check(k.record.id, rpm);
  assert.equal(after.remaining, rpm - 3);
});

test("v1/whoami: peek() reports allowed=false when the window is full", async () => {
  const k = await createKey("peek-fill", { workspaceId: "ws_tenanta", scopes: ["compare:write"] });
  await _resetForTest(k.record.id);
  // Use a small rpm for a fast test.
  const rpm = 3;
  for (let i = 0; i < rpm; i++) await check(k.record.id, rpm);
  const d = await peek(k.record.id, rpm);
  assert.equal(d.remaining, 0);
  assert.equal(d.allowed, false);
});

test("v1/whoami: extractBearer handles Authorization and x-api-key", () => {
  const r1 = new Request("http://x/v1/whoami", {
    headers: { authorization: "Bearer cc_live_xyz" },
  });
  assert.equal(extractBearer(r1), "cc_live_xyz");
  const r2 = new Request("http://x/v1/whoami", { headers: { "x-api-key": "cc_live_abc" } });
  assert.equal(extractBearer(r2), "cc_live_abc");
  const r3 = new Request("http://x/v1/whoami");
  assert.equal(extractBearer(r3), null);
});

test("v1/whoami: route wires peek-only rate limit (never enforceRateLimit) and writes audit", () => {
  assert.match(routeSrc, /peek as peekRateLimit/, "must import peek, not enforce");
  assert.ok(
    !/enforce as enforceRateLimit/.test(routeSrc),
    "whoami must not increment the rate-limit counter; use peek() instead",
  );
  assert.match(routeSrc, /tryRecordAudit\(/, "must write an audit row");
  assert.match(routeSrc, /v1\.whoami\.read/, "audit action must be v1.whoami.read");
  // Standard workspace enforcement chain must be present.
  for (const fn of [
    "enforceWorkspaceLockdownForKey",
    "enforceWorkspaceAllowlistForKey",
    "enforceKeyAllowlist",
    "enforceWorkspaceResidencyForKey",
    "enforceWorkspaceApiKeyPolicyForKey",
  ]) {
    assert.ok(routeSrc.includes(fn + "("), `route must call ${fn}`);
  }
  // Must not log billable usage (whoami is free).
  assert.ok(!/logUsage\(/.test(routeSrc), "whoami must not write billable usage events");
});
