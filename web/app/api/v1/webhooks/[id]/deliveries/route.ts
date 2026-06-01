/**
 * Public /v1/webhooks/[id]/deliveries endpoint.
 *
 * Authenticated via Bearer token (or x-api-key header). Tenant-scoped
 * via the calling key's workspaceId: a caller from workspace A asking
 * for deliveries owned by workspace B receives a flat 404, not a 403,
 * so workspace boundaries cannot be probed for existence.
 *
 * GET — requires `webhooks:read`. Returns the recent delivery log for
 *       a single webhook so customers can drive their own dashboards,
 *       alerting, or compliance retention pipelines off it.
 *
 * Query params:
 *   limit  1..200 (default 50) — most recent N deliveries
 *
 * Standard enforcement chain (lockdown, workspace + key IP allowlists,
 * residency, API key policy, rate limit) matches every other /v1 route.
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  recordUse,
} from "../../../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../../../lib/rate-limit";
import {
  enforceWorkspaceAllowlistForKey,
  enforceKeyAllowlist,
} from "../../../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../../../lib/lockdown-enforce";
import {
  loadWebhookForWorkspace,
  listDeliveriesForWorkspace,
} from "../../../../../../lib/webhooks";
import { logUsage } from "../../../../../../lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

const ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

function unauthorized(message: string) {
  return NextResponse.json(
    { error: { type: "unauthorized", message } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

function insufficientScope(required: string, granted: string[] | null | undefined) {
  return NextResponse.json(
    {
      error: {
        type: "insufficient_scope",
        message: `This key is missing the '${required}' scope.`,
        required_scope: required,
        granted_scopes: granted ?? null,
      },
    },
    { status: 403 },
  );
}

function tenantRequired() {
  return NextResponse.json(
    {
      error: {
        type: "tenant_required",
        message: "This API key is not bound to a workspace.",
      },
    },
    { status: 403 },
  );
}

function notFound() {
  return NextResponse.json(
    { error: { type: "not_found", message: "Webhook not found." } },
    { status: 404 },
  );
}

function clampLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(200, Math.floor(n));
}

export async function GET(req: Request, ctx: Ctx) {
  const token = extractBearer(req);
  if (!token) return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  const key = await findByPlaintext(token);
  if (!key) return unauthorized("Invalid or revoked API key.");
  if (!hasScope(key, "webhooks:read")) return insufficientScope("webhooks:read", key.scopes);

  const blocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (blocked) return blocked;
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return keyBlocked;
  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, {
    route: "/v1/webhooks/[id]/deliveries",
  });
  if (lockdownBlocked) return lockdownBlocked;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return residencyBlocked;
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return policyBlocked;

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  if (!key.workspaceId) return tenantRequired();
  const { id } = await ctx.params;
  if (!id || !ID_RE.test(id)) {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Invalid webhook id." } },
      { status: 400, headers: rl.headers },
    );
  }

  // Tenant scope: loadWebhookForWorkspace returns null on cross-tenant
  // probes, which we surface as a flat 404.
  const rec = await loadWebhookForWorkspace(id, key.workspaceId);
  if (!rec) return notFound();

  const url = new URL(req.url);
  const limit = clampLimit(url.searchParams.get("limit"));

  const all = await listDeliveriesForWorkspace(id, key.workspaceId);
  // listDeliveriesForWorkspace returns newest-first; slice to limit.
  const items = all.slice(0, limit);

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/webhooks/[id]/deliveries",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId,
  });

  return NextResponse.json(
    {
      webhook_id: rec.id,
      total: all.length,
      limit,
      items,
    },
    { headers: rl.headers },
  );
}
