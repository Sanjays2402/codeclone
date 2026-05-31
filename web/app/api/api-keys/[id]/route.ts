import { NextResponse } from "next/server";
import { deleteKey, loadKey, revokeKey, updateKey } from "../../../../lib/api-keys";
import { currentUserFromCookieHeader } from "../../../../lib/auth";
import { tryRecordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json(
    { error: { type: "unauthorized", message: "Sign in to manage API keys." } },
    { status: 401 },
  );
}

function notFound() {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const rec = await loadKey(id);
  if (!rec) return notFound();
  if (rec.userId && rec.userId !== user.id) return notFound();
  const { hash: _hash, ...safe } = rec;
  return NextResponse.json(safe);
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const ok = await revokeKey(id, user.id);
  if (!ok) return notFound();
  await tryRecordAudit(req, {
    action: "api_key.revoke",
    actorId: user.id,
    actorEmail: user.email,
    target: { type: "api_key", id },
  });
  return NextResponse.json({ id, revoked: true });
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const before = await loadKey(id);
  if (!before || (before.userId && before.userId !== user.id)) return notFound();
  let body: { rpm?: unknown } = {};
  try {
    body = (await req.json()) as { rpm?: unknown };
  } catch {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Body must be JSON." } },
      { status: 400 },
    );
  }
  if (!("rpm" in body)) {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Send { rpm: number | null } to set or clear the per-key limit." } },
      { status: 400 },
    );
  }
  let updated;
  try {
    updated = await updateKey(id, { rpm: body.rpm }, user.id);
  } catch (e) {
    return NextResponse.json(
      { error: { type: "invalid_request", message: e instanceof Error ? e.message : String(e) } },
      { status: 400 },
    );
  }
  if (!updated) return notFound();
  await tryRecordAudit(req, {
    action: "api_key.update_rate_limit",
    actorId: user.id,
    actorEmail: user.email,
    target: { type: "api_key", id, label: updated.label },
    diff: {
      before: { rateLimit: before.rateLimit ?? null },
      after: { rateLimit: updated.rateLimit ?? null },
    },
  });
  return NextResponse.json(updated);
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const ok = await deleteKey(id, user.id);
  if (!ok) return notFound();
  await tryRecordAudit(req, {
    action: "api_key.delete",
    actorId: user.id,
    actorEmail: user.email,
    target: { type: "api_key", id },
  });
  return NextResponse.json({ id, deleted: true });
}
