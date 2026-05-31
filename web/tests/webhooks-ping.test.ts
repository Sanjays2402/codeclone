/**
 * Webhook test-ping (POST /api/webhooks/:id/ping).
 *
 * Run: node --test --experimental-strip-types web/tests/webhooks-ping.test.ts
 *
 * Library-level coverage that backs the dashboard "send ping" button:
 *   - pingWebhook delivers a single signed `webhook.ping` event using
 *     the webhook's primary secret hash; the X-CodeClone-Signature
 *     header verifies against the documented HMAC algorithm.
 *   - Success bumps the webhook's successCount; failure bumps
 *     failureCount and records lastError.
 *   - Cross-workspace callers cannot ping a webhook that belongs to
 *     another tenant: pingWebhook returns null with no side effects
 *     (no delivery written, no counter change).
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-hooks-ping-"));
process.env.CODECLONE_WEBHOOKS_DIR = tmp;
// Stubbed fetcher never opens a socket; dispatcher still re-validates
// the URL host, so allow private addresses for the test fixture.
process.env.CODECLONE_WEBHOOKS_ALLOW_PRIVATE = "1";

const WS = "ws_ping_aaaaaa";
const WS_OTHER = "ws_ping_bbbbbb";

const {
  createWebhook,
  pingWebhook,
  loadWebhook,
  listDeliveries,
  signPayload,
} = await import("../lib/webhooks.ts");

function hashSecret(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function makeFetchStub(captured: Captured[], status = 200): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const headers: Record<string, string> = {};
    const raw = init?.headers as Record<string, string> | undefined;
    if (raw) for (const k of Object.keys(raw)) headers[k.toLowerCase()] = raw[k];
    captured.push({
      url,
      headers,
      body: typeof init?.body === "string" ? init!.body as string : "",
    });
    return new Response("", { status });
  }) as unknown as typeof fetch;
}

test("pingWebhook signs and delivers a webhook.ping event", async () => {
  const created = await createWebhook({
    workspaceId: WS,
    label: "ping target",
    url: "http://127.0.0.1:65500/hook",
    events: ["compare.completed"],
  });
  const captured: Captured[] = [];
  const delivery = await pingWebhook(
    created.record.id,
    WS,
    { id: "u_actor", email: "a@example.com" },
    makeFetchStub(captured, 200),
  );
  assert.ok(delivery, "delivery returned");
  assert.equal(delivery!.ok, true);
  assert.equal(delivery!.event, "webhook.ping");
  assert.equal(captured.length, 1);
  const cap = captured[0];
  assert.equal(cap.headers["x-codeclone-event"], "webhook.ping");
  const sig = cap.headers["x-codeclone-signature"];
  assert.ok(sig && sig.startsWith("t="), "signature header present");
  const ts = Number(sig.split(",")[0].slice(2));
  const expectedHash = hashSecret(created.secret);
  const expected = signPayload(expectedHash, ts, cap.body);
  assert.equal(sig, expected, "signature verifies with primary secret hash");
  const parsed = JSON.parse(cap.body) as { event: string; data: { actor: { id: string } } };
  assert.equal(parsed.event, "webhook.ping");
  assert.equal(parsed.data.actor.id, "u_actor");

  const rec = await loadWebhook(created.record.id);
  assert.equal(rec!.successCount, 1, "successCount bumped");
  const deliveries = await listDeliveries(created.record.id);
  assert.equal(deliveries.length, 1, "ping appended to delivery log");
});

test("pingWebhook records failure on non-2xx", async () => {
  const created = await createWebhook({
    workspaceId: WS,
    label: "ping fail target",
    url: "http://127.0.0.1:65501/hook",
    events: ["compare.completed"],
  });
  const captured: Captured[] = [];
  const delivery = await pingWebhook(
    created.record.id,
    WS,
    null,
    makeFetchStub(captured, 500),
  );
  assert.ok(delivery);
  assert.equal(delivery!.ok, false);
  assert.equal(delivery!.status, 500);
  const rec = await loadWebhook(created.record.id);
  assert.equal(rec!.failureCount, 1, "failureCount bumped");
  assert.ok(rec!.lastError, "lastError populated");
});

test("pingWebhook refuses cross-tenant access (no side effects)", async () => {
  const created = await createWebhook({
    workspaceId: WS,
    label: "tenant a hook",
    url: "http://127.0.0.1:65502/hook",
    events: ["compare.completed"],
  });
  const before = await loadWebhook(created.record.id);
  const captured: Captured[] = [];
  const delivery = await pingWebhook(
    created.record.id,
    WS_OTHER,
    { id: "u_attacker", email: "x@evil.example" },
    makeFetchStub(captured, 200),
  );
  assert.equal(delivery, null, "cross-tenant ping returns null");
  assert.equal(captured.length, 0, "no HTTP call made");
  const after = await loadWebhook(created.record.id);
  assert.equal(after!.successCount, before!.successCount, "no counter change");
  assert.equal(after!.failureCount, before!.failureCount, "no counter change");
  const deliveries = await listDeliveries(created.record.id);
  assert.equal(deliveries.length, 0, "no delivery written");
});
