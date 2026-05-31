import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../lib/auth";
import { tryRecordAudit } from "../../../../lib/audit";
import {
  loadSnippet,
  updateSnippet,
  deleteSnippet,
  SnippetError,
} from "../../../../lib/snippets";

export const dynamic = "force-dynamic";

async function currentUser(req: Request) {
  return currentUserFromCookieHeader(req.headers.get("cookie"));
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUser(req);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const rec = await loadSnippet(user.id, id);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ snippet: rec });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUser(req);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  try {
    const before = await loadSnippet(user.id, id);
    const rec = await updateSnippet(user.id, id, {
      title: typeof b.title === "string" ? b.title : undefined,
      language: typeof b.language === "string" ? b.language : undefined,
      body: typeof b.body === "string" ? b.body : undefined,
      tags: Array.isArray(b.tags) ? (b.tags as string[]) : undefined,
    });
    if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
    await tryRecordAudit(req, {
      action: "snippet.update",
      actorId: user.id,
      actorEmail: user.email,
      target: { type: "snippet", id: rec.id, label: rec.title },
      diff: {
        before: before ? { title: before.title, language: before.language, tags: before.tags } : null,
        after: { title: rec.title, language: rec.language, tags: rec.tags },
      },
    });
    return NextResponse.json({ snippet: rec });
  } catch (err) {
    if (err instanceof SnippetError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUser(req);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const before = await loadSnippet(user.id, id);
  const ok = await deleteSnippet(user.id, id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  await tryRecordAudit(req, {
    action: "snippet.delete",
    actorId: user.id,
    actorEmail: user.email,
    target: { type: "snippet", id, label: before?.title },
    diff: { before: before ? { title: before.title, language: before.language } : null },
  });
  return NextResponse.json({ ok: true });
}
