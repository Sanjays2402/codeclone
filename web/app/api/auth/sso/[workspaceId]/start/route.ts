/**
 * GET /api/auth/sso/:workspaceId/start?redirect=/path
 *
 * Begins an OIDC Authorization Code + PKCE flow for the named workspace.
 * Sets a short-lived signed state cookie (PKCE verifier + nonce + post-login
 * redirect) and 303-redirects to the provider's authorize endpoint.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  getWorkspaceForSso,
  discover,
  makePkce,
  signState,
  stateCookieAttributes,
  SSO_STATE_COOKIE,
  SSO_STATE_TTL_SEC,
} from "../../../../../../lib/sso";
import { tryRecordAudit } from "../../../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await ctx.params;
  const url = new URL(req.url);
  const redirectParam = url.searchParams.get("redirect");
  const redirect =
    redirectParam && redirectParam.startsWith("/") && !redirectParam.startsWith("//")
      ? redirectParam
      : "/";

  const ws = await getWorkspaceForSso(workspaceId);
  if (!ws || !ws.sso) {
    const back = new URL("/signin", url.origin);
    back.searchParams.set("error", "sso_not_configured");
    return NextResponse.redirect(back, { status: 303 });
  }

  let disc;
  try { disc = await discover(ws.sso.issuer); }
  catch {
    await tryRecordAudit(req, {
      action: "auth.sso_start",
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "error",
      meta: { reason: "discovery_failed" },
    });
    const back = new URL("/signin", url.origin);
    back.searchParams.set("error", "sso_unavailable");
    return NextResponse.redirect(back, { status: 303 });
  }

  const { verifier, challenge } = makePkce();
  const nonce = crypto.randomBytes(16).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const state = signState({
    wsId: ws.id,
    verifier,
    nonce,
    redirect,
    iat: now,
    exp: now + SSO_STATE_TTL_SEC,
  });

  const callback = new URL(`/api/auth/sso/${ws.id}/callback`, url.origin).toString();
  const authorize = new URL(disc.authorization_endpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", ws.sso.clientId);
  authorize.searchParams.set("redirect_uri", callback);
  authorize.searchParams.set("scope", "openid email profile");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  // Google: pin hosted domain when available.
  if (ws.sso.allowedDomain) authorize.searchParams.set("hd", ws.sso.allowedDomain);

  await tryRecordAudit(req, {
    action: "auth.sso_start",
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    meta: { issuer: ws.sso.issuer },
  });

  const res = NextResponse.redirect(authorize.toString(), { status: 303 });
  res.headers.append(
    "Set-Cookie",
    `${SSO_STATE_COOKIE}=${encodeURIComponent(state)}; ${stateCookieAttributes()}`,
  );
  return res;
}
