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
  type NotificationRecord,
} from "../../../lib/notifications";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function notificationsToCsv(rows: ReadonlyArray<NotificationRecord>): string {
  const header = [
    "id",
    "kind",
    "title",
    "body",
    "href",
    "created_at",
    "read_at",
    "read",
  ];
  const lines: string[] = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.id),
        csvCell(r.kind),
        csvCell(r.title),
        csvCell(r.body ?? ""),
        csvCell(r.href ?? ""),
        csvCell(r.createdAt),
        csvCell(r.readAt ?? null),
        csvCell(r.readAt ? "true" : "false"),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

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
  const formatRaw = url.searchParams.get("format");
  const format =
    formatRaw === null || formatRaw === "" ? "json" : formatRaw.toLowerCase();
  if (format !== "json" && format !== "csv") {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message: "format must be 'json' (default) or 'csv'.",
        },
      },
      { status: 400 },
    );
  }
  try {
    const [items, unread] = await Promise.all([
      listNotifications(user.id, { unreadOnly, limit }),
      countUnread(user.id),
    ]);
    void tryRecordAudit(req, {
      action: "notification.read",
      actorId: user.id,
      actorEmail: user.email,
      target: { type: "notification" },
      meta: { count: items.length, format, unreadOnly },
    });
    if (format === "csv") {
      const csv = notificationsToCsv(items);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition":
            'attachment; filename="codeclone-notifications.csv"',
          "Cache-Control": "no-store",
        },
      });
    }
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
