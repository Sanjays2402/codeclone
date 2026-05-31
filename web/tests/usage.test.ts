/**
 * Run with: node --test --experimental-strip-types web/tests/usage.test.ts
 *
 * Black-box test for the usage tracker. Uses a temp directory so it
 * never touches real data.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-usage-"));
process.env.CODECLONE_KEYS_DIR = tmp;
process.env.CODECLONE_FREE_TIER_MONTHLY = "100";

const { logUsage, summarize, quotaCheck, USAGE_DIR } = await import(
  "../lib/usage.ts"
);

test("usage: logs append and aggregate by day and key", async () => {
  const now = Date.UTC(2026, 4, 15, 12, 0, 0); // May 15 2026
  const yesterday = now - 86_400_000;

  await logUsage({ ts: yesterday, keyId: "k1", endpoint: "/v1/compare" });
  await logUsage({ ts: yesterday, keyId: "k1", endpoint: "/v1/compare" });
  await logUsage({ ts: now, keyId: "k2", endpoint: "/v1/compare" });
  await logUsage({ ts: now, keyId: "k1", endpoint: "/v1/compare" });

  // ensure files were written under USAGE_DIR
  const files = fs.readdirSync(USAGE_DIR);
  assert.ok(files.length >= 1);

  const s = await summarize(30, now);
  assert.equal(s.totalCalls, 4);
  assert.equal(s.byKey.find((k) => k.keyId === "k1")?.count, 3);
  assert.equal(s.byKey.find((k) => k.keyId === "k2")?.count, 1);
  // byKey sorted desc
  assert.equal(s.byKey[0].keyId, "k1");
  // window covers expected number of days
  assert.equal(s.byDay.length, 30);
  // last entry is today
  assert.equal(s.byDay[s.byDay.length - 1].count, 2);
  assert.equal(s.byDay[s.byDay.length - 2].count, 2);
});

test("usage: month-to-date and quota math", async () => {
  const now = Date.UTC(2026, 4, 15, 12, 0, 0);
  const s = await summarize(30, now);
  assert.equal(s.freeTierMonthly, 100);
  assert.equal(s.monthToDate, 4);
  assert.equal(s.quotaRemaining, 96);
  assert.ok(s.quotaPercent > 3 && s.quotaPercent < 5);

  const q = await quotaCheck(now);
  assert.equal(q.allowed, true);
  assert.equal(q.limit, 100);
  assert.equal(q.remaining, 96);
});

test("usage: events outside window are excluded", async () => {
  const now = Date.UTC(2026, 4, 15, 12, 0, 0);
  // far past, should be excluded from 7d window
  const longAgo = now - 86_400_000 * 60;
  await logUsage({ ts: longAgo, keyId: "kold", endpoint: "/v1/compare" });
  const s = await summarize(7, now);
  assert.equal(s.byKey.find((k) => k.keyId === "kold"), undefined);
});

test("usage: malformed lines are skipped", async () => {
  const now = Date.UTC(2026, 4, 15, 12, 0, 0);
  const file = path.join(USAGE_DIR, "2026-05-15.jsonl");
  fs.appendFileSync(file, "not json\n{}\n");
  const s = await summarize(7, now);
  // total unchanged (still 3 valid events from today logged earlier)
  assert.equal(s.byDay[s.byDay.length - 1].count, 2);
});
