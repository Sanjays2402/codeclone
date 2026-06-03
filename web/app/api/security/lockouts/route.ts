/**
 * GET /api/security/lockouts
 *
 * Read-only view of magic-link / sign-in lockouts that are currently
 * in effect. Restricted to users who own at least one workspace so
 * that security teams investigating an attack have a place to look,
 * but unprivileged accounts cannot enumerate global abuse state.
 *
 * Identifiers (email / IP) are returned as the same opaque hash used
 * on disk; we never echo the raw email or address back to the
 * browser, so a compromised admin token still cannot harvest the
 * underlying values.
 *
 * Supports ?format=csv so an owner can snapshot the active set into a
 * spreadsheet for an incident report without having to retype the
 * grid by hand. CSV stays hash-only for the same privacy reason as
 * JSON.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../lib/auth";
import { listWorkspacesForUser, getActiveMember } from "../../../../lib/workspaces";
import { listActiveLockouts, config as throttleConfig, type ActiveLockout } from "../../../../lib/auth-throttle";
import { tryRecordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function lockoutsToCsv(rows: ActiveLockout[]): string {
  const header = [
    "scope",
    "hash",
    "count",
    "window_start",
    "window_start_iso",
    "locked_until",
    "locked_until_iso",
  ];
  const lines: string[] = [header.join(",")];
  for (const r of rows) {
    let startIso = "";
    let untilIso = "";
    try { startIso = new Date(r.windowStart).toISOString(); } catch { /* leave blank */ }
    try { untilIso = new Date(r.lockedUntil).toISOString(); } catch { /* leave blank */ }
    lines.push(
      [
        csvCell(r.scope),
        csvCell(r.hash),
        csvCell(r.count),
        csvCell(r.windowStart),
        csvCell(startIso),
        csvCell(r.lockedUntil),
        csvCell(untilIso),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

export async function GET(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json(
      { error: { type: "unauthorized", message: "Sign in required." } },
      { status: 401 },
    );
  }
  const memberships = await listWorkspacesForUser(user.id);
  const ownsAny = memberships.some((ws) => getActiveMember(ws, user.id)?.role === "owner");
  if (!ownsAny) {
    await tryRecordAudit(req, {
      action: "security.lockouts.read.denied",
      actorId: user.id,
      actorEmail: user.email,
      target: { type: "security", id: "lockouts" },
      status: "denied",
      meta: { reason: "not_owner" },
    });
    return NextResponse.json(
      {
        error: {
          type: "forbidden",
          message: "Only workspace owners can view security lockouts.",
        },
      },
      { status: 403 },
    );
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

  const lockouts = await listActiveLockouts();
  await tryRecordAudit(req, {
    action: "security.lockouts.read",
    actorId: user.id,
    actorEmail: user.email,
    target: { type: "security", id: "lockouts" },
    meta: { count: lockouts.length, format },
  });
  if (format === "csv") {
    const csv = lockoutsToCsv(lockouts);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-security-lockouts.csv"`,
        "cache-control": "no-store",
      },
    });
  }
  return NextResponse.json({
    config: throttleConfig(),
    lockouts,
  });
}
