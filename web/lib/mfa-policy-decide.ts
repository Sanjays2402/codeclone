/**
 * Pure decision helpers for the workspace MFA enrollment policy.
 *
 * Lives in its own module so tests can import it under raw
 * `node --test --experimental-strip-types` without pulling in
 * next/server (which is bundled by Next, not resolvable from raw node).
 * The NextResponse wrapper lives in lib/mfa-enforce.ts.
 */
import type { UserRecord } from "./auth.ts";
import { effectiveMfaPolicyForUser } from "./workspaces.ts";
import { getMfa, isEnrolled } from "./mfa.ts";

export interface MfaEnrollmentStatus {
  required: boolean;
  blocked: boolean;
  enrolled: boolean;
  workspaceId: string | null;
  workspaceName: string | null;
  gracePeriodDays: number;
  deadline: number | null;
  /** Seconds remaining in grace; null when not required, 0 when blocked. */
  secondsRemaining: number | null;
}

export async function mfaEnrollmentStatusFor(user: UserRecord): Promise<MfaEnrollmentStatus> {
  const [policy, mfa] = await Promise.all([
    effectiveMfaPolicyForUser(user.id),
    getMfa(user.id),
  ]);
  const enrolled = isEnrolled(mfa);
  const blocked = policy.required && !enrolled && policy.pastDeadline;
  const now = Date.now();
  const secondsRemaining = !policy.required
    ? null
    : enrolled
      ? null
      : policy.deadline === null
        ? null
        : Math.max(0, Math.floor((policy.deadline - now) / 1000));
  return {
    required: policy.required,
    blocked,
    enrolled,
    workspaceId: policy.workspaceId,
    workspaceName: policy.workspaceName,
    gracePeriodDays: policy.gracePeriodDays,
    deadline: policy.deadline,
    secondsRemaining,
  };
}
