/**
 * Run with: node --test --experimental-strip-types web/tests/audit-webhook-forward.test.ts
 *
 * Pins the audit.recorded webhook fan-out:
 *
 *   1. A webhook subscribed to `audit.recorded` in workspace A receives
 *      every audit entry written for workspace A, with the documented
 *      payload shape and HMAC headers.
 *   2. A webhook subscribed to `audit.recorded` in workspace B receives
 *      NOTHING when an entry is recorded for workspace A (tenant
 *      isolation, the procurement-critical property).
 *   3. A webhook in workspace A NOT subscribed to `audit.recorded` is
 *      not woken up by audit traffic.
 *
 * Uses temp dirs and a fetch stub so nothing leaks to the network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHooks = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-audit-fwd-hooks-"));
const tmpAudit = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-audit-fwd-log-"));
process.env.CODECLONE_WEBHOOKS_DIR = tmpHooks;
process.env.CODECLONE_AUDIT_DIR = tmpAudit;

const WS_A = "ws_audit_aaaaaa";
const WS_B = "ws_audit_bbbbbb";

const { createWebhook } = await import("../lib/webhooks.ts");
const webhooksMod = await import("../lib/webhooks.ts");
const { recordAudit } = await import("../lib/audit.ts");

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}
const captured: Captured[] = [];
const stubFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input as URL).toString();
  const headers: Record<string, string> = {};
  const raw = (init?.headers ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = v;
  captured.push({ url, headers, body: String(init?.body ?? "") });
  return new Response("ok", { status: 200 });
};
// Monkey-patch global fetch because recordAudit's fire-and-forget
// forwarder calls dispatchEvent() without a fetch override.
const realFetch = globalThis.fetch;
globalThis.fetch = stubFetch as typeof fetch;

test.after(() => {
  globalThis.fetch = realFetch;
});

async function flushForward(): Promise<void> {
  // Audit forwarding is fire-and-forget via the internal writeChain.
  // Force a serialization point by writing one more entry into a
  // throwaway workspace and waiting; then yield the event loop a few
  // times so the dispatched fetch resolves.
  await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

test("audit forward: only the subscribed workspace's webhook fires", async () => {
  // Webhook in A, subscribed to audit.recorded
  const a = await createWebhook({
    label: "ws-a siem",
    url: "https://siem.example.com/a",
    events: ["audit.recorded"],
    workspaceId: WS_A,
  });
  // Webhook in B, also subscribed - must NOT receive A's entries
  const b = await createWebhook({
    label: "ws-b siem",
    url: "https://siem.example.com/b",
    events: ["audit.recorded"],
    workspaceId: WS_B,
  });
  // Webhook in A, NOT subscribed to audit.recorded - must NOT fire
  const aQuiet = await createWebhook({
    label: "ws-a compare only",
    url: "https://relay.example.com/a-compare",
    events: ["compare.completed"],
    workspaceId: WS_A,
  });
  assert.ok(a.record && b.record && aQuiet.record);

  captured.length = 0;
  await recordAudit(undefined, {
    action: "snippet.create",
    actorId: "u_test_actor",
    actorEmail: "actor@example.com",
    workspaceId: WS_A,
    target: { type: "snippet", id: "s_abc", label: "test snippet" },
    status: "ok",
  });
  await flushForward();

  const aHits = captured.filter((c) => c.url === "https://siem.example.com/a");
  const bHits = captured.filter((c) => c.url === "https://siem.example.com/b");
  const quietHits = captured.filter((c) => c.url === "https://relay.example.com/a-compare");

  assert.equal(aHits.length, 1, "ws-A webhook should receive exactly one audit event");
  assert.equal(bHits.length, 0, "ws-B webhook must not receive ws-A audit events (tenant isolation)");
  assert.equal(quietHits.length, 0, "non-subscribed webhook must stay silent");

  // Validate payload shape and required signing headers.
  const hit = aHits[0]!;
  assert.equal(hit.headers["x-codeclone-event"], "audit.recorded");
  assert.ok(hit.headers["x-codeclone-signature"], "missing HMAC signature header");
  assert.ok(hit.headers["x-codeclone-hash"], "missing secret hash header");
  const parsed = JSON.parse(hit.body) as {
    event: string;
    data: { action: string; workspaceId: string; actorId: string; target: { id: string } };
  };
  assert.equal(parsed.event, "audit.recorded");
  assert.equal(parsed.data.action, "snippet.create");
  assert.equal(parsed.data.workspaceId, WS_A);
  assert.equal(parsed.data.actorId, "u_test_actor");
  assert.equal(parsed.data.target.id, "s_abc");
});

test("audit forward: entries without a workspaceId are not forwarded", async () => {
  captured.length = 0;
  await recordAudit(undefined, {
    action: "auth.signin",
    workspaceId: null,
    actorId: "u_anon",
    actorEmail: "anon@example.com",
    target: { type: "user", id: "u_anon" },
    status: "ok",
  });
  await flushForward();
  assert.equal(
    captured.length,
    0,
    "audit entries with no workspaceId must never fan out to any webhook",
  );
});

test("audit.recorded is in the public event catalogue", () => {
  assert.ok(
    (webhooksMod.SUPPORTED_EVENTS as readonly string[]).includes("audit.recorded"),
    "audit.recorded must be a first-class subscribable event",
  );
});
