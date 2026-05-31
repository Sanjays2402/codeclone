/**
 * Webhook signing-secret rotation.
 *
 *   POST   /api/webhooks/:id/rotate?workspaceId=...    initiate (admin+)
 *     body: { graceMs?: number }
 *     returns: { record, secret (shown ONCE), expiresAt }
 *
 *   PUT    /api/webhooks/:id/rotate?workspaceId=...    finalize (promote pending -> primary)
 *
 *   DELETE /api/webhooks/:id/rotate?workspaceId=...    cancel pending
 *
 * All three are workspace-scoped, RBAC-guarded (viewers denied), and
 * write an immutable audit entry. The new plaintext is returned to the
 * caller exactly once on initiate, matching create-time semantics.
 */
import { NextResponse } from "next/server";
import {
  rotateSecret,
  finalizeRotation,
  cancelRotation,
  loadWebhookForWorkspace,
  summarize,
  validateWorkspaceId,
  ROTATION_MIN_MS,
  ROTATION_MAX_MS,
  ROTATION_DEFAULT_MS,
} from "../../../../../lib/webhooks";
import { tryRecordAudit } from "../../../../../lib/audit";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { getWorkspace, getActiveMember } from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

async function resolve(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return {
      error: NextResponse.json(
        { error: { type: "unauthorized", message: "Sign in to rotate webhook secrets." } },
        { status: 401 },
      ),
    };
  }
  const url = new URL(req.url);
  const wsId = validateWorkspaceId(url.searchParams.get("workspaceId"));
  if (!wsId) {
    return {
      error: NextResponse.json(
        { error: { type: "invalid_workspace", message: "A valid workspaceId query parameter is required." } },
        { status: 400 },
      ),
    };
  }
  const ws = await getWorkspace(wsId);
  if (!ws) {
    return {
      error: NextResponse.json({ error: { type: "not_found", message: "Workspace not found." } }, { status: 404 }),
    };
  }
  const member = getActiveMember(ws, user.id);
  if (!member) {
    return {
      error: NextResponse.json(
        { error: { type: "forbidden", message: "You are not a member of that workspace." } },
        { status: 403 },
      ),
    };
  }
  // Rotation is a credential operation: viewers never get it.
  if (member.role === "viewer") {
    return {
      error: NextResponse.json(
        { error: { type: "forbidden", message: "Viewers cannot rotate webhook secrets." } },
        { status: 403 },
      ),
    };
  }
  return { user, ws, member } as const;
}

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const r = await resolve(req);
  if ("error" in r) return r.error;

  // Confirm the webhook actually belongs to this workspace before we
  // touch the secret. rotateSecret enforces the same check, but doing
  // it up-front lets us return a clean 404 with no side effects.
  const existing = await loadWebhookForWorkspace(id, r.ws.id);
  if (!existing) {
    return NextResponse.json(
      { error: { type: "not_found", message: "Webhook not found." } },
      { status: 404 },
    );
  }

  let body: { graceMs?: unknown } = {};
  try {
    const txt = await req.text();
    if (txt.trim().length > 0) body = JSON.parse(txt) as { graceMs?: unknown };
  } catch {
    return NextResponse.json(
      { error: { type: "invalid_body", message: "Body must be JSON when present." } },
      { status: 400 },
    );
  }
  let graceMs = ROTATION_DEFAULT_MS;
  if (body.graceMs !== undefined) {
    if (typeof body.graceMs !== "number" || !Number.isFinite(body.graceMs)) {
      return NextResponse.json(
        { error: { type: "invalid_grace", message: "graceMs must be a number of milliseconds." } },
        { status: 400 },
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
        { status: 400 },
      );
    }
    graceMs = body.graceMs;
  }

  const result = await rotateSecret(id, r.ws.id, graceMs);
  if (!result) {
    return NextResponse.json(
      { error: { type: "not_found", message: "Webhook not found." } },
      { status: 404 },
    );
  }
  await tryRecordAudit(req, {
    action: "webhook.secret.rotate_initiate",
    actorId: r.user.id,
    actorEmail: r.user.email,
    workspaceId: r.ws.id,
    target: { type: "webhook", id },
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
    { status: 201 },
  );
}

export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const r = await resolve(req);
  if ("error" in r) return r.error;
  const before = await loadWebhookForWorkspace(id, r.ws.id);
  if (!before) {
    return NextResponse.json(
      { error: { type: "not_found", message: "Webhook not found." } },
      { status: 404 },
    );
  }
  if (!before.pendingSecretPrefix) {
    return NextResponse.json(
      { error: { type: "no_pending_rotation", message: "No rotation is in progress for this webhook." } },
      { status: 409 },
    );
  }
  const finalized = await finalizeRotation(id, r.ws.id);
  if (!finalized) {
    return NextResponse.json(
      { error: { type: "no_pending_rotation", message: "No rotation is in progress for this webhook." } },
      { status: 409 },
    );
  }
  await tryRecordAudit(req, {
    action: "webhook.secret.rotate_finalize",
    actorId: r.user.id,
    actorEmail: r.user.email,
    workspaceId: r.ws.id,
    target: { type: "webhook", id },
    diff: {
      before: { secretPrefix: before.secretPrefix, pendingSecretPrefix: before.pendingSecretPrefix },
      after: { secretPrefix: finalized.secretPrefix },
    },
  });
  return NextResponse.json(finalized);
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const r = await resolve(req);
  if ("error" in r) return r.error;
  const before = await loadWebhookForWorkspace(id, r.ws.id);
  if (!before) {
    return NextResponse.json(
      { error: { type: "not_found", message: "Webhook not found." } },
      { status: 404 },
    );
  }
  const after = await cancelRotation(id, r.ws.id);
  if (!after) {
    return NextResponse.json(
      { error: { type: "not_found", message: "Webhook not found." } },
      { status: 404 },
    );
  }
  if (before.pendingSecretPrefix) {
    await tryRecordAudit(req, {
      action: "webhook.secret.rotate_cancel",
      actorId: r.user.id,
      actorEmail: r.user.email,
      workspaceId: r.ws.id,
      target: { type: "webhook", id },
      diff: {
        before: { pendingSecretPrefix: before.pendingSecretPrefix, pendingExpiresAt: before.pendingExpiresAt },
        after: { pendingSecretPrefix: null },
      },
    });
  }
  return NextResponse.json(after);
}
