/**
 * Per-review operations.
 *
 *   GET    /api/workspaces/:id/access-reviews/:reviewId             active member
 *   POST   /api/workspaces/:id/access-reviews/:reviewId/decisions   owner; mark keep/revoke
 *   POST   /api/workspaces/:id/access-reviews/:reviewId/complete    owner; seal + apply revokes
 *   DELETE /api/workspaces/:id/access-reviews/:reviewId             owner; cancel an open review
 *
 * Sub-actions live under ./[reviewId]/decisions and ./[reviewId]/complete.
 * This file handles GET + DELETE (cancel) of the review itself.
 */
import { NextRequest, NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../../lib/dashboard-allowlist-enforce";
import {
  getWorkspace,
  getActiveMember,
  canManage,
} from "../../../../../../lib/workspaces";
import {
  getReview,
  cancel,
  summarize,
} from "../../../../../../lib/access-reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string; reviewId: string }>;
}

async function load(req: NextRequest, ctx: Params) {
  const { id, reviewId } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  const ws = await getWorkspace(id);
  if (!ws) return { error: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  const ipBlock = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/access-reviews" },
  );
  if (ipBlock) return { error: ipBlock };
  // Tenant isolation: getReview is scoped to ws.id directory, so even a
  // reviewId leaked from another workspace cannot be loaded here.
  const review = await getReview(ws.id, reviewId);
  if (!review) return { error: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  return { user, ws, review };
}

export async function GET(req: NextRequest, ctx: Params) {
  const r = await load(req, ctx);
  if ("error" in r) return r.error;
  if (!getActiveMember(r.ws, r.user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    review: { ...summarize(r.review), entries: r.review.entries },
    canEdit: canManage(r.ws, r.user.id),
  });
}

export async function DELETE(req: NextRequest, ctx: Params) {
  const r = await load(req, ctx);
  if ("error" in r) return r.error;
  if (!canManage(r.ws, r.user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.access_review_cancel",
      actorId: r.user.id,
      actorEmail: r.user.email,
      workspaceId: r.ws.id,
      target: { type: "access_review", id: r.review.id, label: r.review.title },
      status: "denied",
      meta: { reason: "owner_required" },
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const rec = await cancel({
      workspaceId: r.ws.id,
      reviewId: r.review.id,
      actorUserId: r.user.id,
    });
    await tryRecordAudit(req, {
      action: "workspace.access_review_cancel",
      actorId: r.user.id,
      actorEmail: r.user.email,
      workspaceId: r.ws.id,
      target: { type: "access_review", id: rec.id, label: rec.title },
      status: "ok",
    });
    return NextResponse.json({ review: summarize(rec) });
  } catch (err: unknown) {
    const code = (err as Error).message;
    if (code === "review_not_open") {
      return NextResponse.json(
        { error: "conflict", code, message: "Review is not open." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
