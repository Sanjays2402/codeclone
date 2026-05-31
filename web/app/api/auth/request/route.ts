/**
 * POST /api/auth/request { email, redirect? }
 *
 * Issues a magic-link token. In dev (no SMTP configured), the link is
 * written to the magic-links directory and printed to stderr. The
 * response includes the link only when CODECLONE_AUTH_DEV=1, so tests
 * and local UX can complete the loop without an email provider.
 */
import { NextResponse } from "next/server";
import {
  normalizeEmail,
  issueMagicLink,
  isProdSecret,
} from "../../../../lib/auth";
import { findEnforcedSsoForEmail } from "../../../../lib/sso";
import { tryRecordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Body must be JSON." } },
      { status: 400 },
    );
  }
  const b = (body ?? {}) as { email?: unknown; redirect?: unknown };
  const email = normalizeEmail(b.email);
  if (!email) {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Valid email is required." } },
      { status: 400 },
    );
  }
  const redirect =
    typeof b.redirect === "string" && b.redirect.startsWith("/") && !b.redirect.startsWith("//")
      ? b.redirect
      : undefined;

  const origin = new URL(req.url).origin;

  // SSO enforcement: if any workspace has enforced OIDC for this email
  // domain, the user must complete the SSO flow instead of receiving a
  // magic link. We tell the client where to go so the UI can redirect.
  const enforced = await findEnforcedSsoForEmail(email);
  if (enforced) {
    const start = new URL(`/api/auth/sso/${enforced.id}/start`, origin);
    if (redirect) start.searchParams.set("redirect", redirect);
    await tryRecordAudit(req, {
      action: "auth.magic_link_blocked_sso",
      actorEmail: email,
      workspaceId: enforced.id,
      target: { type: "workspace", id: enforced.id, label: enforced.name },
      status: "denied",
      meta: { reason: "sso_enforced" },
    });
    return NextResponse.json(
      {
        error: {
          type: "sso_required",
          message: "Your organization requires single sign-on.",
        },
        ssoStartUrl: start.toString(),
        workspaceName: enforced.name,
      },
      { status: 403 },
    );
  }

  const link = await issueMagicLink(email, origin, redirect);

  // Surface the link in dev / test logs. Production should swap this for SMTP.
  // eslint-disable-next-line no-console
  console.error(`[codeclone:auth] magic link for ${email}: ${link.url}`);

  const devMode = !isProdSecret() || process.env.CODECLONE_AUTH_DEV === "1";
  await tryRecordAudit(req, {
    action: "auth.magic_link_requested",
    actorEmail: email,
    target: { type: "user", id: email, label: email },
    meta: { redirect },
  });
  return NextResponse.json({
    ok: true,
    email,
    devLink: devMode ? link.url : undefined,
  });
}
