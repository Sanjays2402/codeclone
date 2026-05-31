/**
 * Run with: node --test --experimental-strip-types web/tests/recent-failures.test.ts
 *
 * Tests the aggregator that powers the in-app toaster: it must surface
 * failed deliveries, skip successes, sort newest-first, and honor since/limit.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { collectRecentFailures, clampLimit, clampSince } = await import(
  "../lib/recent-failures.ts"
);

import type { DeliveryRecord, WebhookSummary } from "../lib/webhooks.ts";

function hook(id: string, label: string, url: string): WebhookSummary {
  return {
    id,
    label,
    url,
    events: ["compare.completed"],
    secretPrefix: "whsec_abcd",
    createdAt: 0,
    successCount: 0,
    failureCount: 0,
  };
}

function delivery(over: Partial<DeliveryRecord>): DeliveryRecord {
  return {
    id: over.id ?? "d_" + Math.random().toString(36).slice(2, 8),
    webhookId: over.webhookId ?? "w1",
    event: over.event ?? "compare.completed",
    attemptedAt: over.attemptedAt ?? Date.now(),
    attempts: over.attempts ?? 1,
    status: over.status ?? 200,
    ok: over.ok ?? (typeof over.status === "number" ? over.status >= 200 && over.status < 300 : true),
    durationMs: over.durationMs ?? 10,
    error: over.error,
    requestBodyPreview: over.requestBodyPreview ?? "{}",
    responseBodyPreview: over.responseBodyPreview,
  };
}

test("clampLimit: defaults to 25 and stays inside [1, 100]", () => {
  assert.equal(clampLimit(undefined), 25);
  assert.equal(clampLimit(null), 25);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(-5), 1);
  assert.equal(clampLimit(50), 50);
  assert.equal(clampLimit(999999), 100);
  assert.equal(clampLimit(Number.NaN), 25);
});

test("clampSince: rejects negatives and non-finite, defaults to 0", () => {
  assert.equal(clampSince(undefined), 0);
  assert.equal(clampSince(-1), 0);
  assert.equal(clampSince(Number.NaN), 0);
  assert.equal(clampSince(1700000000000), 1700000000000);
});

test("collectRecentFailures: surfaces failures, skips successes", async () => {
  const hooks = [hook("ok1", "ok hook", "https://example.com/ok"), hook("bad1", "bad hook", "https://example.com/bad")];
  const deliveriesByHook: Record<string, DeliveryRecord[]> = {
    ok1: [delivery({ webhookId: "ok1", status: 200, attemptedAt: 1000 })],
    bad1: [
      delivery({ webhookId: "bad1", status: 500, ok: false, attemptedAt: 2000, error: "Internal Server Error" }),
      delivery({ webhookId: "bad1", status: 0, ok: false, attemptedAt: 1500, error: "ECONNRESET" }),
      delivery({ webhookId: "bad1", status: 301, ok: true, attemptedAt: 1200 }), // redirect = success, skip
    ],
  };

  const items = await collectRecentFailures({
    listWebhooksImpl: async () => hooks,
    listDeliveriesImpl: async (id) => deliveriesByHook[id] ?? [],
  });

  assert.equal(items.length, 2);
  // Newest first
  assert.equal(items[0].attemptedAt, 2000);
  assert.equal(items[0].status, 500);
  assert.equal(items[0].webhookId, "bad1");
  assert.equal(items[1].status, 0);
  // Successes must never appear
  assert.equal(items.find(i => i.webhookId === "ok1"), undefined);
});

test("collectRecentFailures: respects since filter", async () => {
  const hooks = [hook("bad1", "bad hook", "https://example.com/bad")];
  const deliveriesByHook: Record<string, DeliveryRecord[]> = {
    bad1: [
      delivery({ webhookId: "bad1", status: 500, ok: false, attemptedAt: 1000 }),
      delivery({ webhookId: "bad1", status: 500, ok: false, attemptedAt: 2000 }),
    ],
  };
  const items = await collectRecentFailures({
    since: 1500,
    listWebhooksImpl: async () => hooks,
    listDeliveriesImpl: async (id) => deliveriesByHook[id] ?? [],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].attemptedAt, 2000);
});

test("collectRecentFailures: honors limit", async () => {
  const hooks = [hook("bad1", "bad hook", "https://example.com/bad")];
  const deliveriesByHook: Record<string, DeliveryRecord[]> = {
    bad1: Array.from({ length: 30 }, (_, i) =>
      delivery({ webhookId: "bad1", status: 500, ok: false, attemptedAt: 1000 + i }),
    ),
  };
  const items = await collectRecentFailures({
    limit: 5,
    listWebhooksImpl: async () => hooks,
    listDeliveriesImpl: async (id) => deliveriesByHook[id] ?? [],
  });
  assert.equal(items.length, 5);
  // Newest 5 -> attemptedAt 1025..1029
  assert.equal(items[0].attemptedAt, 1029);
  assert.equal(items[4].attemptedAt, 1025);
});
