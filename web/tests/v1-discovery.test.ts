/**
 * Run with: node --test --experimental-strip-types web/tests/v1-discovery.test.ts
 *
 * Asserts the GET /v1/discovery manifest contract that procurement and
 * SDK generators depend on. The route file is exercised directly so a
 * regression in shape, scope coverage, or endpoint completeness fails
 * fast and not in a customer's pipeline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTE = path.resolve(here, "..", "app", "api", "v1", "discovery", "route.ts");

const { buildDiscovery } = await import("../lib/discovery.ts");
const { ENDPOINTS } = await import("../lib/api-spec.ts");
const { ALL_SCOPES } = await import("../lib/scopes.ts");

test("discovery manifest exposes every documented endpoint and scope", () => {
  const m = buildDiscovery("https://codeclone.example");
  assert.equal(m.api.name, "CodeClone");
  assert.equal(m.api.version, "v1");
  assert.equal(m.api.base_url, "https://codeclone.example");

  // Every spec endpoint appears in discovery, with method+path preserved.
  const byId = new Map(m.endpoints.map((e) => [e.id, e]));
  for (const ep of ENDPOINTS) {
    const found = byId.get(ep.id);
    assert.ok(found, `discovery missing endpoint id ${ep.id}`);
    assert.equal(found.method, ep.method);
    assert.equal(found.path, ep.path);
    assert.equal(found.scope, ep.scope);
  }

  // Every canonical scope appears in the scopes block with a description.
  const scopeIds = new Set(m.scopes.map((s) => s.id));
  for (const s of ALL_SCOPES) {
    assert.ok(scopeIds.has(s), `discovery scopes missing ${s}`);
  }
  for (const s of m.scopes) {
    assert.ok(s.description && s.description.length > 0, `scope ${s.id} missing description`);
  }
});

test("discovery scope -> endpoints reverse index matches forward index", () => {
  const m = buildDiscovery("https://codeclone.example");
  const fromScopes = new Map<string, Set<string>>();
  for (const s of m.scopes) fromScopes.set(s.id, new Set(s.endpoints));
  for (const ep of m.endpoints) {
    const set = fromScopes.get(ep.scope);
    assert.ok(set, `scope ${ep.scope} not present in manifest`);
    assert.ok(
      set!.has(ep.id),
      `endpoint ${ep.id} not listed under its scope ${ep.scope} in the reverse index`,
    );
  }
});

test("discovery rate-limit block advertises the documented response headers", () => {
  const m = buildDiscovery("https://codeclone.example");
  for (const h of [
    "X-RateLimit-Limit",
    "X-RateLimit-Remaining",
    "X-RateLimit-Reset",
    "Retry-After",
  ]) {
    assert.ok(
      m.rate_limits.response_headers.includes(h),
      `discovery must advertise ${h}`,
    );
  }
  assert.equal(m.rate_limits.throttled_status, 429);
  assert.equal(typeof m.rate_limits.default_requests_per_minute, "number");
});

test("discovery route is unauthenticated and side-effect free (source assertions)", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  // Must NOT pull auth, audit, rate-limit-enforce, usage, or webhooks.
  // A regression that wires any of these would mean credential-free
  // callers (procurement scanners) start tripping policy and that is
  // exactly what this endpoint is meant to avoid.
  for (const banned of [
    "extractBearer",
    "findByPlaintext",
    "enforce as enforceRateLimit",
    "logUsage",
    "tryRecordAudit",
    "dispatchEvent",
    "enforceWorkspaceAllowlistForKey",
  ]) {
    assert.ok(
      !src.includes(banned),
      `/v1/discovery must not import ${banned}; route would become credentialed`,
    );
  }
});
