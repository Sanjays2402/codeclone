/**
 * Run with: node --test --experimental-strip-types web/tests/plans.test.ts
 *
 * Verifies:
 *   - default plan is free with the 1000 cap
 *   - workspaceQuotaCheck only counts usage events for the matching workspace
 *     so two tenants cannot starve each other (the deal-blocker invariant)
 *   - setWorkspacePlan rejects invalid ids and lifts the cap on enterprise
 *   - planHeaders emits the documented x-codeclone-plan-* triplet
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-plans-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CODECLONE_KEYS_DIR = path.join(tmp, "api-keys");

const usageDir = path.join(tmp, "api-keys", "usage");
await fs.mkdir(usageDir, { recursive: true });

const ws = await import("../lib/workspaces.ts");
const plans = await import("../lib/plans.ts");

async function makeWs(name: string, userId: string) {
  return ws.createWorkspace({
    name,
    ownerId: userId,
    ownerEmail: `${userId}@example.com`,
  });
}

async function writeUsage(workspaceId: string | undefined, count: number, monthDate: string) {
  const lines: string[] = [];
  const ts = Date.parse(`${monthDate}T12:00:00Z`);
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify({
      ts: ts + i,
      keyId: "k_test",
      endpoint: "/v1/compare",
      workspaceId,
    }));
  }
  await fs.appendFile(path.join(usageDir, `${monthDate}.jsonl`), lines.join("\n") + "\n", "utf-8");
}

test("plans: default plan is free with a 1000 monthly cap", () => {
  const p = plans.getPlan({});
  assert.equal(p.id, "free");
  assert.equal(p.monthlyCalls, 1_000);
});

test("plans: cross-workspace isolation. one tenant's burn never counts against another", async () => {
  const a = await makeWs("Alpha", "u_alpha000001");
  const b = await makeWs("Bravo", "u_bravo000001");

  const month = plans.monthPrefix(Date.now());
  const today = `${month}-15`;
  // Alpha runs 1200 calls this month. Bravo runs 5.
  await writeUsage(a.id, 1200, today);
  await writeUsage(b.id, 5, today);

  const aCheck = await plans.workspaceQuotaCheck(a.id, a);
  const bCheck = await plans.workspaceQuotaCheck(b.id, b);

  assert.ok(aCheck && bCheck);
  assert.equal(aCheck.monthToDate, 1200);
  assert.equal(bCheck.monthToDate, 5);
  // Free cap is 1000: Alpha is denied, Bravo still allowed.
  assert.equal(aCheck.allowed, false);
  assert.equal(bCheck.allowed, true);
  assert.equal(bCheck.remaining, 995);
});

test("plans: setWorkspacePlan(enterprise) lifts the cap; invalid ids rejected", async () => {
  const w = await makeWs("Charlie", "u_charlie00001");
  const month = plans.monthPrefix(Date.now());
  await writeUsage(w.id, 10_000, `${month}-10`);

  // Under free, this is denied.
  let chk = await plans.workspaceQuotaCheck(w.id, w);
  assert.ok(chk && !chk.allowed);

  await ws.setWorkspacePlan(w, "enterprise");
  const reloaded = await ws.getWorkspace(w.id);
  assert.equal(reloaded?.plan, "enterprise");

  chk = await plans.workspaceQuotaCheck(w.id, reloaded);
  assert.ok(chk);
  assert.equal(chk.allowed, true);
  assert.equal(chk.limit, null);

  await assert.rejects(() => ws.setWorkspacePlan(w, "bogus" as unknown as "free"));
});

test("plans: planHeaders emits the documented triplet", () => {
  const headers = plans.planHeaders({
    workspaceId: "ws_test",
    plan: plans.PLANS.pro,
    monthToDate: 42,
    limit: 50_000,
    remaining: 49_958,
    allowed: true,
  });
  assert.equal(headers["x-codeclone-plan"], "pro");
  assert.equal(headers["x-codeclone-plan-limit"], "50000");
  assert.equal(headers["x-codeclone-plan-remaining"], "49958");
  assert.equal(headers["x-codeclone-plan-month-to-date"], "42");
});

test("plans: no workspace context returns null so legacy quota stays in charge", async () => {
  const out = await plans.workspaceQuotaCheck(null, null);
  assert.equal(out, null);
});
