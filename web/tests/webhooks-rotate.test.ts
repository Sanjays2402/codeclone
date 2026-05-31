/**
 * Webhook signing-secret rotation.
 *
 * Run: node --test --experimental-strip-types web/tests/webhooks-rotate.test.ts
 *
 * Proves the credential-rotation contract end-to-end against the
 * library layer (no HTTP):
 *   - rotateSecret returns a fresh plaintext exactly once and stores
 *     only its hash as pending.
 *   - The primary secret keeps working during the grace window.
 *   - Deliveries are dual-signed: both X-CodeClone-Signature and
 *     X-CodeClone-Signature-Next are present and verify with the right
 *     secret hashes.
 *   - finalizeRotation promotes pending -> primary and drops the
 *     Signature-Next header on subsequent deliveries.
 *   - cancelRotation drops the pending secret without touching primary.
 *   - Cross-workspace callers cannot rotate or finalize another
 *     tenant's webhook (tenant isolation).
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-hooks-rotate-"));
process.env.CODECLONE_WEBHOOKS_DIR = tmp;
// We need to allow private URLs because our stubbed fetcher never
// actually opens a socket but the dispatcher still re-validates.
process.env.CODECLONE_WEBHOOKS_ALLOW_PRIVATE = "1";

const WS = "ws_rotate_aaaaaa";
const WS_OTHER = "ws_rotate_bbbbbb";

const {
  createWebhook,
  rotateSecret,
  finalizeRotation,
  cancelRotation,
  loadWebhook,
  loadWebhookForWorkspace,
  dispatchEvent,
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

function makeFetchStub(captured: Captured[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
    captured.push({ url, headers, body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
}

test("rotate: returns plaintext once, stores only hash, exposes prefix", async () => {
  const { record } = await createWebhook({
    workspaceId: WS,
    label: "primary",
    url: "https://example.com/hook",
    events: ["compare.completed"],
  });
  const rotated = await rotateSecret(record.id, WS, 60_000);
  assert.ok(rotated, "rotateSecret returned a result");
  assert.match(rotated!.secret, /^whsec_/);
  assert.equal(rotated!.record.pendingSecretPrefix, rotated!.secret.slice(0, 10));
  assert.ok(rotated!.expiresAt > Date.now());

  // On-disk record must store only the HASH, never the plaintext.
  const onDisk = await loadWebhook(record.id);
  assert.ok(onDisk);
  assert.equal(onDisk!.pendingSecretHash, hashSecret(rotated!.secret));
  const raw = fs.readFileSync(path.join(tmp, `${record.id}.json`), "utf-8");
  assert.ok(!raw.includes(rotated!.secret), "plaintext must not be persisted");
});

test("rotate: deliveries are dual-signed during grace window", async () => {
  const ws = "ws_rotate_dual00";
  const { record } = await createWebhook({
    workspaceId: ws,
    label: "dual",
    url: "https://example.com/dual",
    events: ["compare.completed"],
  });
  const onDiskBefore = await loadWebhook(record.id);
  const primaryHash = onDiskBefore!.secretHash;

  const rotated = await rotateSecret(record.id, ws, 60_000);
  assert.ok(rotated);
  const pendingHash = hashSecret(rotated!.secret);

  const captured: Captured[] = [];
  const deliveries = await dispatchEvent({
    event: "compare.completed",
    payload: { ok: true },
    workspaceId: ws,
    fetchImpl: makeFetchStub(captured),
  });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].ok, true);
  assert.equal(captured.length, 1);

  const sig = captured[0].headers["x-codeclone-signature"];
  const sigNext = captured[0].headers["x-codeclone-signature-next"];
  const hashHdr = captured[0].headers["x-codeclone-hash"];
  const hashNextHdr = captured[0].headers["x-codeclone-hash-next"];
  assert.ok(sig, "primary signature header present");
  assert.ok(sigNext, "pending signature header present during rotation");
  assert.equal(hashHdr, primaryHash.slice(0, 16));
  assert.equal(hashNextHdr, pendingHash.slice(0, 16));

  // Each signature must verify against its OWN secret hash.
  const m1 = sig.match(/^t=(\d+),v1=([0-9a-f]+)$/);
  const m2 = sigNext.match(/^t=(\d+),v1=([0-9a-f]+)$/);
  assert.ok(m1 && m2);
  assert.equal(m1![1], m2![1], "both signatures share the same timestamp");
  assert.equal(sig, signPayload(primaryHash, Number(m1![1]), captured[0].body));
  assert.equal(sigNext, signPayload(pendingHash, Number(m2![1]), captured[0].body));
  // And they must not be equal: dual-signing means dual keys.
  assert.notEqual(sig, sigNext);
});

test("rotate: finalize promotes pending and stops dual-signing", async () => {
  const ws = "ws_rotate_fin000";
  const { record } = await createWebhook({
    workspaceId: ws,
    label: "finalize",
    url: "https://example.com/fin",
    events: ["compare.completed"],
  });
  const rotated = await rotateSecret(record.id, ws, 60_000);
  assert.ok(rotated);
  const pendingHash = hashSecret(rotated!.secret);

  const finalized = await finalizeRotation(record.id, ws);
  assert.ok(finalized);
  assert.equal(finalized!.secretPrefix, rotated!.secret.slice(0, 10));
  assert.equal(finalized!.pendingSecretPrefix, undefined);

  const onDisk = await loadWebhook(record.id);
  assert.equal(onDisk!.secretHash, pendingHash);
  assert.equal(onDisk!.pendingSecretHash, undefined);

  const captured: Captured[] = [];
  await dispatchEvent({
    event: "compare.completed",
    payload: { ok: true },
    workspaceId: ws,
    fetchImpl: makeFetchStub(captured),
  });
  assert.equal(captured.length, 1);
  assert.ok(captured[0].headers["x-codeclone-signature"], "primary signature still sent");
  assert.equal(
    captured[0].headers["x-codeclone-signature-next"],
    undefined,
    "no Signature-Next header after finalize",
  );
});

test("rotate: cancel drops pending without touching primary", async () => {
  const { record } = await createWebhook({
    workspaceId: WS,
    label: "cancel",
    url: "https://example.com/can",
    events: ["compare.completed"],
  });
  const before = await loadWebhook(record.id);
  const primaryHash = before!.secretHash;
  const rotated = await rotateSecret(record.id, WS, 60_000);
  assert.ok(rotated);
  const after = await cancelRotation(record.id, WS);
  assert.ok(after);
  assert.equal(after!.pendingSecretPrefix, undefined);
  const onDisk = await loadWebhook(record.id);
  assert.equal(onDisk!.secretHash, primaryHash, "primary secret unchanged");
  assert.equal(onDisk!.pendingSecretHash, undefined);
});

test("rotate: cross-workspace caller cannot rotate or finalize", async () => {
  const { record } = await createWebhook({
    workspaceId: WS,
    label: "iso",
    url: "https://example.com/iso",
    events: ["compare.completed"],
  });
  // Different workspace must not be able to start, finalize, or cancel.
  assert.equal(await rotateSecret(record.id, WS_OTHER, 60_000), null);
  assert.equal(await finalizeRotation(record.id, WS_OTHER), null);
  assert.equal(await cancelRotation(record.id, WS_OTHER), null);
  // And the webhook must not be visible to the other workspace at all.
  assert.equal(await loadWebhookForWorkspace(record.id, WS_OTHER), null);
});

test("rotate: finalize is a no-op when nothing is pending", async () => {
  const { record } = await createWebhook({
    workspaceId: WS,
    label: "nop",
    url: "https://example.com/nop",
    events: ["compare.completed"],
  });
  const r = await finalizeRotation(record.id, WS);
  assert.equal(r, null, "finalize without pending returns null so the route can 409");
});
