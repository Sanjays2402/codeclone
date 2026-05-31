/**
 * GET /api/auth/sso/:workspaceId/callback?code&state
 *
 * Completes the OIDC flow: validates the state cookie, exchanges the
 * code for an id_token with PKCE, verifies the id_token signature +
 * claims against the discovered JWKS, enforces the workspace's domain
 * policy, then issues a tracked codeclone session and redirects.
 */
import { NextResponse } from "next/server";
import {
  getWorkspaceForSso,
  discover,
  verifyState,
  verifyIdToken,
  emailDomain,
  SSO_STATE_COOKIE,
  clearedStateCookie,
  type IdTokenClaims,
} from "../../../../../../lib/sso";
import {
  findOrCreateUser,
  normalizeEmail,
  signSession,
  touchLogin,
  sessionCookieAttributes,
  COOKIE_NAME,
} from "../../../../../../lib/auth";
import {
  createSession,
  newJti,
  clientIpFromHeaders,
  getUserTtl,
  enforceConcurrentSessionCap,
} from "../../../../../../lib/sessions";
import { tryRecordAudit } from "../../../../../../lib/audit";
import {
  applyAutoJoinForUser,
  effectiveSessionPolicyForUser,
} from "../../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function back(origin: string, code: string): Response {
  const u = new URL("/signin", origin);
  u.searchParams.set("error", code);
  return NextResponse.redirect(u, { status: 303 });
}

function readStateCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`(?:^|; )${SSO_STATE_COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export async function GET(req: Request, ctx: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await ctx.params;
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    await tryRecordAudit(req, {
      action: "auth.sso_callback", workspaceId,
      target: { type: "workspace", id: workspaceId },
      status: "denied", meta: { reason: errorParam },
    });
    return back(url.origin, "sso_denied");
  }
  if (!code || !stateParam) return back(url.origin, "sso_invalid");

  const cookieState = readStateCookie(req.headers.get("cookie"));
  if (!cookieState || cookieState !== stateParam) return back(url.origin, "sso_state_mismatch");

  const claims = verifyState(stateParam);
  if (!claims || claims.wsId !== workspaceId) return back(url.origin, "sso_state_invalid");

  const ws = await getWorkspaceForSso(workspaceId);
  if (!ws || !ws.sso) return back(url.origin, "sso_not_configured");

  let disc;
  try { disc = await discover(ws.sso.issuer); }
  catch { return back(url.origin, "sso_unavailable"); }

  // Exchange code with PKCE.
  const callback = new URL(`/api/auth/sso/${ws.id}/callback`, url.origin).toString();
  const tokenRes = await fetch(disc.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callback,
      client_id: ws.sso.clientId,
      client_secret: ws.sso.clientSecret,
      code_verifier: claims.verifier,
    }).toString(),
  });
  if (!tokenRes.ok) {
    await tryRecordAudit(req, {
      action: "auth.sso_callback", workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "error", meta: { reason: "token_exchange_failed", status: tokenRes.status },
    });
    return back(url.origin, "sso_token_exchange_failed");
  }
  const token = (await tokenRes.json()) as { id_token?: string; access_token?: string };
  if (!token.id_token) return back(url.origin, "sso_no_id_token");

  let id: IdTokenClaims;
  try {
    id = await verifyIdToken(token.id_token, {
      issuer: ws.sso.issuer,
      clientId: ws.sso.clientId,
      nonce: claims.nonce,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "verify_failed";
    await tryRecordAudit(req, {
      action: "auth.sso_callback", workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "error", meta: { reason },
    });
    return back(url.origin, "sso_idtoken_invalid");
  }

  const email = normalizeEmail(id.email);
  if (!email) return back(url.origin, "sso_no_email");
  if (id.email_verified === false) return back(url.origin, "sso_email_unverified");

  // Domain policy: must match the workspace's allowedDomain.
  const dom = emailDomain(email);
  if (!dom || dom !== ws.sso.allowedDomain) {
    await tryRecordAudit(req, {
      action: "auth.sso_callback", workspaceId: ws.id, actorEmail: email,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied", meta: { reason: "domain_mismatch", got: dom },
    });
    return back(url.origin, "sso_domain_mismatch");
  }
  // Google: also confirm hd claim when present.
  if (typeof id.hd === "string" && id.hd.toLowerCase() !== ws.sso.allowedDomain) {
    return back(url.origin, "sso_hd_mismatch");
  }

  const user = await findOrCreateUser(email);
  await touchLogin(user.id);

  const jti = newJti();
  const ttlSec = await getUserTtl(user.id);
  const ip = clientIpFromHeaders(req.headers);
  const ua = req.headers.get("user-agent");
  await createSession({ userId: user.id, jti, ttlSec, ip, userAgent: ua });
  try {
    const eff = await effectiveSessionPolicyForUser(user.id);
    if (eff.maxConcurrentSessions > 0) {
      const evicted = await enforceConcurrentSessionCap(
        user.id,
        eff.maxConcurrentSessions,
        jti,
      );
      for (const ev of evicted) {
        await tryRecordAudit(req, {
          action: "session.evicted_for_cap",
          actorId: user.id,
          actorEmail: email,
          workspaceId: eff.capSourceWorkspaceId ?? ws.id,
          target: { type: "session", id: ev.jti },
          meta: {
            cap: eff.maxConcurrentSessions,
            via: "sso",
            evictedCreatedAt: ev.createdAt,
            evictedIp: ev.createdIp,
          },
        });
      }
    }
  } catch { /* never block sign-in on cap enforcement */ }
  const session = signSession(user.id, ttlSec, jti);

  const dest = claims.redirect && claims.redirect.startsWith("/") && !claims.redirect.startsWith("//")
    ? claims.redirect : "/";
  const res = NextResponse.redirect(new URL(dest, url.origin), { status: 303 });
  res.headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(session)}; ${sessionCookieAttributes(ttlSec)}`,
  );
  res.headers.append("Set-Cookie", `${SSO_STATE_COOKIE}=; ${clearedStateCookie()}`);

  await tryRecordAudit(req, {
    action: "auth.sso_signin",
    actorId: user.id, actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "session", id: jti },
    meta: { issuer: ws.sso.issuer, sub: id.sub },
  });
  try {
    const joined = await applyAutoJoinForUser({
      userId: user.id,
      email: user.email,
      viaSso: true,
    });
    for (const j of joined) {
      await tryRecordAudit(req, {
        action: "workspace.auto_join",
        actorId: user.id,
        actorEmail: user.email,
        workspaceId: j.id,
        target: { type: "workspace", id: j.id, label: j.name },
        meta: { role: j.autoJoinRole ?? "viewer", via: "sso" },
      });
    }
  } catch { /* never block sign-in on auto-join */ }
  return res;
}
