/**
 * Audit log for codeclone.
 *
 * Every mutating API route records an immutable, append-only audit entry so
 * workspace owners can review who did what, when, and from where. Designed for
 * enterprise procurement reviews (SOC2-style trail).
 *
 * Storage: append-only JSONL, one file per UTC day.
 *   $CODECLONE_AUDIT_DIR/YYYY-MM-DD.jsonl
 *
 * Entries are never updated or deleted via the API. Listing reads newest-first
 * with optional filters (actor, action, target, workspace, date range).
 *
 * Routes call `recordAudit(req, { action, target, ... })` after a successful
 * mutation. Helpers also pull workspaceId from the X-Workspace-Id header /
 * cookie when present so cross-tenant filtering works.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const CWD = process.cwd();

export const AUDIT_DIR = process.env.CODECLONE_AUDIT_DIR
  ? path.resolve(CWD, process.env.CODECLONE_AUDIT_DIR)
  : path.resolve(CWD, "..", "audit");

export const MAX_DIFF_BYTES = 8 * 1024;
export const MAX_LIST = 500;

const ACTION_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,3}$/;

export interface AuditEntry {
  v: 1;
  id: string;
  ts: number;
  actorId: string | null;
  actorEmail: string | null;
  workspaceId: string | null;
  action: string; // e.g. "snippet.create", "api_key.revoke"
  target: { type: string; id?: string; label?: string } | null;
  status: "ok" | "denied" | "error";
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  diff?: { before?: unknown; after?: unknown } | null;
  meta?: Record<string, unknown> | null;
}

export interface RecordAuditInput {
  action: string;
  target?: { type: string; id?: string; label?: string } | null;
  status?: "ok" | "denied" | "error";
  diff?: { before?: unknown; after?: unknown } | null;
  meta?: Record<string, unknown> | null;
  workspaceId?: string | null;
  actorId?: string | null;
  actorEmail?: string | null;
}

export class AuditError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

function pathForDay(day: string): string {
  return path.join(AUDIT_DIR, `${day}.jsonl`);
}

function trimDiff(diff: { before?: unknown; after?: unknown } | null | undefined) {
  if (!diff) return null;
  try {
    const s = JSON.stringify(diff);
    if (s.length <= MAX_DIFF_BYTES) return diff;
    return { truncated: true, bytes: s.length };
  } catch {
    return { truncated: true };
  }
}

function getHeader(req: Request | undefined, name: string): string | null {
  if (!req) return null;
  const v = req.headers.get(name);
  return v ? v.slice(0, 512) : null;
}

function clientIp(req: Request | undefined): string | null {
  if (!req) return null;
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]!.trim().slice(0, 64);
  const real = req.headers.get("x-real-ip");
  if (real) return real.slice(0, 64);
  return null;
}

export async function recordAudit(
  req: Request | undefined,
  input: RecordAuditInput,
): Promise<AuditEntry> {
  if (!input || typeof input.action !== "string" || !ACTION_RE.test(input.action)) {
    throw new AuditError("audit: invalid action", 400);
  }
  if (input.target != null) {
    if (typeof input.target !== "object" || typeof input.target.type !== "string") {
      throw new AuditError("audit: invalid target", 400);
    }
  }
  await ensureDir(AUDIT_DIR);
  const ts = Date.now();
  const entry: AuditEntry = {
    v: 1,
    id: crypto.randomUUID(),
    ts,
    actorId: input.actorId ?? null,
    actorEmail: input.actorEmail ?? null,
    workspaceId: input.workspaceId ?? getHeader(req, "x-workspace-id"),
    action: input.action,
    target: input.target ?? null,
    status: input.status ?? "ok",
    ip: clientIp(req),
    userAgent: getHeader(req, "user-agent"),
    requestId: getHeader(req, "x-request-id"),
    diff: trimDiff(input.diff) as AuditEntry["diff"],
    meta: input.meta ?? null,
  };
  const file = pathForDay(dayKey(ts));
  await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

export interface ListAuditOptions {
  actorId?: string;
  workspaceId?: string;
  /**
   * Tenant scoping. When provided, only entries whose workspaceId is in the
   * set are returned. Entries with a null workspaceId are also returned only
   * if the caller is also the actor (for example, sign-in events that have no
   * workspace context). This is the primary cross-tenant isolation guard for
   * the audit log read path; routes must pass this for any signed-in caller
   * that is not a platform admin.
   */
  allowedWorkspaceIds?: Set<string>;
  /** Used together with allowedWorkspaceIds to admit a user's own null-workspace events. */
  selfActorId?: string;
  action?: string; // exact match or prefix with trailing "."
  targetType?: string;
  targetId?: string;
  status?: "ok" | "denied" | "error";
  since?: number; // ms epoch
  until?: number; // ms epoch
  limit?: number;
}

export async function listAudit(opts: ListAuditOptions = {}): Promise<AuditEntry[]> {
  await ensureDir(AUDIT_DIR);
  const limit = Math.min(Math.max(1, opts.limit ?? 100), MAX_LIST);
  let files: string[];
  try {
    files = (await fs.readdir(AUDIT_DIR))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse();
  } catch {
    return [];
  }
  const out: AuditEntry[] = [];
  const sinceDay = opts.since ? dayKey(opts.since) : null;
  for (const f of files) {
    const day = f.replace(".jsonl", "");
    if (sinceDay && day < sinceDay) break;
    const abs = path.join(AUDIT_DIR, f);
    let raw: string;
    try {
      raw = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: AuditEntry;
      try {
        entry = JSON.parse(lines[i]!) as AuditEntry;
      } catch {
        continue;
      }
      if (opts.actorId && entry.actorId !== opts.actorId) continue;
      if (opts.workspaceId && entry.workspaceId !== opts.workspaceId) continue;
      if (opts.allowedWorkspaceIds) {
        if (entry.workspaceId) {
          if (!opts.allowedWorkspaceIds.has(entry.workspaceId)) continue;
        } else {
          // null workspace: only visible to the actor themself
          if (!opts.selfActorId || entry.actorId !== opts.selfActorId) continue;
        }
      }
      if (opts.action) {
        if (opts.action.endsWith(".")) {
          if (!entry.action.startsWith(opts.action)) continue;
        } else if (entry.action !== opts.action) {
          continue;
        }
      }
      if (opts.targetType && entry.target?.type !== opts.targetType) continue;
      if (opts.targetId && entry.target?.id !== opts.targetId) continue;
      if (opts.status && entry.status !== opts.status) continue;
      if (opts.since && entry.ts < opts.since) continue;
      if (opts.until && entry.ts > opts.until) continue;
      out.push(entry);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function toCsv(entries: AuditEntry[]): string {
  const header = [
    "ts",
    "id",
    "actorId",
    "actorEmail",
    "workspaceId",
    "action",
    "targetType",
    "targetId",
    "status",
    "ip",
  ];
  const esc = (v: unknown) => {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const rows = entries.map((e) =>
    [
      new Date(e.ts).toISOString(),
      e.id,
      e.actorId,
      e.actorEmail,
      e.workspaceId,
      e.action,
      e.target?.type,
      e.target?.id,
      e.status,
      e.ip,
    ]
      .map(esc)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

/** Safe variant: never throws. Routes can fire-and-forget without risking a 500. */
export async function tryRecordAudit(
  req: Request | undefined,
  input: RecordAuditInput,
): Promise<void> {
  try {
    await recordAudit(req, input);
  } catch {
    // Audit failure must not break the request. Errors are swallowed.
  }
}
