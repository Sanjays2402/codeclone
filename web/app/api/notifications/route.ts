/**
 * GET  /api/notifications      list current user's notifications
 * POST /api/notifications      body { action: "mark-all-read" | "clear" }
 *
 * Auth required: returns 401 with { error } when no session cookie.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../lib/auth";
import { tryRecordAudit } from "../../../lib/audit";
import {
  clearAll,
  countUnread,
  listNotifications,
  markAllRead,
} from "../../../lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get("unread") === "1";
  const limitRaw = url.searchParams.get("limit");
  let limit = 50;
  if (limitRaw) {
    const n = Number.parseInt(limitRaw, 10);
    if (Number.isFinite(n) && n > 0 && n <= 200) limit = n;
  }
  try {
    const [items, unread] = await Promise.all([
      listNotifications(user.id, { unreadOnly, limit }),
      countUnread(user.id),
    ]);
    return NextResponse.json({ items, unread, count: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

interface ActionBody {
  action?: unknown;
}

export async function POST(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  let body: ActionBody;
  try {
    body = (await req.json()) as ActionBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";
  try {
    if (action === "mark-all-read") {
      const updated = await markAllRead(user.id);
      await tryRecordAudit(req, {
        action: "notification.mark_all_read",
        actorId: user.id,
        actorEmail: user.email,
        target: { type: "notification" },
        meta: { updated },
      });
      return NextResponse.json({ updated });
    }
    if (action === "clear") {
      const removed = await clearAll(user.id);
      await tryRecordAudit(req, {
        action: "notification.clear_all",
        actorId: user.id,
        actorEmail: user.email,
        target: { type: "notification" },
        meta: { removed },
      });
      return NextResponse.json({ removed });
    }
    return NextResponse.json(
      { error: "Unknown action. Use 'mark-all-read' or 'clear'." },
      { status: 400 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
