/**
 * Public /v1/webhooks/[id]/deliveries/[deliveryId]/redeliver endpoint.
 *
 * Authenticated via Bearer token. Tenant-scoped: a caller from
 * workspace A asking to redeliver a delivery owned by workspace B
 * receives a flat 404, not a 403. Requires `webhooks:write`.
 *
 * POST — Re-fires the recorded request body against the webhook's
 *        current URL with a fresh signature. Supports `?dry_run=true`
 *        which previews the action without making a network call.
 *        Every call (live or dry-run) is audited.
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
} from "../../../../../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../../../../../lib/rate-limit";
import {
  enforceWorkspaceAllowlistForKey,
  enforceKeyAllowlist,
} from "../../../../../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../../../../../lib/lockdown-enforce";
import {
  loadWebhookForWorkspace,
  listDeliveriesForWorkspace,
  redeliverDelivery,
} from "../../../../../../../../lib/webhooks";
import { logUsage } from "../../../../../../../../lib/usage";
import { tryRecordAudit } from "../../../../../../../../lib/audit";
import { isDryRun, DRY_RUN_HEADER } from "../../../../../../../../lib/dry-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; deliveryId: string }>;
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
    { error: { type: "not_found", message: "Webhook or delivery not found." } },
    { status: 404 },
  );
}

export async function POST(req: Request, ctx: Ctx) {
  const token = extractBearer(req);
  if (!token) return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  const key = await findByPlaintext(token);
  if (!key) return unauthorized("Invalid or revoked API key.");
  if (!hasScope(key, "webhooks:write")) return insufficientScope("webhooks:write", key.scopes);

  const blocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (blocked) return blocked;
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return keyBlocked;
  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, {
    route: "/v1/webhooks/[id]/deliveries/[deliveryId]/redeliver",
  });
  if (lockdownBlocked) return lockdownBlocked;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return residencyBlocked;
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return policyBlocked;

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  if (!key.workspaceId) return tenantRequired();
  const { id, deliveryId } = await ctx.params;
  if (!id || !ID_RE.test(id) || !deliveryId || !ID_RE.test(deliveryId)) {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Invalid webhook or delivery id." } },
      { status: 400, headers: rl.headers },
    );
  }

  // Tenant scope: loadWebhookForWorkspace returns null on cross-tenant
  // probes, which we surface as a flat 404.
  const rec = await loadWebhookForWorkspace(id, key.workspaceId);
  if (!rec) return notFound();

  const all = await listDeliveriesForWorkspace(id, key.workspaceId);
  const original = all.find((d) => d.id === deliveryId);
  if (!original) return notFound();

  let body: unknown = null;
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("application/json")) {
    try {
      body = await req.json();
    } catch {
      body = null;
    }
  }
  const dryRun = isDryRun(req, body);

  if (dryRun) {
    void tryRecordAudit(req, {
      action: "v1.webhooks.redeliver.dry_run",
      actorId: key.userId ?? null,
      workspaceId: key.workspaceId,
      target: { type: "webhook_delivery", id: deliveryId, label: id },
      meta: { event: original.event, url: rec.url },
    });
    return NextResponse.json(
      {
        dry_run: true,
        would: { redeliver: true, charge_quota: true, record_usage: true },
        webhook_id: rec.id,
        delivery_id: original.id,
        event: original.event,
        target_url: rec.url,
      },
      { headers: { ...rl.headers, ...DRY_RUN_HEADER } },
    );
  }

  const delivery = await redeliverDelivery(id, deliveryId, key.workspaceId);
  if (!delivery) return notFound();

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "POST /v1/webhooks/[id]/deliveries/[deliveryId]/redeliver",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId,
  });
  void tryRecordAudit(req, {
    action: "v1.webhooks.redeliver",
    actorId: key.userId ?? null,
    workspaceId: key.workspaceId,
    target: { type: "webhook_delivery", id: deliveryId, label: id },
    meta: {
      event: delivery.event,
      status: delivery.status,
      ok: delivery.ok,
      url: rec.url,
    },
  });

  return NextResponse.json({ delivery }, { headers: rl.headers });
}
