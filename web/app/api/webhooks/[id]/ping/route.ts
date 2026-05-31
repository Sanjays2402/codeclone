/**
 * POST /api/webhooks/:id/ping?workspaceId=...
 *
 * Send a one-shot, fully-signed `webhook.ping` delivery to a single
 * webhook so customers can validate HMAC verification and reachability
 * before flipping the webhook live. Owner/editor only; viewers get 403.
 * Cross-tenant access (a webhook id that belongs to another workspace)
 * returns 404 with no side effects.
 *
 * Every attempt (success or failure) writes an audit entry and updates
 * the webhook's success/failure counters exactly like a live dispatch,
 * so a passing ping is real proof of integration.
 */
import { NextResponse } from "next/server";
import {
  pingWebhook,
  loadWebhookForWorkspace,
  validateWorkspaceId,
} from "../../../../../lib/webhooks";
import { tryRecordAudit } from "../../../../../lib/audit";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { getWorkspace, getActiveMember } from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json(
      { error: { type: "unauthorized", message: "Sign in to send a test ping." } },
      { status: 401 },
    );
  }
  const url = new URL(req.url);
  const wsId = validateWorkspaceId(url.searchParams.get("workspaceId"));
  if (!wsId) {
    return NextResponse.json(
      { error: { type: "invalid_workspace", message: "A valid workspaceId query parameter is required." } },
      { status: 400 },
    );
  }
  const ws = await getWorkspace(wsId);
  if (!ws) {
    return NextResponse.json(
      { error: { type: "not_found", message: "Workspace not found." } },
      { status: 404 },
    );
  }
  const member = getActiveMember(ws, user.id);
  if (!member) {
    await tryRecordAudit(req, {
      action: "webhook.ping",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: wsId,
      target: { type: "webhook", id },
      status: "denied",
      meta: { reason: "not_member" },
    });
    return NextResponse.json(
      { error: { type: "forbidden", message: "You are not a member of that workspace." } },
      { status: 403 },
    );
  }
  if (member.role === "viewer") {
    await tryRecordAudit(req, {
      action: "webhook.ping",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: wsId,
      target: { type: "webhook", id },
      status: "denied",
      meta: { reason: "viewer" },
    });
    return NextResponse.json(
      { error: { type: "forbidden", message: "Viewers cannot send webhook test pings." } },
      { status: 403 },
    );
  }

  // Confirm the webhook actually belongs to this workspace before we
  // touch any delivery state. pingWebhook re-checks, but doing it
  // up-front lets us return a clean 404 with no audit noise.
  const existing = await loadWebhookForWorkspace(id, wsId);
  if (!existing) {
    return NextResponse.json(
      { error: { type: "not_found", message: "Webhook not found." } },
      { status: 404 },
    );
  }
  if (existing.disabled) {
    await tryRecordAudit(req, {
      action: "webhook.ping",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: wsId,
      target: { type: "webhook", id, label: existing.label },
      status: "denied",
      meta: { reason: "disabled" },
    });
    return NextResponse.json(
      {
        error: {
          type: "webhook_disabled",
          message: "Resume the webhook before sending a test ping.",
        },
      },
      { status: 409 },
    );
  }

  try {
    const delivery = await pingWebhook(id, wsId, { id: user.id, email: user.email });
    if (!delivery) {
      return NextResponse.json(
        { error: { type: "not_found", message: "Webhook not found." } },
        { status: 404 },
      );
    }
    await tryRecordAudit(req, {
      action: "webhook.ping",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: wsId,
      target: { type: "webhook", id, label: existing.label },
      status: delivery.ok ? "ok" : "error",
      meta: {
        deliveryId: delivery.id,
        httpStatus: delivery.status,
        attempts: delivery.attempts,
        durationMs: delivery.durationMs,
        error: delivery.error ?? null,
      },
    });
    return NextResponse.json({ delivery }, { status: delivery.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json(
      { error: { type: "internal", message: e instanceof Error ? e.message : "Ping failed." } },
      { status: 500 },
    );
  }
}
