/**
 * Periodic access reviews (SOC2 CC6.3 attestation).
 *
 *   GET  /api/workspaces/:id/access-reviews   any active member
 *   POST /api/workspaces/:id/access-reviews   owner; opens a new review
 *                                             body: { title? }
 */
import { NextRequest, NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../lib/dashboard-allowlist-enforce";
import {
  getWorkspace,
  getActiveMember,
  canManage,
} from "../../../../../lib/workspaces";
import {
  listReviews,
  openReview,
  summarize,
} from "../../../../../lib/access-reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
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
  if (!getActiveMember(ws, user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const reviews = await listReviews(ws.id);
  return NextResponse.json({
    reviews: reviews.map(summarize),
    canEdit: canManage(ws, user.id),
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
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
      action: "workspace.access_review_open",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
      meta: { reason: "owner_required" },
    });
    return NextResponse.json(
      { error: "forbidden", message: "Owner role required." },
      { status: 403 },
    );
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const title = (body as { title?: unknown })?.title;

  try {
    const rec = await openReview({ workspace: ws, actorUserId: user.id, title: typeof title === "string" ? title : undefined });
    await tryRecordAudit(req, {
      action: "workspace.access_review_open",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "access_review", id: rec.id, label: rec.title },
      status: "ok",
      meta: { entries: rec.entries.length },
    });
    return NextResponse.json({ review: summarize(rec) }, { status: 201 });
  } catch (err: unknown) {
    const code = (err as Error).message;
    if (code === "review_already_open") {
      return NextResponse.json(
        { error: "conflict", code, message: "An access review is already in progress." },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "internal", message: "Unable to open review." },
      { status: 500 },
    );
  }
}
