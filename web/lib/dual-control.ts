/**
 * Dual-control approvals (a.k.a. four-eyes / maker-checker) for the most
 * destructive workspace operations: hard wipe and owner transfer.
 *
 * Why this exists
 * ---------------
 * SOC 2 CC6.3, ISO 27001 A.5.3, and NIST 800-53 AC-5 all require
 * separation of duties for high-risk administrative actions. A single
 * compromised owner credential should not be enough to nuke a workspace
 * or hand it to an attacker. Buyers in regulated industries (finance,
 * healthcare, government) refuse to sign without this.
 *
 * Model
 * -----
 * Owners turn on a per-operation policy. When the policy is on for an
 * operation, the destructive endpoint will only run if it carries a
 * fresh, single-use `approval_token` that was issued by a *different*
 * owner via the approvals API.
 *
 * Approvals are workspace-scoped (cross-tenant queries are not even
 * representable: the storage path is keyed by workspaceId). They expire
 * after 30 minutes, are single-use, and every state transition (request,
 * approve, cancel, consume, expire) is recorded in the tamper-evident
 * audit chain by the calling route.
 *
 * Storage:
 *   $CODECLONE_WORKSPACES_DIR/_approvals/<workspaceId>/<approvalId>.json
 *
 * The store is intentionally small and fully filesystem-backed so the
 * rest of the app's storage conventions apply (atomic rename, no DB
 * dependency, easy to back up).
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { WORKSPACES_DIR, type WorkspaceRecord } from "./workspaces.ts";

export const APPROVAL_TTL_MS = 30 * 60 * 1000;

export const DUAL_CONTROL_OPERATIONS = [
  "workspace.wipe",
  "workspace.transfer_ownership",
] as const;

export type DualControlOperation = (typeof DUAL_CONTROL_OPERATIONS)[number];

export function isDualControlOperation(v: unknown): v is DualControlOperation {
  return typeof v === "string" && (DUAL_CONTROL_OPERATIONS as readonly string[]).includes(v);
}

export interface ApprovalRecord {
  v: 1;
  id: string;
  workspaceId: string;
  operation: DualControlOperation;
  /** Free-form payload the approver can review (e.g. {toUserId} for transfer). */
  payload: Record<string, unknown>;
  /** Stable hash of the payload at request time. The consuming route must
   *  recompute this against the actual request and refuse the approval if
   *  it does not match, so an approval for "transfer to Alice" cannot be
   *  reused to transfer to Eve. */
  payloadHash: string;
  /** Short human-readable justification supplied by the requester. */
  reason: string;
  requestedBy: string;
  requestedByEmail: string;
  requestedAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "cancelled" | "consumed" | "expired";
  approvedBy?: string;
  approvedByEmail?: string;
  approvedAt?: number;
  /** Plaintext one-time token returned exactly once at approval time and
   *  required on the destructive call. Stored hashed here (the route only
   *  ever sees the hash) so a leaked approvals.json cannot mint authority. */
  tokenHash?: string;
  consumedAt?: number;
  cancelledAt?: number;
  cancelledBy?: string;
}

const APPROVALS_ROOT_ENV = "CODECLONE_APPROVALS_DIR";

function approvalsRoot(): string {
  const fromEnv = process.env[APPROVALS_ROOT_ENV];
  if (fromEnv) return path.resolve(process.cwd(), fromEnv);
  return path.join(WORKSPACES_DIR, "_approvals");
}

function workspaceApprovalsDir(workspaceId: string): string {
  // workspaceId comes from trusted server state (the loaded WorkspaceRecord);
  // we still guard against any caller passing a path-traversal-ish id.
  if (!/^[A-Za-z0-9_\-]+$/.test(workspaceId)) {
    throw new Error("invalid_workspace_id");
  }
  return path.join(approvalsRoot(), workspaceId);
}

function approvalPath(workspaceId: string, id: string): string {
  if (!/^[A-Za-z0-9_\-]+$/.test(id)) throw new Error("invalid_approval_id");
  return path.join(workspaceApprovalsDir(workspaceId), id + ".json");
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
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tmp, p);
}

function newId(): string {
  return "apr_" + crypto.randomBytes(9).toString("base64url");
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** Deterministic JSON for hashing payloads. */
export function canonicalPayloadHash(operation: string, payload: Record<string, unknown>): string {
  const keys = Object.keys(payload).sort();
  const ordered: Record<string, unknown> = {};
  for (const k of keys) ordered[k] = payload[k];
  return sha256(operation + "\n" + JSON.stringify(ordered));
}

/** Policy helpers ------------------------------------------------------ */

export interface DualControlPolicy {
  operations: DualControlOperation[];
  updatedAt: number;
  updatedBy: string;
}

export function getDualControlPolicy(ws: WorkspaceRecord): DualControlPolicy | null {
  const dc = (ws as unknown as { dualControl?: DualControlPolicy | null }).dualControl;
  if (!dc || !Array.isArray(dc.operations) || dc.operations.length === 0) return null;
  return dc;
}

export function isDualControlEnabled(ws: WorkspaceRecord, op: DualControlOperation): boolean {
  const pol = getDualControlPolicy(ws);
  return !!pol && pol.operations.includes(op);
}

/** Approval store ------------------------------------------------------ */

export interface CreateApprovalInput {
  workspaceId: string;
  operation: DualControlOperation;
  payload: Record<string, unknown>;
  reason: string;
  requestedBy: string;
  requestedByEmail: string;
}

export async function createApprovalRequest(input: CreateApprovalInput): Promise<ApprovalRecord> {
  const now = Date.now();
  const rec: ApprovalRecord = {
    v: 1,
    id: newId(),
    workspaceId: input.workspaceId,
    operation: input.operation,
    payload: input.payload,
    payloadHash: canonicalPayloadHash(input.operation, input.payload),
    reason: input.reason,
    requestedBy: input.requestedBy,
    requestedByEmail: input.requestedByEmail,
    requestedAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
    status: "pending",
  };
  await writeJson(approvalPath(rec.workspaceId, rec.id), rec);
  return rec;
}

export async function getApproval(workspaceId: string, id: string): Promise<ApprovalRecord | null> {
  return readJson<ApprovalRecord>(approvalPath(workspaceId, id));
}

export async function listApprovals(workspaceId: string): Promise<ApprovalRecord[]> {
  const dir = workspaceApprovalsDir(workspaceId);
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: ApprovalRecord[] = [];
  const now = Date.now();
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    const rec = await readJson<ApprovalRecord>(path.join(dir, f));
    if (!rec) continue;
    // Cross-tenant guard: refuse to surface a record whose stored
    // workspaceId does not match the directory it lives in. Defence in
    // depth against any future bug that might mis-place a file.
    if (rec.workspaceId !== workspaceId) continue;
    if (rec.status === "pending" && now >= rec.expiresAt) {
      rec.status = "expired";
      await writeJson(approvalPath(workspaceId, rec.id), rec);
    }
    out.push(rec);
  }
  out.sort((a, b) => b.requestedAt - a.requestedAt);
  return out;
}

export interface ApproveResult {
  approval: ApprovalRecord;
  /** Plaintext one-time token. Returned exactly once; never persisted. */
  token: string;
}

export async function approveRequest(opts: {
  workspaceId: string;
  approvalId: string;
  approverUserId: string;
  approverEmail: string;
}): Promise<ApproveResult> {
  const rec = await getApproval(opts.workspaceId, opts.approvalId);
  if (!rec) throw new ApprovalError("not_found");
  if (rec.workspaceId !== opts.workspaceId) throw new ApprovalError("not_found");
  const now = Date.now();
  if (rec.status === "approved") throw new ApprovalError("already_approved");
  if (rec.status === "consumed") throw new ApprovalError("already_consumed");
  if (rec.status === "cancelled") throw new ApprovalError("cancelled");
  if (rec.status === "expired" || now >= rec.expiresAt) {
    rec.status = "expired";
    await writeJson(approvalPath(rec.workspaceId, rec.id), rec);
    throw new ApprovalError("expired");
  }
  if (rec.requestedBy === opts.approverUserId) {
    throw new ApprovalError("self_approval_forbidden");
  }
  const token = crypto.randomBytes(24).toString("base64url");
  rec.status = "approved";
  rec.approvedBy = opts.approverUserId;
  rec.approvedByEmail = opts.approverEmail;
  rec.approvedAt = now;
  rec.tokenHash = sha256(token);
  await writeJson(approvalPath(rec.workspaceId, rec.id), rec);
  return { approval: rec, token };
}

export async function cancelRequest(opts: {
  workspaceId: string;
  approvalId: string;
  byUserId: string;
}): Promise<ApprovalRecord> {
  const rec = await getApproval(opts.workspaceId, opts.approvalId);
  if (!rec) throw new ApprovalError("not_found");
  if (rec.workspaceId !== opts.workspaceId) throw new ApprovalError("not_found");
  if (rec.status === "consumed") throw new ApprovalError("already_consumed");
  if (rec.status === "cancelled") return rec;
  rec.status = "cancelled";
  rec.cancelledAt = Date.now();
  rec.cancelledBy = opts.byUserId;
  await writeJson(approvalPath(rec.workspaceId, rec.id), rec);
  return rec;
}

/**
 * Validate and atomically consume an approval token for a destructive
 * operation. The destructive route MUST call this BEFORE side effects;
 * a successful return is one-shot authority and the approval is moved
 * to `consumed` state regardless of whether the operation later fails.
 *
 * - operation must match
 * - payloadHash must match the route's own canonical hash of the
 *   incoming request payload (prevents bait-and-switch)
 * - approval must be in `approved` state and unexpired
 * - token must match the stored hash
 */
export async function consumeApprovalToken(opts: {
  workspaceId: string;
  operation: DualControlOperation;
  token: string;
  payloadForHash: Record<string, unknown>;
}): Promise<ApprovalRecord> {
  if (!opts.token || typeof opts.token !== "string") {
    throw new ApprovalError("token_required");
  }
  const dir = workspaceApprovalsDir(opts.workspaceId);
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ApprovalError("token_invalid");
    }
    throw err;
  }
  const wantHash = sha256(opts.token);
  const expectedPayloadHash = canonicalPayloadHash(opts.operation, opts.payloadForHash);
  const now = Date.now();
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    const p = path.join(dir, f);
    const rec = await readJson<ApprovalRecord>(p);
    if (!rec) continue;
    if (rec.workspaceId !== opts.workspaceId) continue;
    if (rec.operation !== opts.operation) continue;
    if (rec.status !== "approved") continue;
    if (!rec.tokenHash) continue;
    // Constant-time compare on the hashed token.
    const a = Buffer.from(rec.tokenHash, "hex");
    const b = Buffer.from(wantHash, "hex");
    if (a.length !== b.length) continue;
    if (!crypto.timingSafeEqual(a, b)) continue;
    if (now >= rec.expiresAt) {
      rec.status = "expired";
      await writeJson(p, rec);
      throw new ApprovalError("expired");
    }
    if (rec.payloadHash !== expectedPayloadHash) {
      throw new ApprovalError("payload_mismatch");
    }
    rec.status = "consumed";
    rec.consumedAt = now;
    await writeJson(p, rec);
    return rec;
  }
  throw new ApprovalError("token_invalid");
}

export class ApprovalError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "ApprovalError";
  }
}

/** Persist a dual-control policy onto a workspace record. */
export async function setDualControlPolicy(
  ws: WorkspaceRecord,
  operations: DualControlOperation[],
  updatedBy: string,
): Promise<WorkspaceRecord> {
  const unique = Array.from(new Set(operations.filter(isDualControlOperation))) as DualControlOperation[];
  unique.sort();
  const target = ws as unknown as { dualControl?: DualControlPolicy | null };
  if (unique.length === 0) {
    target.dualControl = null;
  } else {
    target.dualControl = { operations: unique, updatedAt: Date.now(), updatedBy };
  }
  // Re-use the same atomic write pattern as workspaces.ts. We read the
  // path-derivation here directly so we don't have to re-export it.
  const p = path.join(WORKSPACES_DIR, ws.id + ".json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(ws, null, 2) + "\n", "utf8");
  await fs.rename(tmp, p);
  return ws;
}
