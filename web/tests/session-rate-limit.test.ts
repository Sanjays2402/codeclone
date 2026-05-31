/**
 * Per-user session rate limiter and isolation tests.
 *
 * Verifies:
 *  - distinct users do NOT share a counter (no cross-tenant bleed)
 *  - exceeding the bucket limit yields a 429 with standard headers
 *  - separate buckets are independent
 *  - anonymous callers fall back to a per-IP bucket
 *  - env override changes the effective limit
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-srl-"));
process.env.CODECLONE_SESSION_RATELIMIT_DIR = tmp;
process.env.CODECLONE_SESSION_RATELIMIT_COMPARE_RPM = "3";
process.env.CODECLONE_SESSION_RATELIMIT_SNIPPETS_RPM = "2";

const {
  enforceSession,
  tooManyRequestsResponse,
  bucketLimit,
  _resetForTest,
} = await import("../lib/session-rate-limit.ts");

function fakeReq(headers: Record<string, string> = {}): { headers: Headers } {
  return { headers: new Headers(headers) };
}

test("bucketLimit honors env overrides", () => {
  assert.equal(bucketLimit("compare"), 3);
  assert.equal(bucketLimit("snippets-write"), 2);
});

test("per-user counters are isolated (no cross-tenant bleed)", async () => {
  await _resetForTest();
  const req = fakeReq();
  for (let i = 0; i < 3; i++) {
    const r = await enforceSession(req, "user_alice", "compare");
    assert.equal(r.decision.allowed, true, `alice call ${i + 1} should be allowed`);
  }
  // Alice's 4th must be denied.
  const aliceOver = await enforceSession(req, "user_alice", "compare");
  assert.equal(aliceOver.decision.allowed, false);
  assert.equal(aliceOver.headers["Retry-After"] !== undefined, true);

  // Bob starts at zero despite Alice being limited.
  const bob = await enforceSession(req, "user_bob", "compare");
  assert.equal(bob.decision.allowed, true);
  assert.equal(bob.decision.remaining, 2);
});

test("429 response carries X-RateLimit-* and Retry-After", async () => {
  await _resetForTest();
  const req = fakeReq();
  let last;
  for (let i = 0; i < 4; i++) {
    last = await enforceSession(req, "user_charlie", "compare");
  }
  assert.equal(last!.decision.allowed, false);
  const res = tooManyRequestsResponse(last!);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("X-RateLimit-Limit"), "3");
  assert.equal(res.headers.get("X-RateLimit-Remaining"), "0");
  assert.ok(res.headers.get("X-RateLimit-Reset"));
  assert.ok(res.headers.get("Retry-After"));
  assert.equal(res.headers.get("X-RateLimit-Policy"), "3;w=60");
  const body = (await res.json()) as { error: { type: string; bucket: string } };
  assert.equal(body.error.type, "rate_limited");
  assert.equal(body.error.bucket, "compare");
});

test("buckets are independent per user", async () => {
  await _resetForTest();
  const req = fakeReq();
  for (let i = 0; i < 3; i++) await enforceSession(req, "user_dee", "compare");
  const denied = await enforceSession(req, "user_dee", "compare");
  assert.equal(denied.decision.allowed, false);
  // snippets-write bucket is fresh for the same user.
  const write = await enforceSession(req, "user_dee", "snippets-write");
  assert.equal(write.decision.allowed, true);
  assert.equal(write.decision.limit, 2);
});

test("anonymous callers bucket by forwarded IP, not globally", async () => {
  await _resetForTest();
  const a = fakeReq({ "x-forwarded-for": "10.0.0.1" });
  const b = fakeReq({ "x-forwarded-for": "10.0.0.2" });
  for (let i = 0; i < 3; i++) {
    const r = await enforceSession(a, null, "compare");
    assert.equal(r.decision.allowed, true);
  }
  const aOver = await enforceSession(a, null, "compare");
  assert.equal(aOver.decision.allowed, false);
  assert.equal(aOver.kind, "ip");
  // Different IP still has a clean window.
  const bFresh = await enforceSession(b, null, "compare");
  assert.equal(bFresh.decision.allowed, true);
});
