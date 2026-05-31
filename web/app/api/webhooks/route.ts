import { NextResponse } from "next/server";
import {
  createWebhook,
  listWebhooksForWorkspace,
  validateWorkspaceId,
} from "../../../lib/webhooks";
import { tryRecordAudit } from "../../../lib/audit";
import { currentUserFromCookieHeader } from "../../../lib/auth";
import { getWorkspace, getMember } from "../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json(
    { error: { type: "unauthorized", message: "Sign in to manage webhooks." } },
    { status: 401 },
  );
}

function forbidden(message = "You are not a member of that workspace.") {
  return NextResponse.json(
    { error: { type: "forbidden", message } },
    { status: 403 },
  );
}

function badWorkspace() {
  return NextResponse.json(
    { error: { type: "invalid_workspace", message: "A valid workspaceId is required." } },
    { status: 400 },
  );
}

async function resolveWorkspaceForUser(req: Request, workspaceIdRaw: unknown) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return { error: unauthorized() };
  const wsId = validateWorkspaceId(workspaceIdRaw);
  if (!wsId) return { error: badWorkspace() };
  const ws = await getWorkspace(wsId);
  if (!ws) return { error: forbidden() };
  const member = getMember(ws, user.id);
  if (!member) return { error: forbidden() };
  return { user, ws, member };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const r = await resolveWorkspaceForUser(req, url.searchParams.get("workspaceId"));
  if ("error" in r) return r.error;
  const items = await listWebhooksForWorkspace(r.ws.id);
  return NextResponse.json({ items, workspaceId: r.ws.id });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const b = (body ?? {}) as {
    label?: unknown;
    url?: unknown;
    events?: unknown;
    workspaceId?: unknown;
  };
  const r = await resolveWorkspaceForUser(req, b.workspaceId);
  if ("error" in r) return r.error;
  // Only owners/editors may create webhooks; viewers are read-only.
  if (r.member.role === "viewer") {
    return forbidden("Viewers cannot create webhooks.");
  }
  try {
    const created = await createWebhook({
      label: b.label,
      url: b.url,
      events: b.events,
      workspaceId: r.ws.id,
    });
    await tryRecordAudit(req, {
      action: "webhook.create",
      actorId: r.user.id,
      actorEmail: r.user.email,
      workspaceId: r.ws.id,
      target: { type: "webhook", id: created.record.id, label: created.record.label },
      diff: { after: { url: created.record.url, events: created.record.events } },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not create webhook." },
      { status: 400 },
    );
  }
}
