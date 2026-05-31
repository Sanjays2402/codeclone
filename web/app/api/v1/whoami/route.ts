/**
 * Public GET /v1/whoami: read-only key introspection.
 *
 * Enterprise customers running CodeClone in CI or in pipelines need a
 * cheap, side-effect-free way to verify a Bearer token is the one they
 * think it is. This endpoint returns the calling key's identity,
 * scopes, workspace context, current per-minute rate-limit window,
 * monthly plan quota state, and policy posture, without consuming a
 * rate-limit slot or counting toward billable usage.
 *
 * Auth: Bearer token or `x-api-key` header, same as the rest of /v1.
 * Scope: none required. The endpoint reveals only information about
 *        the calling key itself, so any valid key may call it.
 * Side effects: writes one row to the audit log (action `v1.whoami.read`)
 *        and updates `lastUsedAt` on the key. Does not increment the
 *        rate-limit counter and does not log billable usage.
 *
 * Still enforced: revocation, expiry, workspace IP allowlist, per-key
 * IP allowlist, workspace residency, workspace API key policy, and
 * workspace lockdown. These are access-control gates; if they would
 * block a real request, they also block introspection.
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  recordUse,
} from "../../../../lib/api-keys";
import { effectiveRpm, peek as peekRateLimit, rateLimitHeaders } from "../../../../lib/rate-limit";
import { enforceWorkspaceAllowlistForKey, enforceKeyAllowlist } from "../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../lib/lockdown-enforce";
import { tryRecordAudit } from "../../../../lib/audit";
import { getWorkspace } from "../../../../lib/workspaces";
import { workspaceQuotaCheck, planHeaders } from "../../../../lib/plans";

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

  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/whoami" });
  if (lockdownBlocked) return lockdownBlocked;
  const wsBlocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (wsBlocked) return wsBlocked;
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return keyBlocked;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return residencyBlocked;
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return policyBlocked;

  // Peek the rate-limit window without incrementing. Customers can call
  // /v1/whoami from health checks without burning their own budget.
  const rpm = effectiveRpm(key);
  const rl = await peekRateLimit(key.id, rpm);
  const rlHeaders = rateLimitHeaders(rl);

  const ws = key.workspaceId ? await getWorkspace(key.workspaceId) : null;
  const wsQuota = await workspaceQuotaCheck(key.workspaceId ?? null, ws);
  const planHdrs = wsQuota ? planHeaders(wsQuota) : {};

  // Update lastUsedAt + record IP so an operator looking at a key's
  // activity can tell it is alive. This is the same hook every other
  // /v1 route uses, kept consistent so leaked-credential triage works.
  void recordUse(key.id, clientIpFromRequest(req));

  void tryRecordAudit(req, {
    action: "v1.whoami.read",
    actorId: key.id,
    workspaceId: key.workspaceId ?? null,
    target: { type: "api_key", id: key.id, label: key.label },
    status: "ok",
    meta: { prefix: key.prefix },
  });

  const body = {
    key: {
      id: key.id,
      label: key.label,
      prefix: key.prefix,
      scopes: key.scopes ?? null,
      created_at: key.createdAt,
      last_used_at: key.lastUsedAt ?? null,
      expires_at: key.expiresAt ?? null,
      revoked: Boolean(key.revoked),
      workspace_id: key.workspaceId ?? null,
      user_id: key.userId ?? null,
      ip_allowlist_count: Array.isArray(key.ipAllowlist) ? key.ipAllowlist.length : 0,
    },
    workspace: ws
      ? {
          id: ws.id,
          name: ws.name ?? null,
          plan: ws.plan ?? "free",
        }
      : null,
    rate_limit: {
      limit: rl.limit,
      remaining: rl.remaining,
      reset_at: Math.floor(rl.resetAt / 1000),
      window_seconds: 60,
    },
    plan: wsQuota
      ? {
          id: wsQuota.plan.id,
          monthly_limit: wsQuota.limit,
          month_to_date: wsQuota.monthToDate,
          remaining: wsQuota.remaining,
        }
      : null,
    request_ip: clientIpFromRequest(req),
    server_time: Date.now(),
  };

  return NextResponse.json(body, {
    headers: { ...rlHeaders, ...planHdrs },
  });
}
