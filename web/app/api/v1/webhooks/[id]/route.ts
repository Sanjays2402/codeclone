/**
 * Public /v1/webhooks/[id] endpoint.
 *
 * Authenticated via Bearer token. All ops are tenant-scoped to the
 * calling key's workspace via `loadWebhookForWorkspace` and the
 * workspace-aware `deleteWebhook`. A caller from workspace A asking for
 * a webhook id owned by workspace B receives a flat 404, not a 403,
 * so workspace boundaries cannot be probed for existence.
 *
 * GET    — requires `webhooks:read`. Returns the summary.
 * DELETE — requires `webhooks:write`. Hard-deletes. Supports dry-run.
 *          Every call (live or dry-run) is audited.
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  recordUse,
} from "../../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../../lib/rate-limit";
import { enforceWorkspaceAllowlistForKey, enforceKeyAllowlist } from "../../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../../lib/lockdown-enforce";
import {
  loadWebhookForWorkspace,
  deleteWebhook,
  summarize,
} from "../../../../../lib/webhooks";
import { logUsage } from "../../../../../lib/usage";
import { tryRecordAudit } from "../../../../../lib/audit";
import { isDryRun, DRY_RUN_HEADER } from "../../../../../lib/dry-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

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

const ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

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
  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/webhooks/[id]" });
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

  const rec = await loadWebhookForWorkspace(id, key.workspaceId);
  if (!rec) return notFound();

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/webhooks/[id]",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId,
  });

  return NextResponse.json(summarize(rec), { headers: rl.headers });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const token = extractBearer(req);
  if (!token) return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  const key = await findByPlaintext(token);
  if (!key) return unauthorized("Invalid or revoked API key.");
  if (!hasScope(key, "webhooks:write")) return insufficientScope("webhooks:write", key.scopes);

  const blocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (blocked) return blocked;
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return keyBlocked;
  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/webhooks/[id]" });
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

  const rec = await loadWebhookForWorkspace(id, key.workspaceId);
  if (!rec) return notFound();

  if (dryRun) {
    void tryRecordAudit(req, {
      action: "v1.webhooks.delete.dry_run",
      actorId: key.userId ?? null,
      workspaceId: key.workspaceId,
      target: { type: "webhook", id: rec.id, label: rec.label },
      meta: { url: rec.url, events: rec.events },
    });
    return NextResponse.json(
      {
        dry_run: true,
        would: { delete_webhook: true, charge_quota: true, record_usage: true },
        webhook: summarize(rec),
      },
      { headers: { ...rl.headers, ...DRY_RUN_HEADER } },
    );
  }

  const ok = await deleteWebhook(id, key.workspaceId);
  if (!ok) return notFound();

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "DELETE /v1/webhooks/[id]",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId,
  });
  void tryRecordAudit(req, {
    action: "v1.webhooks.delete",
    actorId: key.userId ?? null,
    workspaceId: key.workspaceId,
    target: { type: "webhook", id: rec.id, label: rec.label },
    meta: { url: rec.url, events: rec.events },
  });

  return NextResponse.json({ deleted: true, id: rec.id }, { headers: rl.headers });
}
