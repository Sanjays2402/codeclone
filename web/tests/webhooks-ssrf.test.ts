/**
 * SSRF defense for outbound webhooks. Verifies that webhook URLs
 * targeting loopback, private, link-local, or cloud-metadata addresses
 * are rejected at both create time and delivery time so a tenant cannot
 * coerce the platform into probing internal services on their behalf.
 *
 * Run: node --test --experimental-strip-types web/tests/webhooks-ssrf.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-hooks-ssrf-"));
process.env.CODECLONE_WEBHOOKS_DIR = tmp;
// Force the production posture for this file.
delete process.env.CODECLONE_WEBHOOKS_ALLOW_PRIVATE;

const {
  isPrivateHost,
  validateUrl,
  createWebhook,
  dispatchEvent,
  listDeliveries,
} = await import("../lib/webhooks.ts");

test("isPrivateHost flags loopback, RFC1918, link-local, metadata, IPv6", () => {
  const blocked = [
    "localhost",
    "service.local",
    "db.internal",
    "host.lan",
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "10.255.255.255",
    "172.16.0.1",
    "172.20.5.5",
    "172.31.255.254",
    "192.168.1.1",
    "169.254.169.254", // AWS / GCP metadata
    "100.64.0.1",      // CGNAT
    "0.0.0.0",
    "224.0.0.1",       // multicast
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
  ];
  for (const h of blocked) {
    assert.equal(isPrivateHost(h), true, `${h} should be blocked`);
  }
  const allowed = [
    "example.com",
    "api.codeclone.dev",
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "172.32.0.1",   // outside 172.16/12
    "172.15.0.1",   // outside 172.16/12
    "192.169.1.1",  // outside 192.168
  ];
  for (const h of allowed) {
    assert.equal(isPrivateHost(h), false, `${h} should be allowed`);
  }
});

test("validateUrl rejects loopback, RFC1918, link-local, internal TLDs", () => {
  for (const u of [
    "http://localhost/hook",
    "http://127.0.0.1:8080/x",
    "http://10.0.0.1/x",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/x",
    "https://service.internal/hook",
    "https://printer.local/hook",
  ]) {
    const r = validateUrl(u);
    assert.equal(r.ok, false, `${u} should be rejected`);
    if (!r.ok) {
      assert.match(r.error, /private|loopback|link-local/i);
    }
  }
});

test("dispatchEvent refuses delivery to a private URL even if the record was forced in", async () => {
  // First, create a legitimate webhook so we have a record, then mutate
  // its URL on disk to simulate a stored record that points internal (eg
  // an admin policy change or DNS shift).
  const { record, secret } = await createWebhook({
    label: "trusted",
    url: "https://example.com/hook",
    events: ["compare.completed"],
    workspaceId: "ws_ssrf_test",
  });
  assert.ok(secret.startsWith("whsec_"));
  const file = path.join(tmp, `${record.id}.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  raw.url = "http://169.254.169.254/latest/meta-data/"; // tampered
  fs.writeFileSync(file, JSON.stringify(raw));

  let called = false;
  await dispatchEvent({
    event: "compare.completed",
    payload: { ok: true },
    workspaceId: "ws_ssrf_test",
    fetchImpl: (async () => {
      called = true;
      return new Response("nope", { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(called, false, "fetch must not be called for a private URL");

  const log = await listDeliveries(record.id);
  assert.ok(log.length >= 1, "block must be logged as a failed delivery");
  const last = log[0];
  assert.equal(last.ok, false);
  assert.match(String(last.error ?? ""), /blocked|private|loopback/i);
});
