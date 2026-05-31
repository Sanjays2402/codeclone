import { NextResponse } from "next/server";
import {
  listDeliveriesForWorkspace,
  loadWebhookForWorkspace,
  validateWorkspaceId,
} from "../../../../../lib/webhooks";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { getWorkspace, getMember } from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json(
      { error: { type: "unauthorized", message: "Sign in to view deliveries." } },
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
  if (!ws || !getMember(ws, user.id)) {
    return NextResponse.json(
      { error: { type: "forbidden", message: "You are not a member of that workspace." } },
      { status: 403 },
    );
  }
  const rec = await loadWebhookForWorkspace(id, wsId);
  if (!rec) {
    return NextResponse.json({ error: { type: "not_found", message: "Not found." } }, { status: 404 });
  }
  return NextResponse.json({ items: await listDeliveriesForWorkspace(id, wsId) });
}
