import { NextResponse } from "next/server";
import { loadShare, updateShare, deleteShare, type ScopeHint } from "../../../../lib/share";
import { tryRecordAudit } from "../../../../lib/audit";
import { currentUserFromCookieHeader } from "../../../../lib/auth";
import { listWorkspacesForUser } from "../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function userScope(req: Request): Promise<{ user: Awaited<ReturnType<typeof currentUserFromCookieHeader>>; scope: ScopeHint | undefined; }> {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return { user: null, scope: undefined };
  const wss = await listWorkspacesForUser(user.id);
  // User can mutate any share in any workspace they belong to, plus
  // legacy unscoped records. If they belong to multiple workspaces we
  // try each until one matches; here we use the first workspace and
  // also accept legacy unscoped records. Cross-tenant access returns 404.
  return { user, scope: { workspaceId: wss[0]?.id ?? null, allowLegacy: true } };
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const rec = await loadShare(id);
  if (!rec) {
    return NextResponse.json({ error: "Share not found." }, { status: 404 });
  }
  // ?download=1 makes the JSON body fall out of the browser as a saved
  // file (and gives curl -OJ a sensible filename) so the public /r/<id>
  // viewer can offer a one-click "download json" alongside the PDF
  // report. Same payload either way; only the headers change.
  const url = new URL(req.url);
  const download = url.searchParams.get("download");
  if (download === "1" || download === "true") {
    const body = JSON.stringify(rec, null, 2);
    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-share-${id}.json"`,
        "cache-control": "no-store",
      },
    });
  }
  return NextResponse.json(rec);
}

interface PatchBody {
  title?: unknown;
  tags?: unknown;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const { user, scope } = await userScope(req);
  if (!scope) {
    return NextResponse.json({ error: "Sign in to update shares." }, { status: 401 });
  }
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const patch: { title?: string | null; tags?: string[] | null } = {};
  if ("title" in body) {
    if (body.title === null) patch.title = null;
    else if (typeof body.title === "string") patch.title = body.title;
    else return NextResponse.json({ error: "title must be a string or null." }, { status: 400 });
  }
  if ("tags" in body) {
    if (body.tags === null) patch.tags = null;
    else if (Array.isArray(body.tags)) patch.tags = body.tags.filter((t) => typeof t === "string") as string[];
    else return NextResponse.json({ error: "tags must be an array of strings or null." }, { status: 400 });
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Provide title or tags to update." }, { status: 400 });
  }
  try {
    const before = await loadShare(id, scope);
    if (!before) {
      return NextResponse.json({ error: "Share not found." }, { status: 404 });
    }
    const rec = await updateShare(id, patch, scope);
    if (!rec) {
      return NextResponse.json({ error: "Share not found." }, { status: 404 });
    }
    await tryRecordAudit(req, {
      action: "share.update",
      actorId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      workspaceId: rec.workspaceId ?? null,
      target: { type: "share", id, label: rec.title ?? undefined },
      diff: { before: { title: before.title, tags: before.tags }, after: patch },
    });
    return NextResponse.json(rec);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const { user, scope } = await userScope(req);
  if (!scope) {
    return NextResponse.json({ error: "Sign in to delete shares." }, { status: 401 });
  }
  const before = await loadShare(id, scope);
  if (!before) {
    return NextResponse.json({ error: "Share not found." }, { status: 404 });
  }
  const ok = await deleteShare(id, scope);
  if (!ok) {
    return NextResponse.json({ error: "Share not found." }, { status: 404 });
  }
  await tryRecordAudit(req, {
    action: "share.delete",
    actorId: user?.id ?? null,
    actorEmail: user?.email ?? null,
    workspaceId: before.workspaceId ?? null,
    target: { type: "share", id, label: before.title ?? undefined },
    diff: { before: { title: before.title, tags: before.tags } },
  });
  return NextResponse.json({ ok: true });
}
