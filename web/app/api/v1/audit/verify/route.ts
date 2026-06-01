/**
 * GET /v1/audit/verify: programmatic tamper-evidence verification.
 *
 * The dashboard /api/audit/verify endpoint is cookie-authenticated and
 * meant for a human compliance reviewer. Enterprise SecOps and SOC2
 * evidence collectors need to verify the audit hash chain on a cron
 * from a Bearer-authenticated machine, pin the resulting `last_hash`
 * to an external notary / WORM bucket / S3 Object Lock manifest, and
 * page on `ok=false` from the same SIEM that ingests /v1/audit.
 *
 * What it does
 * ------------
 * Walks every entry in the on-disk append-only audit log in order
 * and checks two invariants for each chained entry:
 *   1. sha256(canonical(entry without `hash`)) == entry.hash
 *   2. entry.prevHash == hash of the previous chained entry
 * Legacy entries written before the chain field existed are counted
 * but not chained; verify still succeeds as long as every chained
 * entry is intact. The returned `last_hash` is the head of the chain
 * and is the value to pin externally for tamper evidence.
 *
 * Why the chain is global, not per-workspace
 * ------------------------------------------
 * The hash chain is intentionally a single ordered sequence across
 * all workspaces: that is what makes deletion of a tenant's row
 * detectable. Splitting it per tenant would let a workspace owner
 * silently truncate their own slice. Therefore the integrity result
 * itself (ok, totals, lastHash, brokenAt) is not tenant-private
 * information. Cross-tenant isolation still holds because:
 *   - this endpoint never returns individual audit entries (use
 *     GET /v1/audit for that, which is workspace-scoped),
 *   - calling the endpoint requires a valid workspace-scoped Bearer
 *     key with `audit:read`,
 *   - the act of verifying is itself audited under the caller's
 *     workspace so a tampering attempt cannot quietly verify.
 *
 * Auth: Bearer token or `x-api-key` header.
 * Scope: `audit:read`. Legacy keys with no `scopes` field keep working
 *        (full privileges, matching every other /v1 route).
 * Tenant scope: caller must have a workspace; keys with no workspace
 *        get 403 because the action is meaningless without one.
 * Side effects: spends a per-key rate-limit slot, records one
 *        `v1.audit.verify` audit row under the caller's workspace,
 *        updates the key's `lastUsedAt`/`recentIps`. Does not charge
 *        plan quota (verification is metadata, not a billable call).
 *
 * Status codes:
 *   200 with `{ ok: true,  ... }`  chain is intact
 *   409 with `{ ok: false, ... }`  chain is broken (see `broken_at`)
 *   401 / 403 / 429 standard /v1 errors
 *
 * Response headers:
 *   X-Audit-Chain-Status: "ok" | "broken"
 *   X-RateLimit-*       per-key window state
 *
 * Still enforced: revocation, expiry, workspace IP allowlist, per-key
 * IP allowlist, residency, workspace API key policy, lockdown.
 */
import { NextResponse } from "next/server";
import { extractBearer, findByPlaintext, hasScope, recordUse } from "../../../../../lib/api-keys";
import { effectiveRpm, enforce as enforceRateLimit } from "../../../../../lib/rate-limit";
import { enforceWorkspaceAllowlistForKey, enforceKeyAllowlist } from "../../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../../lib/lockdown-enforce";
import { verifyAuditChain, tryRecordAudit } from "../../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(message: string) {
  return NextResponse.json(
    { error: { type: "unauthorized", message } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

export async function GET(req: Request) {
  const token = extractBearer(req);
  if (!token) {
    return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  }
  const key = await findByPlaintext(token);
  if (!key) {
    return unauthorized("Invalid or revoked API key.");
  }

  if (!hasScope(key, "audit:read")) {
    return NextResponse.json(
      {
        error: {
          type: "forbidden",
          message: "This key is missing the 'audit:read' scope.",
          required_scope: "audit:read",
        },
      },
      { status: 403 },
    );
  }

  // Keys with no workspace cannot meaningfully verify on behalf of a tenant
  // and we do not want platform-wide verifications attributed to a null
  // workspace in the audit trail.
  if (!key.workspaceId) {
    return NextResponse.json(
      {
        error: {
          type: "forbidden",
          message: "Verification requires a key minted in a workspace.",
        },
      },
      { status: 403 },
    );
  }

  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, {
    route: "/v1/audit/verify",
  });
  if (lockdownBlocked) return lockdownBlocked;
  const wsBlocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (wsBlocked) return wsBlocked;
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return keyBlocked;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return residencyBlocked;
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return policyBlocked;

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;
  const rlHeaders = rl.headers;
  void effectiveRpm(key);

  const result = await verifyAuditChain();

  void recordUse(key.id, clientIpFromRequest(req));

  void tryRecordAudit(req, {
    action: "v1.audit.verify",
    actorId: key.id,
    workspaceId: key.workspaceId,
    target: { type: "audit_log", id: key.workspaceId },
    status: result.ok ? "ok" : "error",
    meta: {
      prefix: key.prefix,
      total_entries: result.totalEntries,
      chained_entries: result.chainedEntries,
      legacy_entries: result.legacyEntries,
      last_hash: result.lastHash,
      broken_at: result.brokenAt,
      first_day: result.firstDay,
      last_day: result.lastDay,
    },
  });

  return NextResponse.json(
    {
      ok: result.ok,
      total_entries: result.totalEntries,
      chained_entries: result.chainedEntries,
      legacy_entries: result.legacyEntries,
      first_day: result.firstDay,
      last_day: result.lastDay,
      last_hash: result.lastHash,
      broken_at: result.brokenAt,
    },
    {
      status: result.ok ? 200 : 409,
      headers: {
        ...rlHeaders,
        "Cache-Control": "no-store",
        "X-Audit-Chain-Status": result.ok ? "ok" : "broken",
      },
    },
  );
}
