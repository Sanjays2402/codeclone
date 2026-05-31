import { NextResponse } from "next/server";
import {
  deleteWebhook,
  setDisabled,
  loadWebhookForWorkspace,
  summarize,
  validateWorkspaceId,
} from "../../../../lib/webhooks";
import { tryRecordAudit } from "../../../../lib/audit";
import { currentUserFromCookieHeader } from "../../../../lib/auth";
import { getWorkspace, getMember } from "../../../../lib/workspaces";

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
        { error: { type: "unauthorized", message: "Sign in to manage webhooks." } },
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
  const member = getMember(ws, user.id);
  if (!member) {
    return {
      error: NextResponse.json(
        { error: { type: "forbidden", message: "You are not a member of that workspace." } },
        { status: 403 },
      ),
    };
  }
  return { user, ws, member } as const;
}

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const r = await resolve(req);
  if ("error" in r) return r.error;
  const rec = await loadWebhookForWorkspace(id, r.ws.id);
  if (!rec) return NextResponse.json({ error: { type: "not_found", message: "Not found." } }, { status: 404 });
  return NextResponse.json(summarize(rec));
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const r = await resolve(req);
  if ("error" in r) return r.error;
  if (r.member.role === "viewer") {
    return NextResponse.json(
      { error: { type: "forbidden", message: "Viewers cannot modify webhooks." } },
      { status: 403 },
    );
  }
  let body: { disabled?: unknown };
  try {
    body = (await req.json()) as { disabled?: unknown };
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (typeof body.disabled !== "boolean") {
    return NextResponse.json({ error: "Field 'disabled' must be boolean." }, { status: 400 });
  }
  const ok = await setDisabled(id, body.disabled, r.ws.id);
  if (!ok) return NextResponse.json({ error: { type: "not_found", message: "Not found." } }, { status: 404 });
  const rec = await loadWebhookForWorkspace(id, r.ws.id);
  await tryRecordAudit(req, {
    action: body.disabled ? "webhook.disable" : "webhook.enable",
    actorId: r.user.id,
    actorEmail: r.user.email,
    workspaceId: r.ws.id,
    target: { type: "webhook", id },
  });
  return NextResponse.json(rec ? summarize(rec) : { ok: true });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const r = await resolve(req);
  if ("error" in r) return r.error;
  if (r.member.role === "viewer") {
    return NextResponse.json(
      { error: { type: "forbidden", message: "Viewers cannot delete webhooks." } },
      { status: 403 },
    );
  }
  const ok = await deleteWebhook(id, r.ws.id);
  if (!ok) return NextResponse.json({ error: { type: "not_found", message: "Not found." } }, { status: 404 });
  await tryRecordAudit(req, {
    action: "webhook.delete",
    actorId: r.user.id,
    actorEmail: r.user.email,
    workspaceId: r.ws.id,
    target: { type: "webhook", id },
  });
  return NextResponse.json({ ok: true });
}
