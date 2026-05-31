import { NextResponse } from "next/server";
import { createKey, listKeys } from "../../../lib/api-keys";
import { currentUserFromCookieHeader } from "../../../lib/auth";
import { tryRecordAudit } from "../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json(
    { error: { type: "unauthorized", message: "Sign in to manage API keys." } },
    { status: 401 },
  );
}

export async function GET(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return unauthorized();
  try {
    const items = await listKeys(user.id);
    return NextResponse.json({ items, count: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

interface CreateBody {
  label?: unknown;
  expiresInDays?: unknown;
  scopes?: unknown;
  rpm?: unknown;
}

export async function POST(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return unauthorized();
  let body: CreateBody = {};
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    // empty body is fine; we'll default the label
  }
  try {
    const { record, plaintext } = await createKey(body.label, {
      userId: user.id,
      expiresInDays: body.expiresInDays,
      scopes: body.scopes,
      rpm: body.rpm,
    });
    await tryRecordAudit(req, {
      action: "api_key.create",
      actorId: user.id,
      actorEmail: user.email,
      target: { type: "api_key", id: record.id, label: record.label },
      diff: { after: { label: record.label, scopes: record.scopes, expiresAt: record.expiresAt, rateLimit: record.rateLimit } },
    });
    return NextResponse.json({ key: record, plaintext }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
