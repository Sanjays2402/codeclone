/**
 * Programmatic webhook signing-secret rotation.
 *
 *   POST   /v1/webhooks/:id/rotate    initiate rotation (returns new secret ONCE)
 *     body: { graceMs?: number }      grace window during which BOTH the old
 *                                     and new secrets sign outgoing deliveries
 *   PUT    /v1/webhooks/:id/rotate    finalize (promote pending to primary)
 *   DELETE /v1/webhooks/:id/rotate    cancel a pending rotation
 *
 * SOC2 CC6.1 requires evidence that shared secrets are rotated on a
 * defined cadence. The dashboard route at /api/webhooks/:id/rotate covers
 * the human path; this is the SOAR/IGA path so a compliance bot can
 * rotate every workspace webhook ahead of expiry without a person.
 *
 * Auth:  Bearer API key (workspaceId is taken from the calling key,
 *        never from a query parameter, so cross-tenant rotation is
 *        impossible by construction).
 * Scope: `webhooks:write` (same scope that already gates create + delete).
 *
 * The plaintext secret is returned exactly once on POST and is never
 * persisted on the server in clear form; only a sha256 hash is kept,
 * mirroring how the create endpoint behaves. Every call (initiate /
 * finalize / cancel, including no-op cancels of a webhook that has
 * nothing pending) is recorded in the audit log with actor, target,
 * and a before/after diff of the secret prefixes so security review can
 * reconstruct the full rotation timeline.
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
  rotateSecret,
  finalizeRotation,
  cancelRotation,
  loadWebhookForWorkspace,
  summarize,
  ROTATION_MIN_MS,
  ROTATION_MAX_MS,
  ROTATION_DEFAULT_MS,
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

/**
 * Shared auth, scope, policy, residency, lockdown, allowlist, and rate-limit
 * gate. Returns the matched key + rate-limit headers on success, or an early
 * response that the caller should return verbatim.
 */
async function gate(req: Request) {
  const token = extractBearer(req);
  if (!token) {
    return {
      response: unauthorized(
        "Missing API key. Pass 'Authorization: Bearer <key>'.",
      ),
    } as const;
  }
  const key = await findByPlaintext(token);
  if (!key) return { response: unauthorized("Invalid or revoked API key.") } as const;
  if (!hasScope(key, "webhooks:write")) {
    return { response: insufficientScope("webhooks:write", key.scopes) } as const;
  }
  const wsBlocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (wsBlocked) return { response: wsBlocked } as const;
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return { response: keyBlocked } as const;
  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, {
    route: "/v1/webhooks/[id]/rotate",
  });
  if (lockdownBlocked) return { response: lockdownBlocked } as const;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return { response: residencyBlocked } as const;
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return { response: policyBlocked } as const;
  const rl = await enforceRateLimit(key);
  if (rl.response) return { response: rl.response } as const;
  if (!key.workspaceId) return { response: tenantRequired() } as const;
  return { key, rlHeaders: rl.headers } as const;
}

export async function POST(req: Request, ctx: Ctx) {
  const g = await gate(req);
  if ("response" in g) return g.response;
  const { key, rlHeaders } = g;
  const { id } = await ctx.params;
  if (!id || !ID_RE.test(id)) return invalidId(rlHeaders);

  // Parse and validate the optional grace window before we touch the
  // store, so a malformed request never produces a half-rotated state.
  let body: { graceMs?: unknown } = {};
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("application/json")) {
    try {
      const txt = await req.text();
      if (txt.trim().length > 0) body = JSON.parse(txt) as { graceMs?: unknown };
    } catch {
      return NextResponse.json(
        {
          error: {
            type: "invalid_body",
            message: "Body must be valid JSON when content-type is application/json.",
          },
        },
        { status: 400, headers: rlHeaders },
      );
    }
  }
  let graceMs = ROTATION_DEFAULT_MS;
  if (body.graceMs !== undefined) {
    if (typeof body.graceMs !== "number" || !Number.isFinite(body.graceMs)) {
      return NextResponse.json(
        {
          error: {
            type: "invalid_grace",
            message: "graceMs must be a number of milliseconds.",
          },
        },
        { status: 400, headers: rlHeaders },
      );
    }
    if (body.graceMs < ROTATION_MIN_MS || body.graceMs > ROTATION_MAX_MS) {
      return NextResponse.json(
        {
          error: {
            type: "invalid_grace",
            message: `graceMs must be between ${ROTATION_MIN_MS} and ${ROTATION_MAX_MS} (inclusive).`,
          },
        },
        { status: 400, headers: rlHeaders },
      );
    }
    graceMs = body.graceMs;
  }

  // Confirm the webhook is in the calling workspace before rotateSecret
  // touches it. rotateSecret enforces the same scope, but doing it
  // up-front keeps cross-tenant probes indistinguishable from genuine
  // missing ids (flat 404, no oracle).
  const existing = await loadWebhookForWorkspace(id, key.workspaceId!);
  if (!existing) return notFound();

  const result = await rotateSecret(id, key.workspaceId!, graceMs);
  if (!result) return notFound();

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "POST /v1/webhooks/[id]/rotate",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId!,
  });
  void tryRecordAudit(req, {
    action: "v1.webhooks.secret.rotate_initiate",
    actorId: key.userId ?? null,
    workspaceId: key.workspaceId!,
    target: { type: "webhook", id, label: existing.label },
    diff: {
      before: { secretPrefix: existing.secretPrefix },
      after: {
        secretPrefix: existing.secretPrefix,
        pendingSecretPrefix: result.record.pendingSecretPrefix,
        pendingExpiresAt: result.expiresAt,
      },
    },
  });

  return NextResponse.json(
    { record: result.record, secret: result.secret, expiresAt: result.expiresAt },
    { status: 201, headers: rlHeaders },
  );
}

export async function PUT(req: Request, ctx: Ctx) {
  const g = await gate(req);
  if ("response" in g) return g.response;
  const { key, rlHeaders } = g;
  const { id } = await ctx.params;
  if (!id || !ID_RE.test(id)) return invalidId(rlHeaders);

  const before = await loadWebhookForWorkspace(id, key.workspaceId!);
  if (!before) return notFound();
  if (!before.pendingSecretPrefix) {
    return NextResponse.json(
      {
        error: {
          type: "no_pending_rotation",
          message: "No rotation is in progress for this webhook.",
        },
      },
      { status: 409, headers: rlHeaders },
    );
  }
  const finalized = await finalizeRotation(id, key.workspaceId!);
  if (!finalized) {
    return NextResponse.json(
      {
        error: {
          type: "no_pending_rotation",
          message: "No rotation is in progress for this webhook.",
        },
      },
      { status: 409, headers: rlHeaders },
    );
  }

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "PUT /v1/webhooks/[id]/rotate",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId!,
  });
  void tryRecordAudit(req, {
    action: "v1.webhooks.secret.rotate_finalize",
    actorId: key.userId ?? null,
    workspaceId: key.workspaceId!,
    target: { type: "webhook", id, label: before.label },
    diff: {
      before: {
        secretPrefix: before.secretPrefix,
        pendingSecretPrefix: before.pendingSecretPrefix,
      },
      after: { secretPrefix: finalized.secretPrefix },
    },
  });
  return NextResponse.json(finalized, { headers: rlHeaders });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const g = await gate(req);
  if ("response" in g) return g.response;
  const { key, rlHeaders } = g;
  const { id } = await ctx.params;
  if (!id || !ID_RE.test(id)) return invalidId(rlHeaders);

  const before = await loadWebhookForWorkspace(id, key.workspaceId!);
  if (!before) return notFound();
  const after = await cancelRotation(id, key.workspaceId!);
  if (!after) return notFound();

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "DELETE /v1/webhooks/[id]/rotate",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId!,
  });
  if (before.pendingSecretPrefix) {
    void tryRecordAudit(req, {
      action: "v1.webhooks.secret.rotate_cancel",
      actorId: key.userId ?? null,
      workspaceId: key.workspaceId!,
      target: { type: "webhook", id, label: before.label },
      diff: {
        before: {
          pendingSecretPrefix: before.pendingSecretPrefix,
          pendingExpiresAt: before.pendingExpiresAt,
        },
        after: { pendingSecretPrefix: null },
      },
    });
  }
  // Use the freshly-loaded summary so the response reflects the post-cancel
  // state (no pending fields), matching the dashboard semantics.
  return NextResponse.json(after, { headers: rlHeaders });
}
