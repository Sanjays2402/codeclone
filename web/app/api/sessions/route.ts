/**
 * GET  /api/sessions          → list the signed-in user's active sessions
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

export async function GET(req: Request) {
  const ctx = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  if (!ctx) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
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
  return NextResponse.json({
    sessions: sessions.map((s) => ({
      jti: s.jti,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      lastSeenAt: s.lastSeenAt,
      ip: s.ip,
      userAgent: s.userAgent,
      createdIp: s.createdIp,
      createdUserAgent: s.createdUserAgent,
      current: ctx.jti === s.jti,
    })),
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
