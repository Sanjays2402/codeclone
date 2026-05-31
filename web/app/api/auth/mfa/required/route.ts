/**
 * MFA enrollment requirement status for the current user.
 *
 * GET /api/auth/mfa/required
 *   Returns whether the user must enroll TOTP because of a workspace
 *   policy, how long the grace window has left, and the workspace that
 *   enforces it. The dashboard uses this to render a remediation banner
 *   long before mutating requests start being refused with 403
 *   `mfa_enrollment_required`.
 *
 * 401 when unauthenticated. Never blocks; this endpoint is the place
 * users go to learn how to unblock themselves.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { mfaEnrollmentStatusFor } from "../../../../../lib/mfa-enforce";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const status = await mfaEnrollmentStatusFor(user);
  return NextResponse.json(status);
}
