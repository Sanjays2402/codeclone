/**
 * MFA enrollment policy enforcement (NextResponse wrapper).
 *
 * When any workspace a user belongs to has `mfaPolicy.requireEnrollment`
 * turned on and the user's grace window has elapsed, sensitive mutating
 * endpoints refuse the request with HTTP 403 and a structured
 * `mfa_enrollment_required` error so the UI can route the user to
 * /settings/security to enroll.
 *
 * The pure decision helper `mfaEnrollmentStatusFor` lives in
 * lib/mfa-policy-decide.ts so tests can exercise it without next/server.
 */
import { NextResponse } from "next/server";
import type { UserRecord } from "./auth.ts";
import { mfaEnrollmentStatusFor } from "./mfa-policy-decide.ts";
import { tryRecordAudit } from "./audit.ts";

export { mfaEnrollmentStatusFor };
export type { MfaEnrollmentStatus } from "./mfa-policy-decide.ts";

/**
 * Block the request when MFA enrollment is required and overdue. Returns
 * a 403 NextResponse on block (and writes an audit row), or null to let
 * the route continue. Usage:
 *
 *   const blocked = await enforceMfaEnrollment(req, user, "snippet.create");
 *   if (blocked) return blocked;
 */
export async function enforceMfaEnrollment(
  req: Request,
  user: UserRecord,
  action: string,
): Promise<NextResponse | null> {
  const status = await mfaEnrollmentStatusFor(user);
  if (!status.blocked) return null;
  await tryRecordAudit(req, {
    action,
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: status.workspaceId ?? undefined,
    status: "denied",
    meta: {
      reason: "mfa_enrollment_required",
      enforcingWorkspaceId: status.workspaceId,
    },
  });
  return NextResponse.json(
    {
      error: {
        type: "mfa_enrollment_required",
        message:
          "Your workspace requires TOTP enrollment. Enroll at /settings/security before retrying.",
        workspaceId: status.workspaceId,
        workspaceName: status.workspaceName,
      },
    },
    { status: 403 },
  );
}
