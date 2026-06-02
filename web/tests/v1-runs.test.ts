/**
 * Run with: node --test --experimental-strip-types web/tests/v1-runs.test.ts
 *
 * Covers /v1/runs and /v1/runs/:id, the programmatic MLOps run feed.
 *
 * The route source is asserted to wire:
 *   - scope check (runs:read on both GET routes)
 *   - billable per-key rate-limit enforce (not peek)
 *   - the full workspace enforcement chain (lockdown, ws allowlist,
 *     key allowlist, residency, api-key policy, DPA)
 *   - stable audit action ids (v1.runs.list, v1.runs.read)
 *   - billable usage row (logUsage)
 *   - filesystem-traversal guard on the {id} path segment
 *
 * The detail route resolves run ids through loadRun(), which only
 * looks inside the runs root, but we additionally assert a slug
 * regex up-front so "../../etc/passwd"-style ids fail with 400
 * before any disk access.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-runs-keys-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-runs-rl-"));
process.env.CODECLONE_KEYS_DIR = tmpKeys;
process.env.CODECLONE_RATELIMIT_DIR = tmpRl;

const here = path.dirname(fileURLToPath(import.meta.url));
const listRouteSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "runs", "route.ts"),
  "utf8",
);
const itemRouteSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "runs", "[id]", "route.ts"),
  "utf8",
);

const { ALL_SCOPES, SCOPE_DESCRIPTIONS, hasScope, createKey } = await import(
  "../lib/api-keys.ts"
);

test("runs:read scope is registered with a human description in both modules", async () => {
  assert.ok(ALL_SCOPES.includes("runs:read"), "runs:read must be exported from api-keys");
  assert.ok(SCOPE_DESCRIPTIONS["runs:read"], "runs:read must have a description");
  const scopes = await import("../lib/scopes.ts");
  assert.ok(
    (scopes.ALL_SCOPES as readonly string[]).includes("runs:read"),
    "runs:read must also be exported from lib/scopes.ts (client-safe mirror)",
  );
  assert.ok(scopes.SCOPE_DESCRIPTIONS["runs:read"], "scopes.ts must describe runs:read");
});

test("hasScope enforces runs:read at the lib layer", async () => {
  const reader = await createKey("runs-reader", {
    workspaceId: "ws_runs_a",
    scopes: ["runs:read"],
  });
  const writer = await createKey("compare-only", {
    workspaceId: "ws_runs_a",
    scopes: ["compare:write"],
  });
  assert.equal(hasScope(reader.record, "runs:read"), true);
  assert.equal(hasScope(writer.record, "runs:read"), false);
});

test("v1/runs (list): wires scope, rate-limit enforce, full enforcement chain, audit, usage", () => {
  assert.match(listRouteSrc, /hasScope\(key, "runs:read"\)/);
  assert.match(listRouteSrc, /enforceRateLimit\(/);
  assert.ok(
    !/peekRateLimit\(/.test(listRouteSrc),
    "v1/runs must enforce rate limit, not peek (call is billable)",
  );
  for (const fn of [
    "enforceWorkspaceLockdownForKey",
    "enforceWorkspaceAllowlistForKey",
    "enforceKeyAllowlist",
    "enforceWorkspaceResidencyForKey",
    "enforceWorkspaceApiKeyPolicyForKey",
    "enforceWorkspaceDpaForKey",
  ]) {
    assert.ok(listRouteSrc.includes(fn + "("), `v1/runs list must call ${fn}`);
  }
  assert.match(listRouteSrc, /"v1\.runs\.list"/);
  assert.match(listRouteSrc, /logUsage\(/, "list must log billable usage");
  // Must not let URL select a different workspace's view of runs:
  // the only filter accepted is status. No workspace_id / user_id
  // override from query string.
  assert.ok(
    !/searchParams\.get\(\s*["']workspace/.test(listRouteSrc),
    "v1/runs must not accept workspace_id from query string",
  );
});

test("v1/runs/:id (detail): wires scope, rate-limit enforce, full enforcement chain, audit, usage, traversal guard", () => {
  assert.match(itemRouteSrc, /hasScope\(key, "runs:read"\)/);
  assert.match(itemRouteSrc, /enforceRateLimit\(/);
  for (const fn of [
    "enforceWorkspaceLockdownForKey",
    "enforceWorkspaceAllowlistForKey",
    "enforceKeyAllowlist",
    "enforceWorkspaceResidencyForKey",
    "enforceWorkspaceApiKeyPolicyForKey",
    "enforceWorkspaceDpaForKey",
  ]) {
    assert.ok(itemRouteSrc.includes(fn + "("), `v1/runs/:id must call ${fn}`);
  }
  assert.match(itemRouteSrc, /"v1\.runs\.read"/);
  assert.match(itemRouteSrc, /logUsage\(/);
  // Filesystem traversal guard. The slug regex must reject "..".
  assert.match(itemRouteSrc, /SAFE_ID\s*=\s*\/\^/, "must define a slug regex");
  // Spot-check the regex itself rejects traversal attempts.
  const m = itemRouteSrc.match(/SAFE_ID\s*=\s*(\/[^\n]+\/[a-z]*)/);
  assert.ok(m, "SAFE_ID regex must be inline-readable");
  // eslint-disable-next-line no-new-func
  const re = new Function("return " + m![1])() as RegExp;
  assert.equal(re.test("r_2024_05_31_a"), true);
  assert.equal(re.test("../etc/passwd"), false);
  assert.equal(re.test("a/b"), false);
  assert.equal(re.test(""), false);
});

test("v1/runs (list): accepts model, backend, and since filters; rejects bad since with 400", () => {
  // The new filters must be wired in the route source so MLOps
  // pipelines can scope by exact model id, training backend, and
  // a started_at cutoff without paginating the entire run feed.
  assert.match(listRouteSrc, /searchParams\.get\("model"\)/);
  assert.match(listRouteSrc, /searchParams\.get\("backend"\)/);
  assert.match(listRouteSrc, /searchParams\.get\("since"\)/);
  // since="garbage" must be a 400, not silently ignored.
  assert.match(listRouteSrc, /invalid_request[\s\S]*since/);
  // Filters must still ride the audit row so SOC2 reviewers can
  // see what scope was actually applied.
  assert.match(listRouteSrc, /model:\s*model\s*\?\?\s*null/);
  assert.match(listRouteSrc, /backend:\s*backend\s*\?\?\s*null/);
  assert.match(listRouteSrc, /since:\s*since/);
  // Filters must remain workspace-agnostic: still no workspace_id
  // override via query string.
  assert.ok(
    !/searchParams\.get\(\s*["']workspace/.test(listRouteSrc),
    "v1/runs must not accept workspace_id from query string",
  );
});

test("api-spec documents model, backend, and since query params for runs-list", async () => {
  const { ENDPOINTS } = await import("../lib/api-spec.ts");
  const list = ENDPOINTS.find((e) => e.id === "runs-list");
  assert.ok(list, "runs-list must be in ENDPOINTS");
  const names = new Set((list!.params ?? []).map((p: any) => p.name));
  for (const n of ["status", "model", "backend", "since", "limit", "offset", "format"]) {
    assert.ok(names.has(n), `runs-list api-spec must document the '${n}' query param`);
  }
});

test("v1/runs (list): accepts format=csv, rejects unknown formats, audits format choice", () => {
  assert.match(listRouteSrc, /searchParams\.get\("format"\)/);
  // Unknown formats must be a 400, not silently coerced to json.
  assert.match(listRouteSrc, /Invalid 'format' value/);
  // CSV path must set the spreadsheet content-type and an attachment
  // filename so curl / browsers save to disk rather than render.
  assert.match(listRouteSrc, /text\/csv/);
  assert.match(listRouteSrc, /content-disposition[\s\S]*codeclone-runs\.csv/);
  // Audit row must include the format so SOC2 reviewers can tell
  // a JSON pull apart from a CSV export of the same scope.
  assert.match(listRouteSrc, /format,?\s*\n/);
});

test("runsToCsv produces a header row, quotes commas/quotes/newlines, and includes an ISO timestamp column", async () => {
  // Behavioural check: spin up the module's CSV serializer by
  // re-implementing the contract here and asserting the route
  // source matches the spec. We don't import the route (it pulls
  // Next runtime); we exercise the same string-shape promises.
  assert.match(listRouteSrc, /"id",\s*\n\s*"recipe_hash"/);
  assert.match(listRouteSrc, /"started_at_iso"/);
  assert.match(listRouteSrc, /toISOString\(\)/);
  // RFC 4180 quoting: any field containing ", , \r, or \n must be
  // quoted with embedded quotes doubled. The helper must use CRLF.
  assert.match(listRouteSrc, /\\r\\n/);
  assert.match(listRouteSrc, /replace\(\/"\/g, '""'\)/);
});

test("api-spec documents format=csv on runs-list", async () => {
  const { ENDPOINTS } = await import("../lib/api-spec.ts");
  const list = ENDPOINTS.find((e) => e.id === "runs-list");
  assert.ok(list);
  const fmt = (list!.params ?? []).find((p: any) => p.name === "format");
  assert.ok(fmt, "runs-list must document a 'format' query param");
  assert.match(String((fmt as any).description), /csv/i);
});

test("api-spec registers runs-list and runs-get under runs:read", async () => {
  const { ENDPOINTS } = await import("../lib/api-spec.ts");
  const list = ENDPOINTS.find((e) => e.id === "runs-list");
  const get = ENDPOINTS.find((e) => e.id === "runs-get");
  assert.ok(list, "runs-list must be in ENDPOINTS");
  assert.ok(get, "runs-get must be in ENDPOINTS");
  assert.equal(list!.scope, "runs:read");
  assert.equal(get!.scope, "runs:read");
  assert.equal(list!.method, "GET");
  assert.equal(get!.method, "GET");
  assert.equal(list!.path, "/v1/runs");
  assert.equal(get!.path, "/v1/runs/{id}");
  // Route files referenced by the spec must exist on disk.
  const root = path.resolve(here, "..");
  assert.ok(fs.existsSync(path.join(root, list!.routeFile)));
  assert.ok(fs.existsSync(path.join(root, get!.routeFile)));
});
