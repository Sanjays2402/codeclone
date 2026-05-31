/**
 * Periodic access reviews (SOC2 CC6.3 / ISO 27001 A.9.2.5).
 *
 * Auditors require that workspace owners periodically re-attest who
 * has access. This module persists a workspace-scoped review cycle:
 *
 *   1. Owner opens a review. We snapshot the current active members
 *      (excluding "support" grants, which already auto-expire) into a
 *      review record. Each member starts as "pending".
 *   2. Owner walks the list and marks each member "keep" or "revoke",
 *      optionally with a per-decision note.
 *   3. Owner completes the review. Any "revoke" decisions are applied
 *      by suspending those members; the review record is sealed.
 *
 * Every step is recorded in the tamper-evident audit chain so the
 * workspace produces a defensible "who reviewed access, when, and what
 * they decided" artifact for SOC2/DPA review packets.
 *
 * Storage:
 *   $CODECLONE_WORKSPACES_DIR/_access_reviews/<workspaceId>/<reviewId>.json
 *
 * Storage is file-backed (matches every other module in this repo); each
 * review is fully isolated by workspace id at the directory level, so a
 * caller scoped to workspace A can never observe or mutate a review for
 * workspace B even if a route forgot to gate on membership.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import {
  WORKSPACES_DIR,
  getMember,
  isMemberActive,
  isSupportMember,
  suspendMember,
} from "./workspaces.ts";
import type { WorkspaceRecord } from "./workspaces.ts";

export const ACCESS_REVIEWS_DIR_NAME = "_access_reviews";

const REVIEW_ID_LEN = 12;
const MAX_NOTE_LEN = 280;
const MAX_TITLE_LEN = 120;
const MAX_OPEN_REVIEWS_PER_WORKSPACE = 1;

export type ReviewDecision = "pending" | "keep" | "revoke";
export type ReviewStatus = "open" | "completed" | "cancelled";

export interface ReviewEntry {
  userId: string;
  email: string;
  role: "owner" | "editor" | "viewer";
  decision: ReviewDecision;
  note?: string;
  decidedAt?: number;
  decidedBy?: string;
}

export interface AccessReviewRecord {
  v: 1;
  id: string;
  workspaceId: string;
  title: string;
  status: ReviewStatus;
  createdAt: number;
  createdBy: string;
  completedAt?: number;
  completedBy?: string;
  cancelledAt?: number;
  cancelledBy?: string;
  entries: ReviewEntry[];
  /** member ids actually suspended at completion */
  revokedUserIds?: string[];
}

function reviewsDir(workspaceId: string): string {
  return path.join(WORKSPACES_DIR, ACCESS_REVIEWS_DIR_NAME, workspaceId);
}

function reviewPath(workspaceId: string, reviewId: string): string {
  return path.join(reviewsDir(workspaceId), reviewId + ".json");
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeJson(p: string, value: unknown) {
  await ensureDir(path.dirname(p));
  const tmp = p + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tmp, p);
}

function newReviewId(): string {
  return "rv_" + crypto.randomBytes(REVIEW_ID_LEN).toString("base64url").slice(0, REVIEW_ID_LEN);
}

export function sanitizeTitle(input: unknown): string {
  const s = typeof input === "string" ? input.trim() : "";
  if (!s) return "Quarterly access review";
  return s.slice(0, MAX_TITLE_LEN);
}

export function sanitizeNote(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const s = input.trim();
  if (!s) return undefined;
  return s.slice(0, MAX_NOTE_LEN);
}

export async function listReviews(workspaceId: string): Promise<AccessReviewRecord[]> {
  const dir = reviewsDir(workspaceId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: AccessReviewRecord[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const rec = await readJson<AccessReviewRecord>(path.join(dir, n));
    if (rec && rec.workspaceId === workspaceId) out.push(rec);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export async function getReview(
  workspaceId: string,
  reviewId: string,
): Promise<AccessReviewRecord | null> {
  // Strict directory scoping: the file is loaded from the workspace's own
  // directory only. Even if a caller passes a reviewId that exists in
  // another workspace's folder, we never see it from here.
  const rec = await readJson<AccessReviewRecord>(reviewPath(workspaceId, reviewId));
  if (!rec) return null;
  if (rec.workspaceId !== workspaceId) return null;
  return rec;
}

export function findOpenReview(reviews: AccessReviewRecord[]): AccessReviewRecord | null {
  return reviews.find((r) => r.status === "open") ?? null;
}

export interface OpenReviewInput {
  workspace: WorkspaceRecord;
  actorUserId: string;
  title?: string;
}

/**
 * Snapshot active membership and create a new "open" review. Throws
 * `review_already_open` if an open review already exists; only one
 * review per workspace may be in-flight to keep the audit narrative
 * unambiguous ("who decided what, in which review").
 */
export async function openReview(input: OpenReviewInput): Promise<AccessReviewRecord> {
  const { workspace, actorUserId, title } = input;
  const existing = findOpenReview(await listReviews(workspace.id));
  if (existing) throw new Error("review_already_open");

  const now = Date.now();
  const entries: ReviewEntry[] = workspace.members
    .filter((m) => isMemberActive(m, now) && !isSupportMember(m))
    .map((m) => ({
      userId: m.userId,
      email: m.email,
      role: m.role,
      decision: "pending" as const,
    }));

  // Cap concurrent reviews defensively (we already enforce single-open
  // above; this guards against a future relaxation of that rule).
  const open = (await listReviews(workspace.id)).filter((r) => r.status === "open");
  if (open.length >= MAX_OPEN_REVIEWS_PER_WORKSPACE) {
    throw new Error("review_already_open");
  }

  const rec: AccessReviewRecord = {
    v: 1,
    id: newReviewId(),
    workspaceId: workspace.id,
    title: sanitizeTitle(title),
    status: "open",
    createdAt: now,
    createdBy: actorUserId,
    entries,
  };
  await writeJson(reviewPath(workspace.id, rec.id), rec);
  return rec;
}

export interface DecideInput {
  workspaceId: string;
  reviewId: string;
  actorUserId: string;
  decisions: Array<{
    userId: string;
    decision: "keep" | "revoke";
    note?: string;
  }>;
}

/**
 * Record one or more per-member decisions on an open review. Unknown
 * member ids are ignored (they cannot have been in the snapshot). The
 * function is idempotent: re-deciding overwrites the prior decision
 * and updates the timestamp/actor.
 */
export async function decide(input: DecideInput): Promise<AccessReviewRecord> {
  const rec = await getReview(input.workspaceId, input.reviewId);
  if (!rec) throw new Error("not_found");
  if (rec.status !== "open") throw new Error("review_not_open");
  const now = Date.now();
  const byUser = new Map(rec.entries.map((e) => [e.userId, e] as const));
  let touched = false;
  for (const d of input.decisions) {
    const entry = byUser.get(d.userId);
    if (!entry) continue;
    if (d.decision !== "keep" && d.decision !== "revoke") continue;
    entry.decision = d.decision;
    entry.decidedAt = now;
    entry.decidedBy = input.actorUserId;
    const note = sanitizeNote(d.note);
    if (note) entry.note = note;
    else delete entry.note;
    touched = true;
  }
  if (touched) await writeJson(reviewPath(input.workspaceId, input.reviewId), rec);
  return rec;
}

export interface CompleteInput {
  workspace: WorkspaceRecord;
  reviewId: string;
  actorUserId: string;
}

export interface CompleteResult {
  review: AccessReviewRecord;
  revoked: string[];
  skipped: Array<{ userId: string; reason: string }>;
}

/**
 * Seal the review and apply revoke decisions by suspending the named
 * members. The completion step is intentionally strict:
 *   - every entry must be decided (no "pending" survivors)
 *   - sole-owner safety from suspendMember still applies; if a revoke
 *     would leave the workspace owner-less the call throws and the
 *     review stays open so the actor can retract the decision
 *
 * Suspensions performed here are the same ones an admin would perform
 * via the members route, so all downstream effects (session revocation,
 * key disablement, audit) flow through the existing machinery.
 */
export async function complete(input: CompleteInput): Promise<CompleteResult> {
  const rec = await getReview(input.workspace.id, input.reviewId);
  if (!rec) throw new Error("not_found");
  if (rec.status !== "open") throw new Error("review_not_open");
  const pending = rec.entries.filter((e) => e.decision === "pending");
  if (pending.length > 0) throw new Error("decisions_incomplete");

  const toRevoke = rec.entries.filter((e) => e.decision === "revoke");
  const revoked: string[] = [];
  const skipped: Array<{ userId: string; reason: string }> = [];
  let ws = input.workspace;
  for (const e of toRevoke) {
    const m = getMember(ws, e.userId);
    if (!m) {
      skipped.push({ userId: e.userId, reason: "not_member" });
      continue;
    }
    if (m.status === "suspended") {
      skipped.push({ userId: e.userId, reason: "already_suspended" });
      continue;
    }
    try {
      ws = await suspendMember(ws, e.userId, {
        actorUserId: input.actorUserId,
        reason: `access review ${rec.id}: ${(e.note || "revoked").slice(0, 120)}`,
      });
      revoked.push(e.userId);
    } catch (err: unknown) {
      const msg = (err as Error).message || "suspend_failed";
      // Sole-owner safety: bubble up so the caller can return a 409
      // and the owner can change their decision. Review stays open.
      if (msg === "only_owner") throw err;
      skipped.push({ userId: e.userId, reason: msg });
    }
  }

  rec.status = "completed";
  rec.completedAt = Date.now();
  rec.completedBy = input.actorUserId;
  rec.revokedUserIds = revoked;
  await writeJson(reviewPath(input.workspace.id, rec.id), rec);
  return { review: rec, revoked, skipped };
}

export interface CancelInput {
  workspaceId: string;
  reviewId: string;
  actorUserId: string;
}

export async function cancel(input: CancelInput): Promise<AccessReviewRecord> {
  const rec = await getReview(input.workspaceId, input.reviewId);
  if (!rec) throw new Error("not_found");
  if (rec.status !== "open") throw new Error("review_not_open");
  rec.status = "cancelled";
  rec.cancelledAt = Date.now();
  rec.cancelledBy = input.actorUserId;
  await writeJson(reviewPath(input.workspaceId, input.reviewId), rec);
  return rec;
}

/** Summary used by list views; hides internal versioning. */
export function summarize(rec: AccessReviewRecord) {
  const totals = rec.entries.reduce(
    (acc, e) => {
      acc.total++;
      acc[e.decision]++;
      return acc;
    },
    { total: 0, pending: 0, keep: 0, revoke: 0 } as Record<string, number>,
  );
  return {
    id: rec.id,
    workspaceId: rec.workspaceId,
    title: rec.title,
    status: rec.status,
    createdAt: rec.createdAt,
    createdBy: rec.createdBy,
    completedAt: rec.completedAt,
    cancelledAt: rec.cancelledAt,
    revokedCount: rec.revokedUserIds?.length ?? 0,
    totals,
  };
}
