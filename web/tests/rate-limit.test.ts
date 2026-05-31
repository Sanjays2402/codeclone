/**
 * Run with: node --test --experimental-strip-types web/tests/rate-limit.test.ts
 *
 * Verifies the per-API-key sliding-window rate limiter:
 *   - allows up to the configured rpm in a single window
 *   - returns a 429 with X-RateLimit-* + Retry-After once exceeded
 *   - rolls over to a fresh window after 60s
 *   - falls back to the default rpm when the key has no override
 *   - returns headers even on successful calls so clients can backoff
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-rl-"));
process.env.CODECLONE_RATELIMIT_DIR = tmp;

const {
  check,
  enforce,
  effectiveRpm,
  rateLimitHeaders,
  normalizeRpm,
  DEFAULT_RPM,
  _resetForTest,
} = await import("../lib/rate-limit.ts");

test("rate-limit: normalizeRpm coerces and bounds inputs", () => {
  assert.equal(normalizeRpm(undefined), undefined);
  assert.equal(normalizeRpm(""), undefined);
  assert.equal(normalizeRpm("abc"), undefined);
  assert.equal(normalizeRpm(0), undefined);
  assert.equal(normalizeRpm(-5), undefined);
  assert.equal(normalizeRpm(100001), undefined);
  assert.equal(normalizeRpm("10"), 10);
  assert.equal(normalizeRpm(10.7), 10);
  assert.equal(normalizeRpm(100000), 100000);
});

test("rate-limit: effectiveRpm prefers explicit limit, falls back to default", () => {
  assert.equal(effectiveRpm(null), DEFAULT_RPM);
  assert.equal(effectiveRpm(undefined), DEFAULT_RPM);
  assert.equal(effectiveRpm({}), DEFAULT_RPM);
  assert.equal(effectiveRpm({ rateLimit: { rpm: 25 } }), 25);
  assert.equal(effectiveRpm({ rateLimit: { rpm: 0 } }), DEFAULT_RPM);
});

test("rate-limit: sliding-window check allows up to rpm then denies", async () => {
  await _resetForTest("k-burst");
  const now = Date.now();
  const rpm = 5;
  for (let i = 0; i < rpm; i++) {
    const d = await check("k-burst", rpm, now + i);
    assert.equal(d.allowed, true, `request ${i + 1} should be allowed`);
    assert.equal(d.limit, rpm);
    assert.equal(d.remaining, rpm - (i + 1));
  }
  const overflow = await check("k-burst", rpm, now + rpm);
  assert.equal(overflow.allowed, false);
  assert.equal(overflow.remaining, 0);
  assert.ok(overflow.retryAfter >= 1 && overflow.retryAfter <= 60);
});

test("rate-limit: counter resets after the 60s window", async () => {
  await _resetForTest("k-roll");
  const start = Date.now();
  const rpm = 2;
  const a = await check("k-roll", rpm, start);
  assert.equal(a.allowed, true);
  const b = await check("k-roll", rpm, start + 100);
  assert.equal(b.allowed, true);
  const c = await check("k-roll", rpm, start + 500);
  assert.equal(c.allowed, false, "third request in window must be denied");
  // jump just past the window
  const d = await check("k-roll", rpm, start + 60_001);
  assert.equal(d.allowed, true, "first request in next window must be allowed");
  assert.equal(d.remaining, rpm - 1);
});

test("rate-limit: enforce returns 429 with standard headers", async () => {
  await _resetForTest("k-enf");
  const key = { id: "k-enf", rateLimit: { rpm: 2 } } as const;
  const r1 = await enforce(key);
  assert.equal(r1.response, null);
  assert.equal(r1.headers["X-RateLimit-Limit"], "2");
  assert.equal(r1.headers["X-RateLimit-Remaining"], "1");
  const r2 = await enforce(key);
  assert.equal(r2.response, null);
  assert.equal(r2.headers["X-RateLimit-Remaining"], "0");
  const r3 = await enforce(key);
  assert.ok(r3.response, "third call should be denied");
  assert.equal(r3.response!.status, 429);
  assert.ok(r3.response!.headers.get("Retry-After"));
  assert.equal(r3.response!.headers.get("X-RateLimit-Limit"), "2");
  assert.equal(r3.response!.headers.get("X-RateLimit-Remaining"), "0");
  const body = (await r3.response!.json()) as { error: { type: string; limit: number } };
  assert.equal(body.error.type, "rate_limited");
  assert.equal(body.error.limit, 2);
});

test("rate-limit: headers always sane on success", () => {
  const decision = {
    allowed: true,
    limit: 30,
    remaining: 29,
    resetAt: 1_000_000_000_000,
    retryAfter: 60,
  };
  const h = rateLimitHeaders(decision);
  assert.equal(h["X-RateLimit-Limit"], "30");
  assert.equal(h["X-RateLimit-Remaining"], "29");
  assert.equal(h["X-RateLimit-Policy"], "30;w=60");
  assert.equal(h["X-RateLimit-Reset"], "1000000000");
  assert.equal(h["Retry-After"], undefined);
});
