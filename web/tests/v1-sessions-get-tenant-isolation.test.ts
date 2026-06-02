/**
 * Run with: node --test --experimental-strip-types web/tests/v1-sessions-get-tenant-isolation.test.ts
 *
 * Covers GET /v1/sessions/:jti, the programmatic single-session
 * read used by SOAR / SecOps runbooks that already know a
 * suspicious jti (from a SIEM alert or a prior /v1/sessions
 * snapshot) and want to confirm it is still active and resolve
 * the owning user before revoking.
 *
 *   1) Route source wires sessions:read scope, the per-key
 *      rate-limit enforce (billable), the full workspace
 *      enforcement chain (lockdown, IP allowlists, residency,
 *      key policy), tenant scoping via findSessionOwner +
 *      workspace membership, and a stable audit action id
 *      `v1.sessions.get`.
 *
 *   2) The spec lists sessions-get with the right scope + curl.
 *
 *   3) Cross-tenant probes surface as 404 (not 403) so the
 *      existence of another tenant's jti cannot be inferred
 *      from status codes. The route must not accept a userId
 *      from the caller.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "sessions", "[jti]", "route.ts"),
  "utf8",
);

const { ENDPOINTS } = await import("../lib/api-spec.ts");

test("v1/sessions/:jti GET: route wires scope, rate-limit enforce, full enforcement chain, tenant scope, audit", () => {
  // GET branch present.
  assert.match(routeSrc, /export async function GET\(/);
  // Correct read scope (DELETE uses sessions:write, GET must be sessions:read).
  const getBlockMatch = routeSrc.match(
    /export async function GET\([\s\S]*?\n\}\n/,
  );
  assert.ok(getBlockMatch, "GET block must be parseable");
  const getBlock = getBlockMatch![0];
  assert.match(getBlock, /hasScope\(key, "sessions:read"\)/);
  // Billable enforce, not peek.
  assert.match(getBlock, /enforceRateLimit\(/);
  assert.ok(!/peekRateLimit\(/.test(getBlock), "GET must enforce, not peek");
  // Full workspace enforcement chain.
  assert.match(getBlock, /enforceWorkspaceLockdownForKey/);
  assert.match(getBlock, /enforceWorkspaceAllowlistForKey/);
  assert.match(getBlock, /enforceKeyAllowlist/);
  assert.match(getBlock, /enforceWorkspaceResidencyForKey/);
  assert.match(getBlock, /enforceWorkspaceApiKeyPolicyForKey/);
  // Tenant scope: owner is resolved server-side from jti only,
  // then cross-checked against the calling key's workspace.
  assert.match(getBlock, /findSessionOwner\(jti\)/);
  assert.match(getBlock, /getWorkspace\(key\.workspaceId\)/);
  assert.match(getBlock, /memberIds\.has\(owner\.userId\)/);
  // Caller may not name a userId in URL or body.
  assert.ok(
    !/body.*user_?id|searchParams.*user_?id/i.test(getBlock),
    "v1/sessions/:jti GET must not accept a userId from the caller",
  );
  // Cross-tenant probes get 404 (not 403).
  assert.match(getBlock, /return notFound\(\)/);
  // Stable audit id under v1.sessions.get.
  assert.match(getBlock, /"v1\.sessions\.get"/);
  // Response shape must not leak the session secret.
  assert.ok(
    !/secret|token|cookie/i.test(getBlock.split("NextResponse.json(")[1] ?? ""),
    "response body must not include secret/token/cookie fields",
  );
});

test("v1/sessions/:jti GET: api-spec exposes sessions-get with sessions:read scope", () => {
  const spec = (ENDPOINTS as ReadonlyArray<{
    id: string;
    method: string;
    path: string;
    scope: string;
    curl: (host: string, key: string) => string;
  }>).find((e) => e.id === "sessions-get");
  assert.ok(spec, "sessions-get endpoint must be declared in api-spec");
  assert.equal(spec!.method, "GET");
  assert.equal(spec!.path, "/v1/sessions/{jti}");
  assert.equal(spec!.scope, "sessions:read");
  const sample = spec!.curl("https://api.codeclone.dev", "ck_test");
  assert.match(sample, /\/v1\/sessions\/k7Q1abcDEF/);
  assert.match(sample, /Authorization: Bearer ck_test/);
});

test("v1/sessions/:jti GET: 404-not-403 for unknown jti and oversized jti", () => {
  // notFound() helper returns 404. The guard rejecting oversized /
  // empty jtis must route through it so existence cannot be probed.
  assert.match(routeSrc, /if \(!jti \|\| typeof jti !== "string" \|\| jti\.length > 256\) return notFound\(\);/);
  // Both branches that filter cross-tenant or stale sessions must
  // also return notFound (404), not a 403 or 401.
  assert.match(routeSrc, /if \(!owner\) return notFound\(\);/);
});
