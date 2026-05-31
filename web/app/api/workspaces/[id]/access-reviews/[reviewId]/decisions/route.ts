/**
 * Record per-member keep/revoke decisions on an open review.
 *
 *   POST /api/workspaces/:id/access-reviews/:reviewId/decisions
 *   Owner only.
 *   Body: { decisions: [{ userId, decision: "keep"|"revoke", note? }, ...] }
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
  decide,
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
      action: "workspace.access_review_decide",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "access_review", id: reviewId, label: reviewId },
      status: "denied",
      meta: { reason: "owner_required" },
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Tenant-scoped load.
  const existing = await getReview(ws.id, reviewId);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Invalid JSON." }, { status: 400 });
  }
  const decisions = (body as { decisions?: unknown })?.decisions;
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return NextResponse.json(
      { error: "bad_request", message: "decisions: non-empty array required." },
      { status: 400 },
    );
  }
  const clean: Array<{ userId: string; decision: "keep" | "revoke"; note?: string }> = [];
  for (const raw of decisions) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { userId?: unknown; decision?: unknown; note?: unknown };
    const uid = typeof r.userId === "string" ? r.userId : "";
    const dec = r.decision === "keep" || r.decision === "revoke" ? r.decision : null;
    if (!uid || !dec) continue;
    clean.push({
      userId: uid,
      decision: dec,
      note: typeof r.note === "string" ? r.note : undefined,
    });
  }
  if (clean.length === 0) {
    return NextResponse.json(
      { error: "bad_request", message: "no valid decisions provided." },
      { status: 400 },
    );
  }
  try {
    const rec = await decide({
      workspaceId: ws.id,
      reviewId,
      actorUserId: user.id,
      decisions: clean,
    });
    await tryRecordAudit(req, {
      action: "workspace.access_review_decide",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "access_review", id: rec.id, label: rec.title },
      status: "ok",
      meta: { decisions: clean.length },
    });
    return NextResponse.json({ review: { ...summarize(rec), entries: rec.entries } });
  } catch (err: unknown) {
    const code = (err as Error).message;
    if (code === "review_not_open") {
      return NextResponse.json(
        { error: "conflict", code, message: "Review is not open." },
        { status: 409 },
      );
    }
    if (code === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
