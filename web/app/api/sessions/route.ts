/**
 * GET  /api/sessions          → list the signed-in user's active sessions
 *                                  (?format=csv returns a spreadsheet export
 *                                  for the same rows)
 * POST /api/sessions/revoke-all → revoke every session except the current one
 *                                  (force logout other devices). Pass
 *                                  { includeCurrent: true } to log out
 *                                  everywhere (caller is also signed out).
 */
import { NextResponse } from "next/server";
import {
  COOKIE_NAME,
  clearedCookieAttributes,
  currentSessionFromCookieHeader,
} from "../../../lib/auth";
import {
  listSessions,
  revokeAllSessions,
  touchSession,
  clientIpFromHeaders,
  getUserTtl,
  setUserTtl,
  MIN_TTL_SEC,
  MAX_TTL_SEC,
} from "../../../lib/sessions";
import { tryRecordAudit } from "../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

interface SessionCsvRow {
  jti: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
  createdIp: string | null;
  createdUserAgent: string | null;
  current: boolean;
}

function sessionsToCsv(rows: ReadonlyArray<SessionCsvRow>): string {
  const header = [
    "jti",
    "created_at",
    "expires_at",
    "last_seen_at",
    "ip",
    "user_agent",
    "created_ip",
    "created_user_agent",
    "current",
  ];
  const lines: string[] = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.jti),
        csvCell(r.createdAt),
        csvCell(r.expiresAt),
        csvCell(r.lastSeenAt),
        csvCell(r.ip),
        csvCell(r.userAgent),
        csvCell(r.createdIp),
        csvCell(r.createdUserAgent),
        csvCell(r.current === true),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

export async function GET(req: Request) {
  const ctx = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  if (!ctx) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const url = new URL(req.url);
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
  // Opportunistically refresh last-seen for the current session.
  if (ctx.jti) {
    await touchSession(
      ctx.user.id,
      ctx.jti,
      clientIpFromHeaders(req.headers),
      req.headers.get("user-agent"),
    );
  }
  const sessions = await listSessions(ctx.user.id);
  const ttlSec = await getUserTtl(ctx.user.id);
  const rows: SessionCsvRow[] = sessions.map((s) => ({
    jti: s.jti,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    lastSeenAt: s.lastSeenAt,
    ip: s.ip,
    userAgent: s.userAgent,
    createdIp: s.createdIp,
    createdUserAgent: s.createdUserAgent,
    current: ctx.jti === s.jti,
  }));
  void tryRecordAudit(req, {
    action: "auth.sessions_read",
    actorId: ctx.user.id,
    actorEmail: ctx.user.email,
    target: { type: "user", id: ctx.user.id },
    status: "ok",
    meta: { count: rows.length, format },
  });
  if (format === "csv") {
    const csv = sessionsToCsv(rows);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-sessions.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json({
    sessions: rows,
    currentJti: ctx.jti,
    ttl: { current: ttlSec, min: MIN_TTL_SEC, max: MAX_TTL_SEC },
  });
}

export async function PATCH(req: Request) {
  const ctx = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  if (!ctx) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const obj = (body || {}) as { ttlSec?: unknown };
  if (typeof obj.ttlSec !== "number" || !Number.isFinite(obj.ttlSec)) {
    return NextResponse.json({ error: "invalid_ttl" }, { status: 400 });
  }
  if (obj.ttlSec < MIN_TTL_SEC || obj.ttlSec > MAX_TTL_SEC) {
    return NextResponse.json(
      { error: "ttl_out_of_range", min: MIN_TTL_SEC, max: MAX_TTL_SEC },
      { status: 400 },
    );
  }
  const before = await getUserTtl(ctx.user.id);
  const applied = await setUserTtl(ctx.user.id, obj.ttlSec);
  await tryRecordAudit(req, {
    action: "auth.session_ttl_update",
    actorId: ctx.user.id,
    actorEmail: ctx.user.email,
    target: { type: "user", id: ctx.user.id },
    diff: { before: { ttlSec: before }, after: { ttlSec: applied } },
  });
  return NextResponse.json({ ttlSec: applied });
}
