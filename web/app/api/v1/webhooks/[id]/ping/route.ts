/**
 * Programmatic webhook test-ping endpoint.
 *
 *   POST /v1/webhooks/:id/ping
 *
 * Fires a one-shot, fully-signed `webhook.ping` delivery against the
 * webhook's currently configured URL so a customer's CI / SOAR / SDK
 * test harness can prove HMAC verification and reachability without a
 * person clicking the dashboard "Send test" button. This is the
 * machine-to-machine companion to /api/webhooks/:id/ping.
 *
 * Auth:   Bearer API key (workspaceId is taken from the calling key,
 *         never a query parameter, so cross-tenant pings are impossible
 *         by construction).
 * Scope:  `webhooks:write` (same scope that already gates create,
 *         delete, rotate, and redeliver).
 *
 * Behavior matches the dashboard ping exactly:
 *   - Cross-tenant probes return a flat 404 with no audit noise.
 *   - Pinging a disabled webhook returns 409 `webhook_disabled` and
 *     writes a denied audit entry, so a compliance bot's failed ping
 *     is still discoverable in the audit log.
 *   - Every attempt (success or failure) increments the same success /
 *     failure counters as a live event and appends a real entry to the
 *     delivery log, so a passing ping is real proof of integration.
 *   - HTTP status mirrors the receiver: 200 if the receiver returned
 *     2xx, 502 otherwise, so a CI gate can simply check the status.
 *
 * The full workspace policy fence (lockdown, workspace + key IP
 * allowlists, residency, API key policy, rate limit) runs ahead of the
 * ping, identical to the sibling /v1/webhooks/:id/rotate route.
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
  pingWebhook,
  loadWebhookForWorkspace,
} from "../../../../../../lib/webhooks";
import { logUsage } from "../../../../../../lib/usage";
import { tryRecordAudit } from "../../../../../../lib/audit";

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

function invalidId(headers: Record<string, string>) {
  return NextResponse.json(
    { error: { type: "invalid_request", message: "Invalid webhook id." } },
    { status: 400, headers },
  );
}

export async function POST(req: Request, ctx: Ctx) {
  const token = extractBearer(req);
  if (!token) {
    return unauthorized(
      "Missing API key. Pass 'Authorization: Bearer <key>'.",
    );
  }
  const key = await findByPlaintext(token);
  if (!key) return unauthorized("Invalid or revoked API key.");
  if (!hasScope(key, "webhooks:write")) {
    return insufficientScope("webhooks:write", key.scopes);
  }
  const wsBlocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (wsBlocked) return wsBlocked;
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return keyBlocked;
  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, {
    route: "/v1/webhooks/[id]/ping",
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
  if (!id || !ID_RE.test(id)) return invalidId(rl.headers);

  // Workspace-scoped lookup. A webhook id that belongs to another
  // workspace must return a flat 404 with no audit noise: indistinguishable
  // from a genuinely missing id, so a cross-tenant prober gets no oracle.
  const existing = await loadWebhookForWorkspace(id, key.workspaceId);
  if (!existing) {
    return NextResponse.json(
      { error: { type: "not_found", message: "Webhook not found." } },
      { status: 404, headers: rl.headers },
    );
  }

  // A disabled webhook must not silently deliver. Surface a 409 so the
  // caller knows to resume the webhook first, and record the denial so
  // an unattended SOAR script's failed ping is still audit-evidence.
  if (existing.disabled) {
    void tryRecordAudit(req, {
      action: "v1.webhooks.ping",
      actorId: key.userId ?? null,
      workspaceId: key.workspaceId,
      target: { type: "webhook", id, label: existing.label },
      status: "denied",
      meta: { reason: "disabled", keyId: key.id },
    });
    return NextResponse.json(
      {
        error: {
          type: "webhook_disabled",
          message: "Resume the webhook before sending a test ping.",
        },
      },
      { status: 409, headers: rl.headers },
    );
  }

  let delivery;
  try {
    delivery = await pingWebhook(
      id,
      key.workspaceId,
      key.userId ? { id: key.userId, email: null } : null,
    );
  } catch (e) {
    return NextResponse.json(
      {
        error: {
          type: "internal",
          message: e instanceof Error ? e.message : "Ping failed.",
        },
      },
      { status: 500, headers: rl.headers },
    );
  }
  if (!delivery) {
    // Belt-and-suspenders: pingWebhook also enforces the workspace
    // scope and would return null on a cross-tenant id. Treat the
    // same as the pre-flight 404 above to keep the contract uniform.
    return NextResponse.json(
      { error: { type: "not_found", message: "Webhook not found." } },
      { status: 404, headers: rl.headers },
    );
  }

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "POST /v1/webhooks/[id]/ping",
    bytes: 0,
    latencyMs: delivery.durationMs ?? 0,
    workspaceId: key.workspaceId,
  });
  void tryRecordAudit(req, {
    action: "v1.webhooks.ping",
    actorId: key.userId ?? null,
    workspaceId: key.workspaceId,
    target: { type: "webhook", id, label: existing.label },
    status: delivery.ok ? "ok" : "error",
    meta: {
      keyId: key.id,
      deliveryId: delivery.id,
      httpStatus: delivery.status,
      attempts: delivery.attempts,
      durationMs: delivery.durationMs,
      error: delivery.error ?? null,
    },
  });

  return NextResponse.json(
    { delivery },
    { status: delivery.ok ? 200 : 502, headers: rl.headers },
  );
}
