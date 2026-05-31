/**
 * Run with: node --test --experimental-strip-types web/tests/webhooks.test.ts
 *
 * Black-box test for the webhook store + dispatcher. Uses a temp
 * directory and an injected fetch stub so it never touches the real
 * filesystem or network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-hooks-"));
process.env.CODECLONE_WEBHOOKS_DIR = tmp;

const WS = "ws_test_aaaaaa";
const WS_OTHER = "ws_test_bbbbbb";

const {
  createWebhook,
  listWebhooks,
  listWebhooksForWorkspace,
  loadWebhook,
  loadWebhookForWorkspace,
  deleteWebhook,
  setDisabled,
  dispatchEvent,
  listDeliveries,
  listDeliveriesForWorkspace,
  signPayload,
  validateUrl,
  redeliverDelivery,
} = await import("../lib/webhooks.ts");

test("webhooks: validateUrl rejects non-http and empty", () => {
  assert.equal(validateUrl("").ok, false);
  assert.equal(validateUrl("ftp://x").ok, false);
  assert.equal(validateUrl("not a url").ok, false);
  const ok = validateUrl("https://example.com/hook");
  assert.equal(ok.ok, true);
});

test("webhooks: create requires a workspaceId", async () => {
  await assert.rejects(
    () => createWebhook({ label: "no ws", url: "https://example.com/hook" }),
    /workspaceId is required/,
  );
  await assert.rejects(
    () => createWebhook({ label: "bad ws", url: "https://example.com/hook", workspaceId: "not-a-ws" }),
    /workspaceId is required/,
  );
});

test("webhooks: create returns secret once and persists only hash", async () => {
  const { record, secret } = await createWebhook({
    label: "test hook",
    url: "https://example.com/hook",
    workspaceId: WS,
  });
  assert.equal(record.label, "test hook");
  assert.equal(record.workspaceId, WS);
  assert.ok(secret.startsWith("whsec_"));
  assert.equal(record.secretPrefix, secret.slice(0, 10));

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(tmp, `${record.id}.json`), "utf-8"),
  );
  assert.equal(onDisk.secretHash.length, 64);
  assert.equal(onDisk.workspaceId, WS);
  assert.ok(!JSON.stringify(onDisk).includes(secret));
});

test("webhooks: list + delete + pause are workspace-scoped", async () => {
  const before = await listWebhooksForWorkspace(WS);
  const { record } = await createWebhook({
    label: "doomed",
    url: "https://example.com/d",
    workspaceId: WS,
  });
  const after = await listWebhooksForWorkspace(WS);
  assert.equal(after.length, before.length + 1);

  await setDisabled(record.id, true, WS);
  const r = await loadWebhookForWorkspace(record.id, WS);
  assert.equal(r!.disabled, true);

  // Cross-tenant: another workspace cannot toggle or load this hook.
  const denied = await setDisabled(record.id, false, WS_OTHER);
  assert.equal(denied, false);
  const stillDisabled = await loadWebhook(record.id);
  assert.equal(stillDisabled!.disabled, true);
  assert.equal(await loadWebhookForWorkspace(record.id, WS_OTHER), null);

  const cantDelete = await deleteWebhook(record.id, WS_OTHER);
  assert.equal(cantDelete, false);
  // File is still there.
  assert.ok(fs.existsSync(path.join(tmp, `${record.id}.json`)));

  const ok = await deleteWebhook(record.id, WS);
  assert.equal(ok, true);
  const post = await listWebhooksForWorkspace(WS);
  assert.equal(post.length, before.length);
});

test("webhooks: dispatchEvent posts to enabled hooks and logs success", async () => {
  const { record } = await createWebhook({
    label: "live",
    url: "https://example.com/live",
    events: ["compare.completed"],
    workspaceId: WS,
  });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const results = await dispatchEvent({
    event: "compare.completed",
    payload: { key_id: "abc", language: "python" },
    workspaceId: WS,
    fetchImpl: fakeFetch,
  });
  const mine = results.filter((r) => r.webhookId === record.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].ok, true);
  assert.equal(mine[0].status, 200);
  const myCalls = calls.filter((c) => c.url === "https://example.com/live");
  assert.equal(myCalls.length, 1);

  const headers = myCalls[0].init.headers as Record<string, string>;
  assert.equal(headers["X-CodeClone-Event"], "compare.completed");
  assert.ok(headers["X-CodeClone-Signature"].startsWith("t="));
  assert.ok(headers["X-CodeClone-Delivery"].length > 0);

  const body = JSON.parse(myCalls[0].init.body as string) as {
    event: string;
    data: { key_id: string };
  };
  assert.equal(body.event, "compare.completed");
  assert.equal(body.data.key_id, "abc");

  const log = await listDeliveriesForWorkspace(record.id, WS);
  assert.equal(log.length, 1);
  assert.equal(log[0].ok, true);

  const reloaded = await loadWebhook(record.id);
  assert.equal(reloaded!.successCount, 1);
  assert.equal(reloaded!.failureCount, 0);
});

test("webhooks: dispatchEvent does NOT fan out across tenants", async () => {
  // Hook for tenant A, dispatch as tenant B: must not be called.
  const { record } = await createWebhook({
    label: "tenantA only",
    url: "https://example.com/tenantA",
    events: ["compare.completed"],
    workspaceId: WS,
  });
  let called = 0;
  const fakeFetch = (async (url: string) => {
    if (url === "https://example.com/tenantA") called += 1;
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const results = await dispatchEvent({
    event: "compare.completed",
    payload: { key_id: "x" },
    workspaceId: WS_OTHER,
    fetchImpl: fakeFetch,
  });
  for (const r of results) {
    assert.notEqual(r.webhookId, record.id);
  }
  assert.equal(called, 0);

  // Empty/missing workspaceId dispatches to nobody.
  const noneResults = await dispatchEvent({
    event: "compare.completed",
    payload: {},
    workspaceId: null,
    fetchImpl: fakeFetch,
  });
  assert.equal(noneResults.length, 0);
});

test("webhooks: dispatchEvent retries on 500 then records failure", async () => {
  const { record } = await createWebhook({
    label: "flaky",
    url: "https://example.com/flaky",
    workspaceId: WS,
  });
  let attempts = 0;
  const fakeFetch = (async (url: string) => {
    if (url === "https://example.com/flaky") attempts += 1;
    return new Response("nope", { status: 500 });
  }) as unknown as typeof fetch;

  const results = await dispatchEvent({
    event: "compare.completed",
    payload: { key_id: "x" },
    workspaceId: WS,
    fetchImpl: fakeFetch,
  });
  const mine = results.filter((r) => r.webhookId === record.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].ok, false);
  assert.equal(mine[0].attempts, 3);
  assert.equal(attempts, 3);

  const reloaded = await loadWebhook(record.id);
  assert.equal(reloaded!.failureCount, 1);
  assert.ok(reloaded!.lastError?.includes("500"));
});

test("webhooks: disabled hooks are skipped", async () => {
  const { record } = await createWebhook({
    label: "paused",
    url: "https://example.com/paused",
    workspaceId: WS,
  });
  await setDisabled(record.id, true, WS);
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const results = await dispatchEvent({
    event: "compare.completed",
    payload: {},
    workspaceId: WS,
    fetchImpl: fakeFetch,
  });
  for (const r of results) {
    assert.notEqual(r.webhookId, record.id);
  }
  void called;
});

test("webhooks: signPayload is deterministic HMAC-SHA256", () => {
  const sig1 = signPayload("secret", 1000, "body");
  const sig2 = signPayload("secret", 1000, "body");
  assert.equal(sig1, sig2);
  assert.ok(sig1.startsWith("t=1000,v1="));
  const sig3 = signPayload("secret", 1001, "body");
  assert.notEqual(sig1, sig3);
});

test("webhooks: redeliverDelivery replays the original payload and logs a new delivery", async () => {
  const { record } = await createWebhook({
    label: "replay-target",
    url: "https://example.com/replay",
    events: ["compare.completed"],
    workspaceId: WS,
  });

  const failFetch = (async () => new Response("oops", { status: 503 })) as unknown as typeof fetch;
  const first = await dispatchEvent({
    event: "compare.completed",
    payload: { hello: "world", n: 1 },
    workspaceId: WS,
    fetchImpl: failFetch,
  });
  const target = first.find((d) => d.webhookId === record.id);
  assert.ok(target, "original delivery for our webhook exists");
  assert.equal(target!.ok, false);

  let sentBody = "";
  let sentUrl = "";
  let sentEventHeader = "";
  const okFetch = (async (url: string, init: RequestInit) => {
    sentUrl = url;
    sentBody = (init.body as string) ?? "";
    const headers = (init.headers ?? {}) as Record<string, string>;
    sentEventHeader = headers["X-CodeClone-Event"] ?? "";
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  // Cross-tenant replay is refused.
  const blocked = await redeliverDelivery(record.id, target!.id, WS_OTHER, okFetch);
  assert.equal(blocked, null);

  const replay = await redeliverDelivery(record.id, target!.id, WS, okFetch);
  assert.ok(replay, "redelivery returned a record");
  assert.equal(replay!.ok, true);
  assert.equal(replay!.status, 200);
  assert.equal(replay!.redeliveredFrom, target!.id);
  assert.equal(replay!.webhookId, record.id);
  assert.equal(replay!.event, "compare.completed");
  assert.equal(sentUrl, "https://example.com/replay");
  assert.equal(sentEventHeader, "compare.completed");
  assert.equal(sentBody, target!.requestBodyPreview);

  const log = await listDeliveriesForWorkspace(record.id, WS);
  assert.ok(log.some((d) => d.id === replay!.id && d.redeliveredFrom === target!.id));

  const after = await loadWebhook(record.id);
  assert.ok(after);
  assert.ok((after!.successCount ?? 0) >= 1);
});

test("webhooks: redeliverDelivery returns null for unknown ids", async () => {
  const none1 = await redeliverDelivery("nope1234", "missingid1", WS);
  assert.equal(none1, null);
  const { record } = await createWebhook({
    label: "hook for 404",
    url: "https://example.com/h",
    workspaceId: WS,
  });
  const none2 = await redeliverDelivery(record.id, "deadbeef99", WS);
  assert.equal(none2, null);
});

test("webhooks: legacy records without workspaceId are hidden by default", async () => {
  // Simulate a pre-migration record on disk.
  const id = "legacy0001";
  const legacy = {
    v: 1,
    id,
    label: "legacy",
    url: "https://example.com/legacy",
    events: ["compare.completed"],
    secretHash: "0".repeat(64),
    secretPrefix: "whsec_xxxx",
    createdAt: Date.now(),
    successCount: 0,
    failureCount: 0,
  };
  fs.writeFileSync(path.join(tmp, `${id}.json`), JSON.stringify(legacy), "utf-8");

  const lA = await listWebhooksForWorkspace(WS);
  assert.ok(!lA.some((w) => w.id === id), "legacy record must not appear in any workspace listing");
  const lB = await listWebhooksForWorkspace(WS_OTHER);
  assert.ok(!lB.some((w) => w.id === id));
  // Cross-tenant load also denied.
  assert.equal(await loadWebhookForWorkspace(id, WS), null);

  // But the raw record exists when admin tooling asks via listWebhooks().
  const everything = await listWebhooks();
  assert.ok(everything.some((w) => w.id === id));
});
