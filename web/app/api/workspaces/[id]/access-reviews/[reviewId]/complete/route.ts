/**
 * Complete an open access review.
 *
 *   POST /api/workspaces/:id/access-reviews/:reviewId/complete
 *   Owner only.
 *
 * Seals the review and suspends every member with a "revoke" decision.
 * Returns 409 if any entry is still pending. Sole-owner safety from
 * `suspendMember` still applies: if a revoke would leave the workspace
 * without an owner, the review remains open and the call fails with 409
 * so the owner can change their decision.
 */
import { NextRequest, NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../../../lib/dashboard-allowlist-enforce";
import {
  getWorkspace,
  canManage,
} from "../../../../../../../lib/workspaces";
import {
  getReview,
  complete,
  summarize,
} from "../../../../../../../lib/access-reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; reviewId: string }> },
) {
  const { id, reviewId } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ipBlock = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/access-reviews" },
  );
  if (ipBlock) return ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.access_review_complete",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "access_review", id: reviewId, label: reviewId },
      status: "denied",
      meta: { reason: "owner_required" },
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const existing = await getReview(ws.id, reviewId);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const result = await complete({ workspace: ws, reviewId, actorUserId: user.id });
    await tryRecordAudit(req, {
      action: "workspace.access_review_complete",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "access_review", id: result.review.id, label: result.review.title },
      status: "ok",
      meta: { revoked: result.revoked.length, skipped: result.skipped.length },
    });
    return NextResponse.json({
      review: summarize(result.review),
      revoked: result.revoked,
      skipped: result.skipped,
    });
  } catch (err: unknown) {
    const code = (err as Error).message;
    if (code === "decisions_incomplete") {
      return NextResponse.json(
        {
          error: "conflict",
          code,
          message: "All members must have a decision before completing.",
        },
        { status: 409 },
      );
    }
    if (code === "only_owner") {
      await tryRecordAudit(req, {
        action: "workspace.access_review_complete",
        actorId: user.id,
        actorEmail: user.email,
        workspaceId: ws.id,
        target: { type: "access_review", id: reviewId, label: reviewId },
        status: "denied",
        meta: { reason: "only_owner" },
      });
      return NextResponse.json(
        {
          error: "conflict",
          code,
          message: "Revoking would leave the workspace without an owner.",
        },
        { status: 409 },
      );
    }
    if (code === "review_not_open") {
      return NextResponse.json({ error: "conflict", code }, { status: 409 });
    }
    if (code === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
