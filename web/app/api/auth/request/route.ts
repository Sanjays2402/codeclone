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
import {
  evaluate as evaluateThrottle,
  throttleHeaders,
  clientIpFrom,
} from "../../../../lib/auth-throttle";

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
  const ip = clientIpFrom(req.headers);

  // Brute-force / email-bombing defense. Per-IP and per-email fixed
  // windows; either tripping the ceiling produces a structured 429
  // with Retry-After + X-RateLimit-* headers and an audit entry. We
  // check IP first so an attacker cannot enumerate which addresses
  // are locked by varying the email field.
  for (const probe of [
    { scope: "ip" as const, id: ip, action: "auth.magic_link_throttled_ip" },
    { scope: "email" as const, id: email, action: "auth.magic_link_throttled_email" },
  ]) {
    if (!probe.id) continue;
    const decision = await evaluateThrottle(probe.scope, probe.id, "check");
    if (!decision.allowed) {
      await tryRecordAudit(req, {
        action: probe.action,
        actorEmail: email,
        target: { type: "user", id: email, label: email },
        status: "denied",
        meta: {
          scope: probe.scope,
          limit: decision.limit,
          retryAfterSec: decision.retryAfter,
          locked: decision.locked,
        },
      });
      return NextResponse.json(
        {
          error: {
            type: "rate_limited",
            message:
              "Too many sign-in requests. Wait a few minutes before trying again, then contact support if the issue persists.",
            scope: probe.scope,
            retry_after_seconds: decision.retryAfter,
          },
        },
        { status: 429, headers: throttleHeaders(decision) },
      );
    }
  }

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

  // Register the attempt against both counters. The register step may
  // be the one that trips the lockout; if so we still issue this one
  // link (so a legitimate user racing the limit is not silently
  // blocked mid-flow) but subsequent attempts will be denied.
  const registered = {
    ip: ip ? await evaluateThrottle("ip", ip, "register") : null,
    email: await evaluateThrottle("email", email, "register"),
  };

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
  // Surface the most restrictive counter on the response so good
  // clients can adaptively back off before they get a hard 429.
  const counters = [registered.ip, registered.email].filter(
    (d): d is NonNullable<typeof registered.email> => d != null && d.limit > 0,
  );
  const headers: Record<string, string> = {};
  if (counters.length > 0) {
    const tightest = counters.reduce((a, b) => (a.remaining <= b.remaining ? a : b));
    Object.assign(headers, throttleHeaders(tightest));
  }

  return NextResponse.json(
    {
      ok: true,
      email,
      devLink: devMode ? link.url : undefined,
    },
    { headers },
  );
}
