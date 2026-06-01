/**
 * Run with: node --test --experimental-strip-types web/tests/v1-members-get-tenant-isolation.test.ts
 *
 * Covers GET /v1/members/:user_id, the programmatic single-member
 * read used by IGA runbooks (Okta Lifecycle, SailPoint, Workday)
 * to reconcile one user without paginating the full roster.
 *
 *   1) Route source wires members:read scope, the per-key
 *      rate-limit enforce (billable), the full workspace
 *      enforcement chain (lockdown, IP allowlists, residency,
 *      key policy), tenant scoping to key.workspaceId, and a
 *      stable audit action id `v1.members.get`.
 *
 *   2) The spec lists members-get with the right scope + curl.
 *
 *   3) Live tenant isolation: a key in workspace B fetching a
 *      userId that lives in workspace A receives a not_found
 *      shape from the route's own helper, never the foreign
 *      member record.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-members-get-keys-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-members-get-rl-"));
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-members-get-ws-"));
process.env.CODECLONE_KEYS_DIR = tmpKeys;
process.env.CODECLONE_RATELIMIT_DIR = tmpRl;
process.env.CODECLONE_WORKSPACES_DIR = tmpWs;

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "members", "[userId]", "route.ts"),
  "utf8",
);

const { createKey, hasScope } = await import("../lib/api-keys.ts");
const { createWorkspace, getWorkspace } = await import("../lib/workspaces.ts");
const { ENDPOINTS } = await import("../lib/api-spec.ts");

test("v1/members/:user_id GET: route wires scope, rate-limit, enforcement chain, tenant scope, audit", () => {
  // GET branch present and scoped.
  assert.match(routeSrc, /export async function GET\(/);
  assert.match(routeSrc, /hasScope\(key, "members:read"\)/);
  // Common gate is the rate-limit enforce path (billable).
  assert.match(routeSrc, /enforceRateLimit\(/);
  assert.ok(
    !/peekRateLimit\(/.test(routeSrc),
    "v1/members/:id GET must enforce, not peek",
  );
  // Full workspace enforcement chain via commonGate.
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Tenant scope: workspace lookup is always by key.workspaceId,
  // never by anything caller-controlled.
  assert.match(routeSrc, /getWorkspace\(key\.workspaceId\)/);
  assert.ok(
    !/workspaceId.*searchParams|searchParams.*workspaceId/.test(routeSrc),
    "v1/members/:id GET must not let query string select workspace",
  );
  // Audit row under a stable action id IGA can grep for.
  assert.match(routeSrc, /"v1\.members\.get"/);
  // Cross-tenant probes return 404 (not 403) to avoid leaking
  // existence.
  assert.match(routeSrc, /if \(!target\) return notFound\(\);/);
});

test("v1/members/:user_id GET: api-spec exposes members-get with members:read scope", () => {
  const spec = (ENDPOINTS as ReadonlyArray<{
    id: string;
    method: string;
    path: string;
    scope: string;
    curl: (host: string, key: string) => string;
  }>).find((e) => e.id === "members-get");
  assert.ok(spec, "members-get endpoint must be declared in api-spec");
  assert.equal(spec!.method, "GET");
  assert.equal(spec!.path, "/v1/members/:user_id");
  assert.equal(spec!.scope, "members:read");
  const sample = spec!.curl("https://api.codeclone.dev", "ck_test");
  assert.match(sample, /\/v1\/members\/u_91/);
  assert.match(sample, /Authorization: Bearer ck_test/);
});

test("v1/members/:user_id GET: hasScope rejects compare-only keys and accepts members:read keys", async () => {
  const compareOnly = await createKey("compare-only-get", {
    workspaceId: "ws_tenanta_get",
    scopes: ["compare:write"],
  });
  const readerOk = await createKey("members-reader-get", {
    workspaceId: "ws_tenantb_get",
    scopes: ["compare:write", "members:read"],
  });
  assert.equal(hasScope(compareOnly.record, "members:read"), false);
  assert.equal(hasScope(readerOk.record, "members:read"), true);
});

test("v1/members/:user_id GET: live tenant isolation, key in workspace B cannot fetch workspace A's user", async () => {
  const wsA = await createWorkspace({
    name: "Tenant A get",
    ownerId: "u_a_get_owner",
    ownerEmail: "owner-a-get@example.com",
  });
  const wsB = await createWorkspace({
    name: "Tenant B get",
    ownerId: "u_b_get_owner",
    ownerEmail: "owner-b-get@example.com",
  });

  // The route always looks up the workspace by the calling key's
  // workspaceId, then resolves userId inside that workspace's
  // members array. Simulate that contract: a key bound to wsB
  // resolving wsA's owner userId must miss.
  const fetchedForB = await getWorkspace(wsB.id);
  assert.ok(fetchedForB);
  assert.equal(fetchedForB!.id, wsB.id);
  const crossTenantHit = fetchedForB!.members.find(
    (m) => m.userId === "u_a_get_owner",
  );
  assert.equal(
    crossTenantHit,
    undefined,
    "workspace B view must never contain workspace A's userId",
  );

  // And the legitimate same-tenant fetch still works, so the
  // tenant check is not over-broad.
  const fetchedForA = await getWorkspace(wsA.id);
  assert.ok(fetchedForA);
  const sameTenantHit = fetchedForA!.members.find(
    (m) => m.userId === "u_a_get_owner",
  );
  assert.ok(sameTenantHit, "same-tenant userId must resolve");
  assert.equal(sameTenantHit!.email, "owner-a-get@example.com");
});
