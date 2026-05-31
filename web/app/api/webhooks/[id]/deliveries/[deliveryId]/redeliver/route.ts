import { NextResponse } from "next/server";
import {
  redeliverDelivery,
  validateWorkspaceId,
} from "../../../../../../../lib/webhooks";
import { tryRecordAudit } from "../../../../../../../lib/audit";
import { currentUserFromCookieHeader } from "../../../../../../../lib/auth";
import { getWorkspace, getMember } from "../../../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; deliveryId: string }>;
}

export async function POST(req: Request, ctx: Ctx) {
  const { id, deliveryId } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json(
      { error: { type: "unauthorized", message: "Sign in to redeliver." } },
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
    return NextResponse.json({ error: { type: "not_found", message: "Workspace not found." } }, { status: 404 });
  }
  const member = getMember(ws, user.id);
  if (!member) {
    return NextResponse.json(
      { error: { type: "forbidden", message: "You are not a member of that workspace." } },
      { status: 403 },
    );
  }
  if (member.role === "viewer") {
    return NextResponse.json(
      { error: { type: "forbidden", message: "Viewers cannot redeliver webhooks." } },
      { status: 403 },
    );
  }
  try {
    const delivery = await redeliverDelivery(id, deliveryId, wsId);
    if (!delivery) {
      return NextResponse.json(
        { error: { type: "not_found", message: "Webhook or delivery not found." } },
        { status: 404 },
      );
    }
    await tryRecordAudit(req, {
      action: "webhook.redeliver",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: wsId,
      target: { type: "webhook_delivery", id: deliveryId, label: id },
    });
    return NextResponse.json({ delivery });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Redelivery failed." },
      { status: 500 },
    );
  }
}
