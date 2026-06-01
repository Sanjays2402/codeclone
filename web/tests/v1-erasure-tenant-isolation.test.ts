/**
 * Run with: node --test --experimental-strip-types web/tests/v1-erasure-tenant-isolation.test.ts
 *
 * Covers POST /v1/erasure, the programmatic GDPR Article 17
 * (right to erasure) execution endpoint for saved comparisons.
 *
 *   1) Route source wires the scope check, the per-key rate-limit
 *      enforce (billable), the full workspace enforcement chain,
 *      tenant scope (no path may let body select another workspace),
 *      the audit row under the stable v1.erasure.execute action,
 *      and the dry_run preview path.
 *
 *   2) ALL_SCOPES exposes erasure:write so the API keys UI can grant
 *      it, SCOPE_DESCRIPTIONS has copy for it, and scopes.ts mirrors
 *      api-keys.ts (docs.test.ts also asserts this, but we double-
 *      check here so a partial edit fails fast).
 *
 *   3) Scope enforcement: hasScope rejects keys without erasure:write
 *      and accepts keys minted with it.
 *
 *   4) Tenant isolation against the share store: a share record
 *      created in workspace A is invisible to a workspace-B scoped
 *      load/delete, so even an explicit-id erasure call from a
 *      workspace-B key can never delete a workspace-A record.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpKeys = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-erasure-keys-"));
const tmpRl = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-erasure-rl-"));
const tmpShares = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-erasure-shares-"));
const tmpAudit = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-v1-erasure-audit-"));
process.env.CODECLONE_KEYS_DIR = tmpKeys;
process.env.CODECLONE_RATELIMIT_DIR = tmpRl;
process.env.CODECLONE_SHARES_DIR = tmpShares;
process.env.CODECLONE_AUDIT_DIR = tmpAudit;

const here = path.dirname(fileURLToPath(import.meta.url));
const routeSrc = fs.readFileSync(
  path.resolve(here, "..", "app", "api", "v1", "erasure", "route.ts"),
  "utf8",
);

const { createKey, hasScope, ALL_SCOPES, SCOPE_DESCRIPTIONS } = await import(
  "../lib/api-keys.ts"
);
const scopesModule = await import("../lib/scopes.ts");
const { createShare, loadShare, deleteShare } = await import("../lib/share.ts");

test("v1/erasure: route source wires scope, rate-limit, enforcement chain, tenant scope, audit, dry-run", () => {
  assert.match(routeSrc, /hasScope\(key, "erasure:write"\)/);
  // Must enforce (billable), not peek. Bulk delete is heavier than a
  // typical /v1 write and must spend a rate-limit slot.
  assert.match(routeSrc, /enforceRateLimit\(/);
  assert.ok(
    !/peekRateLimit\(/.test(routeSrc),
    "v1/erasure must enforce, not peek",
  );
  // Standard workspace enforcement chain.
  assert.match(routeSrc, /enforceWorkspaceLockdownForKey/);
  assert.match(routeSrc, /enforceWorkspaceAllowlistForKey/);
  assert.match(routeSrc, /enforceKeyAllowlist/);
  assert.match(routeSrc, /enforceWorkspaceResidencyForKey/);
  assert.match(routeSrc, /enforceWorkspaceApiKeyPolicyForKey/);
  // Tenant scope: every load/delete is bound to key.workspaceId via
  // the ScopeHint, never via a body/query field.
  assert.match(routeSrc, /key\.workspaceId/);
  assert.match(routeSrc, /loadShare\([^)]*scope/);
  assert.match(routeSrc, /deleteShare\([^)]*scope/);
  assert.ok(
    !/workspaceId.*searchParams|searchParams.*workspaceId|body\.workspace/.test(routeSrc),
    "v1/erasure must not let query string or body select workspace",
  );
  // Audit rows for both live execution and dry-run probes.
  assert.match(routeSrc, /"v1\.erasure\.execute"/);
  assert.match(routeSrc, /"v1\.erasure\.dry_run"/);
  // Dry-run uses the shared helper + header so behavior is consistent
  // with other /v1 destructive endpoints.
  assert.match(routeSrc, /isDryRun\(/);
  assert.match(routeSrc, /DRY_RUN_HEADER/);
  // Refuses keys not bound to a workspace; legacy unscoped shares
  // are never erasable via the public API.
  assert.match(routeSrc, /requires a workspace-scoped key/);
  assert.match(routeSrc, /allowLegacy: false/);
});

test("v1/erasure: ALL_SCOPES exposes erasure:write with a description, scopes.ts mirrors api-keys.ts", () => {
  assert.ok((ALL_SCOPES as readonly string[]).includes("erasure:write"));
  assert.ok(
    typeof SCOPE_DESCRIPTIONS["erasure:write" as keyof typeof SCOPE_DESCRIPTIONS] ===
      "string",
  );
  assert.deepEqual(
    [...(scopesModule.ALL_SCOPES as readonly string[])],
    [...(ALL_SCOPES as readonly string[])],
  );
  assert.deepEqual(scopesModule.SCOPE_DESCRIPTIONS, SCOPE_DESCRIPTIONS);
});

test("v1/erasure: hasScope rejects keys without erasure:write and accepts keys with it", async () => {
  const sharesOnly = await createKey("shares-only", {
    workspaceId: "ws_tenanta",
    scopes: ["shares:write"],
  });
  const erasureOk = await createKey("erasure-ok", {
    workspaceId: "ws_tenantb",
    scopes: ["shares:write", "erasure:write"],
  });
  assert.equal(hasScope(sharesOnly.record, "erasure:write"), false);
  assert.equal(hasScope(erasureOk.record, "erasure:write"), true);
});

test("v1/erasure: tenant isolation, workspace-B key cannot load or delete a workspace-A share", async () => {
  const aRec = await createShare({
    a: "def a():\n    return 1\n",
    b: "def b():\n    return 1\n",
    language: "python",
    result: {
      language: "python",
      scores: {
        tokenJaccard: 1,
        shingleJaccard: 1,
        containment: 1,
        shared: { tokens: 1, shingles: 1 },
        size: { aTokens: 1, bTokens: 1, aShingles: 1, bShingles: 1 },
        matchedTokens: ["return"],
      },
      alignment: {
        matches: [],
        aLines: 0,
        bLines: 0,
        exactPairs: 0,
        movedPairs: 0,
        coverageA: 0,
        coverageB: 0,
      },
      clone: {
        type: "type-1",
        confidence: 1,
        structuralSim: 1,
        rawTokenSim: 1,
        rationale: ["test fixture"],
        label: "exact-copy",
      },
      bytes: { a: 0, b: 0 },
      latency_ms: 0,
      method: "test",
    },
    workspaceId: "ws_tenanta",
  });

  // Sanity: workspace A can see and delete its own record.
  const seenByA = await loadShare(aRec.id, { workspaceId: "ws_tenanta", allowLegacy: false });
  assert.ok(seenByA, "workspace A must see its own share");

  // Workspace B, asking with its own scope, must NOT see the record.
  const seenByB = await loadShare(aRec.id, { workspaceId: "ws_tenantb", allowLegacy: false });
  assert.equal(seenByB, null, "workspace B must never see workspace A's share");

  // The route uses the same scope hint for delete, so attempting to
  // erase under workspace B's scope is a no-op and the file remains.
  const wouldDelete = await deleteShare(aRec.id, { workspaceId: "ws_tenantb", allowLegacy: false });
  assert.equal(wouldDelete, false, "workspace B must not delete workspace A's share");

  // Record is still there for its rightful owner.
  const stillThere = await loadShare(aRec.id, { workspaceId: "ws_tenanta", allowLegacy: false });
  assert.ok(stillThere, "share must survive a cross-tenant erasure attempt");
});
