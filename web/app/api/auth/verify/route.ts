/**
 * GET /api/auth/verify?token=<id>.<secret>&redirect=/path
 *
 * Consumes the magic token, creates a tracked server-side session, sets the
 * signed cookie, and redirects to the post-login destination.
 */
import { NextResponse } from "next/server";
import {
  consumeMagicLink,
  signSession,
  COOKIE_NAME,
  sessionCookieAttributes,
} from "../../../../lib/auth";
import {
  createSession,
  newJti,
  clientIpFromHeaders,
  getUserTtl,
} from "../../../../lib/sessions";
import { tryRecordAudit } from "../../../../lib/audit";
import { applyAutoJoinForUser } from "../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const redirectParam = url.searchParams.get("redirect");
  const redirect =
    redirectParam && redirectParam.startsWith("/") && !redirectParam.startsWith("//")
      ? redirectParam
      : "/";

  const user = await consumeMagicLink(token);
  if (!user) {
    const back = new URL("/signin", url.origin);
    back.searchParams.set("error", "invalid_or_expired");
    return NextResponse.redirect(back, { status: 303 });
  }

  const jti = newJti();
  const ttlSec = await getUserTtl(user.id);
  const ip = clientIpFromHeaders(req.headers);
  const ua = req.headers.get("user-agent");
  await createSession({ userId: user.id, jti, ttlSec, ip, userAgent: ua });

  const cookie = signSession(user.id, ttlSec, jti);
  const res = NextResponse.redirect(new URL(redirect, url.origin), { status: 303 });
  res.headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(cookie)}; ${sessionCookieAttributes(ttlSec)}`,
  );
  await tryRecordAudit(req, {
    action: "auth.signin",
    actorId: user.id,
    actorEmail: user.email,
    target: { type: "session", id: jti },
    meta: { ttlSec },
  });
  try {
    const joined = await applyAutoJoinForUser({
      userId: user.id,
      email: user.email,
      viaSso: false,
    });
    for (const ws of joined) {
      await tryRecordAudit(req, {
        action: "workspace.auto_join",
        actorId: user.id,
        actorEmail: user.email,
        workspaceId: ws.id,
        target: { type: "workspace", id: ws.id, label: ws.name },
        meta: { role: ws.autoJoinRole ?? "viewer", via: "magic_link" },
      });
    }
  } catch { /* never block sign-in on auto-join */ }
  return res;
}
