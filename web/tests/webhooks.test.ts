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

const {
  createWebhook,
  listWebhooks,
  loadWebhook,
  deleteWebhook,
  setDisabled,
  dispatchEvent,
  listDeliveries,
  signPayload,
  validateUrl,
} = await import("../lib/webhooks.ts");

test("webhooks: validateUrl rejects non-http and empty", () => {
  assert.equal(validateUrl("").ok, false);
  assert.equal(validateUrl("ftp://x").ok, false);
  assert.equal(validateUrl("not a url").ok, false);
  const ok = validateUrl("https://example.com/hook");
  assert.equal(ok.ok, true);
});

test("webhooks: create returns secret once and persists only hash", async () => {
  const { record, secret } = await createWebhook({
    label: "test hook",
    url: "https://example.com/hook",
  });
  assert.equal(record.label, "test hook");
  assert.ok(secret.startsWith("whsec_"));
  assert.equal(record.secretPrefix, secret.slice(0, 10));

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(tmp, `${record.id}.json`), "utf-8"),
  );
  assert.equal(onDisk.secretHash.length, 64);
  assert.ok(!JSON.stringify(onDisk).includes(secret));
});

test("webhooks: list + delete + pause", async () => {
  const before = await listWebhooks();
  const { record } = await createWebhook({
    label: "doomed",
    url: "https://example.com/d",
  });
  const after = await listWebhooks();
  assert.equal(after.length, before.length + 1);

  await setDisabled(record.id, true);
  const r = await loadWebhook(record.id);
  assert.equal(r!.disabled, true);

  const ok = await deleteWebhook(record.id);
  assert.equal(ok, true);
  const post = await listWebhooks();
  assert.equal(post.length, before.length);
});

test("webhooks: dispatchEvent posts to enabled hooks and logs success", async () => {
  const { record } = await createWebhook({
    label: "live",
    url: "https://example.com/live",
    events: ["compare.completed"],
  });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const results = await dispatchEvent({
    event: "compare.completed",
    payload: { key_id: "abc", language: "python" },
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

  const log = await listDeliveries(record.id);
  assert.equal(log.length, 1);
  assert.equal(log[0].ok, true);

  const reloaded = await loadWebhook(record.id);
  assert.equal(reloaded!.successCount, 1);
  assert.equal(reloaded!.failureCount, 0);
});

test("webhooks: dispatchEvent retries on 500 then records failure", async () => {
  const { record } = await createWebhook({
    label: "flaky",
    url: "https://example.com/flaky",
  });
  let attempts = 0;
  const fakeFetch = (async (url: string) => {
    if (url === "https://example.com/flaky") attempts += 1;
    return new Response("nope", { status: 500 });
  }) as unknown as typeof fetch;

  const results = await dispatchEvent({
    event: "compare.completed",
    payload: { key_id: "x" },
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
  });
  await setDisabled(record.id, true);
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  // Other hooks from earlier tests may still be active; just ensure the
  // paused one was not delivered.
  const results = await dispatchEvent({
    event: "compare.completed",
    payload: {},
    fetchImpl: fakeFetch,
  });
  for (const r of results) {
    assert.notEqual(r.webhookId, record.id);
  }
  // Note: `called` may still be true for unrelated hooks created above.
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
