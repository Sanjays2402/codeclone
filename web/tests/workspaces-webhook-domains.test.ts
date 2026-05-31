/**
 * Workspace webhook destination domain allowlist.
 *
 * Proves the policy is enforced end-to-end:
 *   1. sanitizeWebhookDomainList accepts hosts + wildcards, rejects junk.
 *   2. matchesDomainAllowlist matches exact + wildcard, rejects siblings.
 *   3. createWebhook fails when the URL host is not in the allowlist
 *      (cross-tenant + same-tenant), and succeeds when it matches.
 *   4. dispatchEvent blocks delivery for a webhook whose URL has fallen
 *      out of the (now-tightened) workspace allowlist; the delivery is
 *      logged with the blocked reason and never reaches the network.
 *
 * Run: node --test --experimental-strip-types web/tests/workspaces-webhook-domains.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-whdom-"));
process.env.CODECLONE_WEBHOOKS_DIR = path.join(tmp, "webhooks");
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
// Production posture: SSRF rules on. Test only uses public-style hosts.
delete process.env.CODECLONE_WEBHOOKS_ALLOW_PRIVATE;
fs.mkdirSync(process.env.CODECLONE_WEBHOOKS_DIR, { recursive: true });
fs.mkdirSync(process.env.CODECLONE_WORKSPACES_DIR, { recursive: true });

const {
  sanitizeWebhookDomainList,
  matchesDomainAllowlist,
  createWebhook,
  dispatchEvent,
  listDeliveries,
} = await import("../lib/webhooks.ts");

const {
  createWorkspace,
  setWebhookDomainAllowlist,
  getWorkspace,
} = await import("../lib/workspaces.ts");

test("sanitizeWebhookDomainList accepts hosts and wildcards, rejects junk", () => {
  const { ok, rejected } = sanitizeWebhookDomainList([
    "hooks.partner.com",
    "*.partner.com",
    "  HOOKS.PARTNER.COM  ", // duplicate after normalize
    "PARTNER.COM",
    "not a host",
    "http://x.com",
    "1.2.3.4",
    "",
    null as unknown as string,
  ]);
  assert.deepEqual(ok, ["hooks.partner.com", "*.partner.com", "partner.com"]);
  assert.ok(rejected.includes("not a host"));
  assert.ok(rejected.includes("http://x.com"));
  assert.ok(rejected.includes("1.2.3.4"));
});

test("matchesDomainAllowlist: exact + wildcard semantics", () => {
  const list = ["hooks.partner.com", "*.acme.io"];
  assert.equal(matchesDomainAllowlist("hooks.partner.com", list), true);
  assert.equal(matchesDomainAllowlist("partner.com", list), false);
  assert.equal(matchesDomainAllowlist("api.acme.io", list), true);
  assert.equal(matchesDomainAllowlist("deep.api.acme.io", list), true);
  assert.equal(matchesDomainAllowlist("acme.io", list), false); // wildcard does not match apex
  assert.equal(matchesDomainAllowlist("evil.com", list), false);
  // empty / missing list = no restriction
  assert.equal(matchesDomainAllowlist("evil.com", []), true);
  assert.equal(matchesDomainAllowlist("evil.com", null), true);
});

test("createWebhook rejects URL outside workspace domain allowlist", async () => {
  const ws = await createWorkspace({
    name: "Acme Inc",
    ownerId: "user_acme_owner",
    ownerEmail: "owner@acme.io",
  });
  await setWebhookDomainAllowlist(ws, ["*.acme.io"]);
  const fresh = await getWorkspace(ws.id);
  assert.ok(fresh);
  assert.deepEqual(fresh!.webhookDomainAllowlist, ["*.acme.io"]);

  await assert.rejects(
    () =>
      createWebhook({
        label: "leak",
        url: "https://attacker.example.com/hook",
        workspaceId: ws.id,
        domainAllowlist: fresh!.webhookDomainAllowlist,
      }),
    /not in this workspace's webhook domain allowlist/,
  );

  // In-list URL is accepted.
  const { record } = await createWebhook({
    label: "ok",
    url: "https://hooks.acme.io/intake",
    workspaceId: ws.id,
    domainAllowlist: fresh!.webhookDomainAllowlist,
  });
  assert.equal(record.workspaceId, ws.id);
});

test("dispatchEvent blocks delivery when workspace tightens the allowlist later", async () => {
  const ws = await createWorkspace({
    name: "Beta Corp",
    ownerId: "user_beta_owner",
    ownerEmail: "owner@beta.test",
  });
  // No allowlist at create time, so legacy webhook is allowed in.
  const { record } = await createWebhook({
    label: "legacy",
    url: "https://hooks.thirdparty.example/intake",
    workspaceId: ws.id,
  });

  // Now the owner locks down destinations to a different vendor.
  await setWebhookDomainAllowlist(ws, ["*.vendor.example"]);

  // Track whether fetch is called. It MUST NOT be.
  let fetchCalls = 0;
  const fetchStub: typeof fetch = async () => {
    fetchCalls += 1;
    return new Response("", { status: 200 });
  };

  const deliveries = await dispatchEvent({
    event: "compare.completed",
    payload: { id: "x" },
    workspaceId: ws.id,
    fetchImpl: fetchStub,
  });

  assert.equal(fetchCalls, 0, "fetch must not be called for blocked host");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].ok, false);
  assert.match(
    deliveries[0].error ?? "",
    /not in workspace webhook domain allowlist/,
  );

  // Delivery is logged so an operator can see the block.
  const logged = await listDeliveries(record.id);
  assert.ok(logged.some((d) => /allowlist/.test(d.error ?? "")));
});
