/**
 * Public /v1/keys/[id]: programmatic single-key inspect, rotate, revoke.
 *
 * Pairs with GET /v1/keys (see ../route.ts) to give security teams a
 * machine-driven path for SOC2 CC6.1 / CC6.3 key rotation evidence.
 *
 *   GET    /v1/keys/:id              -> inspect a key in this workspace
 *                                       (requires keys:read).
 *   POST   /v1/keys/:id/rotate       -> mint a new secret, return the
 *                                       plaintext exactly once. Useful
 *                                       for 90-day rotation bots
 *                                       (requires keys:write).
 *   DELETE /v1/keys/:id              -> mark key revoked (idempotent)
 *                                       (requires keys:write).
 *
 * Self-protection: a caller is not allowed to rotate or revoke the
 * key they are currently authenticating with. Doing so would either
 * brick the caller mid-flight (rotate: caller is now holding a stale
 * secret) or lock the workspace out (revoke: a bot revoking its only
 * key removes its own way back in). Use a separate admin key.
 *
 * Tenant scope: every load goes through `loadKeyForWorkspace` so a
 * key minted in workspace A cannot inspect, rotate, or revoke a key
 * in workspace B. Cross-tenant lookups return 404 (not 403) so the
 * existence of other tenants' key ids cannot be probed.
 *
 * Still enforced: rate limit, workspace IP allowlist, per-key IP
 * allowlist, lockdown, residency, workspace API key policy.
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  loadKeyForWorkspace,
  recordUse,
  revokeKeyForWorkspace,
  rotateKeyForWorkspace,
  summarize,
  updateKeyForWorkspace,
} from "../../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../../lib/rate-limit";
import {
  enforceWorkspaceAllowlistForKey,
  enforceKeyAllowlist,
} from "../../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../../lib/lockdown-enforce";
import { tryRecordAudit } from "../../../../../lib/audit";
import { logUsage } from "../../../../../lib/usage";
import { isDryRun, DRY_RUN_HEADER } from "../../../../../lib/dry-run";

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
        message:
          "This API key is not bound to a workspace. Programmatic key management is only available to workspace-scoped keys.",
      },
    },
    { status: 403 },
  );
}

function notFound() {
  // 404, not 403, so callers cannot probe for the existence of another
  // tenant's key id by watching status codes.
  return NextResponse.json(
    { error: { type: "not_found", message: "Key not found in this workspace." } },
    { status: 404 },
  );
}

function selfTarget() {
  return NextResponse.json(
    {
      error: {
        type: "invalid_request",
        message:
          "A key cannot rotate or revoke itself. Use a separate admin key, otherwise this call would brick the caller mid-flight.",
      },
    },
    { status: 400 },
  );
}

type Ctx = { params: Promise<{ id: string }> | { id: string } };

async function resolveParams(ctx: Ctx): Promise<{ id: string }> {
  const p = (ctx as { params: { id: string } | Promise<{ id: string }> }).params;
  return p instanceof Promise ? await p : p;
}

async function commonGate(req: Request) {
  const token = extractBearer(req);
  if (!token) return { error: unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.") };
  const key = await findByPlaintext(token);
  if (!key) return { error: unauthorized("Invalid or revoked API key.") };

  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/keys/[id]" });
  if (lockdownBlocked) return { error: lockdownBlocked };
  const wsBlocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (wsBlocked) return { error: wsBlocked };
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return { error: keyBlocked };
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return { error: residencyBlocked };
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return { error: policyBlocked };

  const rl = await enforceRateLimit(key);
  if (rl.response) return { error: rl.response };

  if (!key.workspaceId) return { error: tenantRequired() };
  return { key, rl };
}

export async function GET(req: Request, ctx: Ctx) {
  const gate = await commonGate(req);
  if ("error" in gate) return gate.error;
  const { key, rl } = gate;
  if (!hasScope(key, "keys:read")) return insufficientScope("keys:read", key.scopes);

  const { id } = await resolveParams(ctx);
  const rec = await loadKeyForWorkspace(id, key.workspaceId!);
  if (!rec) return notFound();

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/keys/:id",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId,
  });
  void tryRecordAudit(req, {
    action: "v1.keys.inspect",
    actorId: key.id,
    workspaceId: key.workspaceId,
    target: { type: "api_key", id: rec.id, label: rec.label },
    status: "ok",
  });
  return NextResponse.json(summarize(rec), { headers: rl.headers });
}

// POST handles two cases: ?action=rotate (or {action: "rotate"} body)
// and the canonical /v1/keys/:id/rotate subpath. Both surface the same
// rotation primitive; the subpath is the documented form.
export async function POST(req: Request, ctx: Ctx) {
  const gate = await commonGate(req);
  if ("error" in gate) return gate.error;
  const { key, rl } = gate;
  if (!hasScope(key, "keys:write")) return insufficientScope("keys:write", key.scopes);

  const { id } = await resolveParams(ctx);
  if (id === key.id) return selfTarget();

  const target = await loadKeyForWorkspace(id, key.workspaceId!);
  if (!target) return notFound();

  const rotated = await rotateKeyForWorkspace(id, key.workspaceId!);
  if (!rotated) {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message: "Key cannot be rotated (revoked or expired).",
        },
      },
      { status: 400, headers: rl.headers },
    );
  }

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "POST /v1/keys/:id/rotate",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId,
  });
  void tryRecordAudit(req, {
    action: "v1.keys.rotate",
    actorId: key.id,
    workspaceId: key.workspaceId,
    target: { type: "api_key", id: rotated.record.id, label: rotated.record.label },
    diff: {
      before: { prefix: target.prefix },
      after: { prefix: rotated.record.prefix },
    },
  });
  return NextResponse.json(
    {
      key: rotated.record,
      secret: rotated.plaintext,
      secret_notice:
        "Store this secret now. It will never be shown again. The old secret stops working immediately.",
    },
    { headers: rl.headers },
  );
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await commonGate(req);
  if ("error" in gate) return gate.error;
  const { key, rl } = gate;
  if (!hasScope(key, "keys:write")) return insufficientScope("keys:write", key.scopes);

  const { id } = await resolveParams(ctx);
  if (id === key.id) return selfTarget();

  const target = await loadKeyForWorkspace(id, key.workspaceId!);
  if (!target) return notFound();

  const ok = await revokeKeyForWorkspace(id, key.workspaceId!);
  if (!ok) return notFound();

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "DELETE /v1/keys/:id",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId,
  });
  void tryRecordAudit(req, {
    action: "v1.keys.revoke",
    actorId: key.id,
    workspaceId: key.workspaceId,
    target: { type: "api_key", id: target.id, label: target.label },
    diff: {
      before: { revoked: Boolean(target.revoked) },
      after: { revoked: true },
    },
  });
  return NextResponse.json(
    { id: target.id, revoked: true },
    { headers: rl.headers },
  );
}

/**
 * PATCH /v1/keys/[id] — edit a key in place.
 *
 * Security teams asked for this so they can narrow scopes on an
 * existing key, drop the per-key rate-limit ceiling, tighten the
 * per-key IP allowlist, extend (or shorten) the expiry deadline,
 * or rename a key without rotating the secret and breaking every
 * running pipeline. The secret never changes here; rotation is a
 * separate flow at POST /v1/keys/:id/rotate.
 *
 * Scope: `keys:write`. Tenant-scoped to the calling key's workspace
 * via `updateKeyForWorkspace`. Rate-limit, lockdown, IP allowlist,
 * residency, and API-key policy gates all still apply. Every mutation
 * (and every dry-run preview) is audited with a before/after diff for
 * SOC2 CC6.1 / ISO 27001 A.9.2 access-change evidence.
 *
 * Self-protection: a caller cannot PATCH the key it is currently
 * authenticating with. Narrowing your own scopes mid-flight is the
 * fastest way to brick yourself out of the API; use a separate admin
 * key. (Same rule as rotate/revoke.)
 *
 * Narrowing-only on scopes: a PATCH cannot grant a scope the key does
 * not already hold. Widening requires rotating or recreating the key.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await commonGate(req);
  if ("error" in gate) return gate.error;
  const { key, rl } = gate;
  if (!hasScope(key, "keys:write")) return insufficientScope("keys:write", key.scopes);

  const { id } = await resolveParams(ctx);
  if (id === key.id) return selfTarget();

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
  const b = (body ?? {}) as {
    label?: unknown;
    scopes?: unknown;
    rpm?: unknown;
    ipAllowlist?: unknown;
    expiresAt?: unknown;
  };
  const hasAny =
    b.label !== undefined ||
    b.scopes !== undefined ||
    b.rpm !== undefined ||
    b.ipAllowlist !== undefined ||
    b.expiresAt !== undefined;
  if (!hasAny) {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message:
            "Body must contain at least one of: label, scopes, rpm, ipAllowlist, expiresAt.",
        },
      },
      { status: 400, headers: rl.headers },
    );
  }

  const target = await loadKeyForWorkspace(id, key.workspaceId!);
  if (!target) return notFound();

  const dryRun = isDryRun(req, body);
  if (dryRun) {
    void tryRecordAudit(req, {
      action: "v1.keys.update.dry_run",
      actorId: key.id,
      workspaceId: key.workspaceId,
      target: { type: "api_key", id: target.id, label: target.label },
      meta: {
        proposed: {
          label: typeof b.label === "string" ? b.label : undefined,
          scopes: Array.isArray(b.scopes) ? b.scopes : undefined,
          rpm: b.rpm === null ? null : typeof b.rpm === "number" ? b.rpm : undefined,
          ipAllowlist: Array.isArray(b.ipAllowlist)
            ? b.ipAllowlist
            : b.ipAllowlist === null
              ? null
              : undefined,
          expiresAt:
            b.expiresAt === null
              ? null
              : typeof b.expiresAt === "number"
                ? b.expiresAt
                : undefined,
        },
      },
    });
    return NextResponse.json(
      {
        dry_run: true,
        would: { update_key: true, rotate_secret: false, record_usage: true },
        key: summarize(target),
      },
      { headers: { ...rl.headers, ...DRY_RUN_HEADER } },
    );
  }

  let result;
  try {
    result = await updateKeyForWorkspace(id, key.workspaceId!, {
      label: b.label,
      scopes: b.scopes,
      rpm: b.rpm,
      ipAllowlist: b.ipAllowlist,
      expiresAt: b.expiresAt,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: { type: "invalid_request", message: msg } },
      { status: 400, headers: rl.headers },
    );
  }
  if (!result) return notFound();

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "PATCH /v1/keys/:id",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId,
  });
  void tryRecordAudit(req, {
    action: "v1.keys.update",
    actorId: key.id,
    workspaceId: key.workspaceId,
    target: { type: "api_key", id: result.summary.id, label: result.summary.label },
    diff: result.diff,
    meta: {
      changed: result.changed,
      rejected_cidrs: result.rejectedCidrs.length > 0 ? result.rejectedCidrs : undefined,
    },
  });

  return NextResponse.json(
    {
      key: result.summary,
      changed: result.changed,
      rejected_cidrs: result.rejectedCidrs,
    },
    { headers: rl.headers },
  );
}
