/**
 * POST /api/auth/mfa/backup-codes/regenerate
 *
 * Replace the calling user's MFA backup codes with a fresh set of 10
 * single-use codes. The new plaintext codes are returned exactly once
 * in the response body and never persisted.
 *
 * Required for SOC2-style account recovery hygiene: when an admin
 * loses their printed codes (or has burned through them) they need a
 * way to rotate without disabling MFA and re-enrolling, which would
 * briefly leave the account at single-factor.
 *
 * Auth: cookie session required.
 * Step-up: fresh TOTP verification required (so a stolen cookie
 *   cannot silently rotate codes and lock the legitimate owner out).
 *   On 401 with `error: "mfa_required"` the UI should send the user
 *   through /api/auth/mfa/challenge and retry.
 *
 * Audited as `mfa.backup_codes.regenerate` with the number of codes
 * the user discarded (previousRemaining) so SecOps can correlate a
 * rotation against a stolen-laptop ticket.
 */
import { NextResponse } from "next/server";
import { currentSessionFromCookieHeader } from "../../../../../../lib/auth";
import {
  regenerateBackupCodes,
  requireStepUp,
  BACKUP_CODE_COUNT,
} from "../../../../../../lib/mfa";
import { tryRecordAudit } from "../../../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  if (!ctx) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const stepUp = await requireStepUp(ctx.user.id, ctx.jti ?? null);
  if (!stepUp.allowed) {
    return NextResponse.json(
      { error: "mfa_required" },
      { status: 401 },
    );
  }
  try {
    const out = await regenerateBackupCodes(ctx.user.id);
    await tryRecordAudit(req, {
      action: "mfa.backup_codes.regenerate",
      actorId: ctx.user.id,
      actorEmail: ctx.user.email,
      target: { type: "user", id: ctx.user.id },
      meta: {
        previousRemaining: out.previousRemaining,
        issued: out.backupCodes.length,
      },
    });
    return NextResponse.json({
      ok: true,
      backupCodes: out.backupCodes,
      count: BACKUP_CODE_COUNT,
      previousRemaining: out.previousRemaining,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not regenerate codes." },
      { status: 400 },
    );
  }
}
