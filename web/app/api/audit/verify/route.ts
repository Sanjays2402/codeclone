import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../lib/auth";
import { verifyAuditChain, tryRecordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/audit/verify
 *
 * Walk the on-disk append-only audit log and verify the sha256 hash chain.
 * Returns the chain status, total entries seen, where it broke (if anywhere),
 * and the last chained hash so an operator can pin it externally (for example
 * by emailing the hex to a compliance mailbox or anchoring it on a notary
 * service). Any signed-in user may verify; the act of verification is itself
 * audited so a tampering attempt cannot quietly verify the log.
 */
export async function GET(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await verifyAuditChain();
  await tryRecordAudit(req, {
    action: "audit.verify",
    actorId: user.id,
    actorEmail: user.email,
    target: { type: "audit_log" },
    status: result.ok ? "ok" : "error",
    meta: {
      totalEntries: result.totalEntries,
      chainedEntries: result.chainedEntries,
      legacyEntries: result.legacyEntries,
      lastHash: result.lastHash,
      brokenAt: result.brokenAt,
    },
  });
  return NextResponse.json(result, {
    status: result.ok ? 200 : 409,
    headers: {
      "Cache-Control": "no-store",
      "X-Audit-Chain-Status": result.ok ? "ok" : "broken",
    },
  });
}
