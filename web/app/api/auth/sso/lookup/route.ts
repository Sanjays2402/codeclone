/**
 * POST /api/auth/sso/lookup { email }
 *
 * Returns whether the email domain has an SSO policy configured. Used by
 * the signin page to surface a "Continue with single sign-on" affordance
 * before the user submits the magic-link form. Never reveals which
 * workspace owns the policy when not enforced (to avoid org enumeration);
 * only the start URL is returned and only for domains that have wired
 * SSO at all.
 */
import { NextResponse } from "next/server";
import { normalizeEmail } from "../../../../../lib/auth";
import {
  emailDomain,
  findEnforcedSsoForEmail,
} from "../../../../../lib/sso";
import { listWorkspaces } from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { email?: unknown } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const email = normalizeEmail(body.email);
  if (!email) return NextResponse.json({ ok: false }, { status: 200 });
  const origin = new URL(req.url).origin;

  // Enforced match wins.
  const enforced = await findEnforcedSsoForEmail(email);
  if (enforced) {
    return NextResponse.json({
      ok: true,
      enforced: true,
      workspaceName: enforced.name,
      startUrl: `${origin}/api/auth/sso/${enforced.id}/start`,
    });
  }

  // Optional (non-enforced) availability hint.
  const dom = emailDomain(email);
  if (!dom) return NextResponse.json({ ok: false });
  const all = await listWorkspaces();
  const optional = all.find((w) => w.sso && w.sso.allowedDomain === dom);
  if (!optional) return NextResponse.json({ ok: false });
  return NextResponse.json({
    ok: true,
    enforced: false,
    startUrl: `${origin}/api/auth/sso/${optional.id}/start`,
  });
}
