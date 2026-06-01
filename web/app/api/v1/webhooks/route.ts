/**
 * Public /v1/webhooks endpoint.
 *
 * Authenticated via Bearer token (or x-api-key header). All operations
 * are tenant-scoped to the calling key's workspace so no key can list,
 * create, or attack webhook endpoints in another customer's tenant.
 *
 * GET /v1/webhooks
 *   Requires `webhooks:read`. Returns the workspace's webhook
 *   endpoints (summaries only, no signing secret).
 *
 * POST /v1/webhooks
 *   Requires `webhooks:write`. Provisions a new endpoint. Returns the
 *   plaintext signing secret EXACTLY ONCE; callers must persist it.
 *   Honours the workspace's webhook domain allowlist if configured.
 *   Supports `dry_run=true` (query or body) which runs every auth,
 *   policy, and validation check then returns a preview without
 *   touching disk, charging quota, or emitting an audit `create`.
 *   Dry-run probes are themselves audited as `*.dry_run` so security
 *   teams can attribute every attempt.
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  recordUse,
} from "../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../lib/rate-limit";
import { enforceWorkspaceAllowlistForKey, enforceKeyAllowlist } from "../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../lib/lockdown-enforce";
import {
  createWebhook,
  listWebhooksForWorkspace,
  validateUrl,
  SUPPORTED_EVENTS,
} from "../../../../lib/webhooks";
import { getWorkspace } from "../../../../lib/workspaces";
import { logUsage } from "../../../../lib/usage";
import { tryRecordAudit } from "../../../../lib/audit";
import { isDryRun, DRY_RUN_HEADER } from "../../../../lib/dry-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
        message: `This key is missing the '${required}' scope. Rotate it with the scope enabled or issue a new key.`,
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
        message:
          "This API key is not bound to a workspace. Webhook provisioning is only available to workspace-scoped keys.",
      },
    },
    { status: 403 },
  );
}

export async function GET(req: Request) {
  const token = extractBearer(req);
  if (!token) return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  const key = await findByPlaintext(token);
  if (!key) return unauthorized("Invalid or revoked API key.");
  if (!hasScope(key, "webhooks:read")) return insufficientScope("webhooks:read", key.scopes);

  const blocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (blocked) return blocked;
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return keyBlocked;
  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/webhooks" });
  if (lockdownBlocked) return lockdownBlocked;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return residencyBlocked;
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return policyBlocked;

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  if (!key.workspaceId) return tenantRequired();

  try {
    const items = await listWebhooksForWorkspace(key.workspaceId);
    void recordUse(key.id, clientIpFromRequest(req));
    void logUsage({
      ts: Date.now(),
      keyId: key.id,
      endpoint: "/v1/webhooks",
      bytes: 0,
      latencyMs: 0,
      workspaceId: key.workspaceId,
    });
    return NextResponse.json(
      {
        workspace_id: key.workspaceId,
        count: items.length,
        supported_events: SUPPORTED_EVENTS,
        items,
      },
      { headers: rl.headers },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: { type: "internal_error", message: msg } },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const token = extractBearer(req);
  if (!token) return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  const key = await findByPlaintext(token);
  if (!key) return unauthorized("Invalid or revoked API key.");
  if (!hasScope(key, "webhooks:write")) return insufficientScope("webhooks:write", key.scopes);

  const blocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (blocked) return blocked;
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return keyBlocked;
  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/webhooks" });
  if (lockdownBlocked) return lockdownBlocked;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return residencyBlocked;
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return policyBlocked;

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  if (!key.workspaceId) return tenantRequired();

  let body: unknown = null;
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("application/json")) {
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: { type: "invalid_request", message: "Body must be valid JSON." } },
        { status: 400, headers: rl.headers },
      );
    }
  }
  const b = (body ?? {}) as { label?: unknown; url?: unknown; events?: unknown };

  // Server-side input validation. validateUrl + createWebhook do the
  // heavy lifting, but we mirror the URL check here so callers get a
  // structured error instead of a stringly-typed throw.
  const urlCheck = validateUrl(b.url);
  if (!urlCheck.ok) {
    return NextResponse.json(
      { error: { type: "invalid_request", message: urlCheck.error, field: "url" } },
      { status: 400, headers: rl.headers },
    );
  }

  const dryRun = isDryRun(req, body);
  const ws = await getWorkspace(key.workspaceId);
  const domainAllowlist = ws?.webhookDomainAllowlist ?? [];

  if (dryRun) {
    void tryRecordAudit(req, {
      action: "v1.webhooks.create.dry_run",
      actorId: key.userId ?? null,
      workspaceId: key.workspaceId,
      target: { type: "webhook", id: "(preview)", label: typeof b.label === "string" ? b.label : undefined },
      meta: { url: urlCheck.url },
    });
    return NextResponse.json(
      {
        dry_run: true,
        would: { create_webhook: true, return_secret_once: true, record_usage: true },
        preview: {
          workspace_id: key.workspaceId,
          url: urlCheck.url,
          events: Array.isArray(b.events) ? b.events : undefined,
          label: typeof b.label === "string" ? b.label : undefined,
          domain_allowlist_active: domainAllowlist.length > 0,
        },
      },
      { headers: { ...rl.headers, ...DRY_RUN_HEADER } },
    );
  }

  try {
    const created = await createWebhook({
      label: b.label,
      url: b.url,
      events: b.events,
      workspaceId: key.workspaceId,
      domainAllowlist,
    });
    void recordUse(key.id, clientIpFromRequest(req));
    void logUsage({
      ts: Date.now(),
      keyId: key.id,
      endpoint: "POST /v1/webhooks",
      bytes: 0,
      latencyMs: 0,
      workspaceId: key.workspaceId,
    });
    void tryRecordAudit(req, {
      action: "v1.webhooks.create",
      actorId: key.userId ?? null,
      workspaceId: key.workspaceId,
      target: { type: "webhook", id: created.record.id, label: created.record.label },
      diff: { after: { url: created.record.url, events: created.record.events } },
    });
    return NextResponse.json(
      {
        webhook: created.record,
        secret: created.secret,
        secret_notice:
          "Store this signing secret now. It will never be shown again. Use it to verify the X-CodeClone-Signature header on every delivery.",
      },
      { status: 201, headers: rl.headers },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: { type: "invalid_request", message: msg } },
      { status: 400, headers: rl.headers },
    );
  }
}
