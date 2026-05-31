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
  const link = await issueMagicLink(email, origin, redirect);

  // Surface the link in dev / test logs. Production should swap this for SMTP.
  // eslint-disable-next-line no-console
  console.error(`[codeclone:auth] magic link for ${email}: ${link.url}`);

  const devMode = !isProdSecret() || process.env.CODECLONE_AUTH_DEV === "1";
  return NextResponse.json({
    ok: true,
    email,
    devLink: devMode ? link.url : undefined,
  });
}
