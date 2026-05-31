/**
 * Workspace Data Processing Agreement (DPA) acceptance.
 *
 * Procurement and security reviews routinely block onboarding until a
 * customer can prove that an authorized representative accepted the
 * vendor's DPA / Terms before any production data flowed through the
 * platform. SOC 2 CC1.1, ISO 27001 A.5.20, and most enterprise vendor
 * questionnaires reference a "documented acceptance with version,
 * signatory, and timestamp" requirement.
 *
 * This module owns:
 *   - the canonical version string customers must accept,
 *   - the pure sanitize/decide helpers used by routes and tests,
 *   - the persistence helpers that mutate the workspace record,
 *   - a stable shape (`publicDpaStatus`) the dashboard renders.
 *
 * Runtime enforcement lives in lib/dpa-enforce.ts so this file stays
 * free of next/server imports and remains usable from unit tests.
 *
 * Bumping `DPA_CURRENT_VERSION` immediately invalidates every older
 * acceptance: enforce returns 403 `dpa_required` on the next /v1 call
 * and the dashboard re-prompts the owner. There is no auto-accept.
 */
import type { WorkspaceRecord } from "./workspaces.ts";
import { setDpa as persistDpa } from "./workspaces.ts";

/**
 * Bump this when the legal text materially changes. Use ISO date form
 * so the order is obvious and diff-able in audit logs.
 */
export const DPA_CURRENT_VERSION = "2025-01-01";

/**
 * Human-readable summary the dashboard shows alongside the accept
 * button. Kept terse on purpose; the actual long-form DPA lives in
 * docs/dpa and is linked from the UI.
 */
export const DPA_SUMMARY =
  "By accepting, the workspace owner agrees, on behalf of the organization, " +
  "to the codeclone Data Processing Agreement and Terms of Service version " +
  `${DPA_CURRENT_VERSION}. This acknowledgment is recorded in the audit log ` +
  "and required before any /v1 API calls succeed.";

export interface DpaStatus {
  required: boolean;
  currentVersion: string;
  accepted: boolean;
  acceptance: WorkspaceRecord["dpa"] | null;
  /**
   * True when an acceptance exists but it pins a prior version that has
   * since been superseded. UI surfaces this as a re-accept prompt.
   */
  stale: boolean;
}

/**
 * Pure decision used by both the dashboard and the enforcer. Returns a
 * `DpaStatus` describing whether the workspace satisfies the current
 * DPA version. Never mutates.
 */
export function evaluateDpa(ws: WorkspaceRecord | null | undefined): DpaStatus {
  const acceptance = ws?.dpa ?? null;
  if (!acceptance) {
    return {
      required: true,
      currentVersion: DPA_CURRENT_VERSION,
      accepted: false,
      acceptance: null,
      stale: false,
    };
  }
  const stale = acceptance.version !== DPA_CURRENT_VERSION;
  return {
    required: stale,
    currentVersion: DPA_CURRENT_VERSION,
    accepted: !stale,
    acceptance,
    stale,
  };
}

/**
 * True when the workspace is gated: no acceptance, or an acceptance
 * pinned to a superseded version. Cheap one-liner used by enforcers.
 */
export function isDpaBlocking(ws: WorkspaceRecord | null | undefined): boolean {
  return evaluateDpa(ws).required;
}

/**
 * Extract a representable client IP from the incoming request. Mirrors
 * the convention already in use across lib/ip-allowlist-enforce.ts:
 * trust x-forwarded-for's leftmost entry, fall back to x-real-ip, then
 * to null. We intentionally do NOT cryptographically bind the request;
 * the audit chain provides tamper evidence.
 */
export function extractClientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real && real.trim()) return real.trim();
  return null;
}

export interface AcceptDpaInput {
  version: string;
}

/**
 * Validate the body of POST /api/workspaces/:id/dpa. The caller MUST
 * present the current version explicitly so a stale dashboard tab that
 * was loaded before a version bump cannot silently re-accept the new
 * terms. Returns null on validation failure.
 */
export function sanitizeAcceptInput(
  input: unknown,
): AcceptDpaInput | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as Record<string, unknown>).version;
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > 64) return null;
  return { version: v };
}

/**
 * Persist an acceptance. Caller (route handler) MUST enforce owner-only
 * permission, MFA step-up if configured, and write the audit entry.
 * Stamps acceptedAt server-side so the client cannot back-date.
 */
export async function acceptDpa(
  ws: WorkspaceRecord,
  opts: {
    version: string;
    userId: string;
    email: string;
    ip: string | null;
  },
): Promise<WorkspaceRecord> {
  ws.dpa = {
    version: opts.version,
    acceptedAt: Date.now(),
    acceptedByUserId: opts.userId,
    acceptedByEmail: opts.email,
    acceptedFromIp: opts.ip,
  };
  await persistDpa(ws, ws.dpa);
  return ws;
}

/**
 * Withdraw acceptance. Used by owners who need to renegotiate terms.
 * Re-enables the gate on the next /v1 call.
 */
export async function withdrawDpa(ws: WorkspaceRecord): Promise<WorkspaceRecord> {
  ws.dpa = null;
  await persistDpa(ws, null);
  return ws;
}
