import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../lib/auth";
import { tryRecordAudit } from "../../../lib/audit";
import {
  createWorkspace,
  listWorkspacesForUser,
  normalizeName,
  type WorkspaceRecord,
} from "../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const items = await listWorkspacesForUser(user.id);
  return NextResponse.json({
    items: items.map((w: WorkspaceRecord) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      createdAt: w.createdAt,
      memberCount: w.members.length,
      myRole: w.members.find((m) => m.userId === user.id)?.role ?? null,
    })),
  });
}

export async function POST(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  let body: { name?: unknown } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const name = normalizeName(body.name);
  if (!name) {
    return NextResponse.json(
      { error: "invalid_name", message: "Name must be 1-64 chars and start with a letter or number." },
      { status: 400 },
    );
  }
  try {
    const ws = await createWorkspace({ name, ownerId: user.id, ownerEmail: user.email });
    await tryRecordAudit(req, {
      action: "workspace.create",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      diff: { after: { name: ws.name, slug: ws.slug } },
    });
    return NextResponse.json({ workspace: ws }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
