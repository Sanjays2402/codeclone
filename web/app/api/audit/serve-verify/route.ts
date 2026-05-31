import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../lib/auth";
import { tryRecordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/audit/serve-verify
 *
 * Proxy the serve service's tamper-evident audit chain verification
 * endpoint (``GET /v1/audit/verify``) so the UI can render integrity
 * status without shipping the admin API key to the browser.
 *
 * Reads ``CODECLONE_SERVE_URL`` (default ``http://127.0.0.1:7461``) and
 * ``CODECLONE_SERVE_ADMIN_KEY``. When the admin key is absent we report
 * ``configured: false`` rather than 500 so dev/preview environments
 * stay green.
 *
 * Signed-in users only; the verification call itself is audited.
 */
export async function GET(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const base = (process.env.CODECLONE_SERVE_URL || "http://127.0.0.1:7461").replace(
    /\/+$/,
    "",
  );
  const adminKey = process.env.CODECLONE_SERVE_ADMIN_KEY;

  if (!adminKey) {
    return NextResponse.json(
      {
        configured: false,
        reason: "CODECLONE_SERVE_ADMIN_KEY not set",
        serveUrl: base,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let upstreamStatus = 0;
  let body: unknown = null;
  let reachError: string | null = null;
  try {
    const r = await fetch(`${base}/v1/audit/verify`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${adminKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });
    upstreamStatus = r.status;
    body = await r.json().catch(() => null);
  } catch (err) {
    reachError = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timeout);
  }

  const ok =
    reachError === null &&
    upstreamStatus === 200 &&
    body !== null &&
    typeof body === "object" &&
    (body as { ok?: boolean }).ok === true;

  await tryRecordAudit(req, {
    action: "audit.serve_verify",
    actorId: user.id,
    actorEmail: user.email,
    target: { type: "serve_audit_log" },
    status: ok ? "ok" : "error",
    meta: {
      serveUrl: base,
      upstreamStatus,
      reachError,
    },
  });

  return NextResponse.json(
    {
      configured: true,
      serveUrl: base,
      upstreamStatus,
      reachError,
      result: body,
    },
    {
      status: reachError ? 502 : upstreamStatus || 502,
      headers: {
        "Cache-Control": "no-store",
        "X-Audit-Chain-Status": ok ? "ok" : "broken",
      },
    },
  );
}
