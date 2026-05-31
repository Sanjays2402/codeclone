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
  /**
   * Tamper-evident hash chain fields. `seq` is a per-day monotonic counter
   * starting at 1. `prevHash` is the sha256 hex of the previous entry in the
   * chain (the last entry of the previous day for seq=1, otherwise the prior
   * entry of the same day). `hash` is sha256 over the canonical JSON of the
   * entry with `hash` itself excluded. Verifying these fields against the
   * stored JSONL detects any insertion, deletion, or edit by an operator with
   * raw file access. Older entries written before this field existed are
   * treated as legacy (verify reports `legacy: true`).
   */
  seq?: number;
  prevHash?: string;
  hash?: string;
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

/**
 * Canonical JSON: sorts object keys recursively so the hash is stable across
 * runtimes and key-insertion orders. Arrays preserve order. Used as the input
 * to the sha256 chain hash. Excludes the `hash` field itself by convention.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => k !== "hash").sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]))
      .join(",") +
    "}"
  );
}

function hashEntry(entry: AuditEntry): string {
  return crypto.createHash("sha256").update(canonicalize(entry)).digest("hex");
}

const GENESIS_HASH = "0".repeat(64);

async function readLastChainState(
  beforeDay: string,
): Promise<{ prevHash: string; lastDay: string | null }> {
  // Find most recent prior day file and read its tail line for chain link.
  let files: string[];
  try {
    files = (await fs.readdir(AUDIT_DIR))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.replace(".jsonl", ""))
      .filter((d) => d < beforeDay)
      .sort();
  } catch {
    return { prevHash: GENESIS_HASH, lastDay: null };
  }
  for (let i = files.length - 1; i >= 0; i--) {
    const day = files[i]!;
    const raw = await fs.readFile(pathForDay(day), "utf8").catch(() => "");
    const lines = raw.split("\n").filter(Boolean);
    for (let j = lines.length - 1; j >= 0; j--) {
      try {
        const e = JSON.parse(lines[j]!) as AuditEntry;
        if (e.hash) return { prevHash: e.hash, lastDay: day };
      } catch {
        continue;
      }
    }
  }
  return { prevHash: GENESIS_HASH, lastDay: null };
}

async function readTodayChainTail(
  day: string,
): Promise<{ prevHash: string | null; seq: number }> {
  // Returns the last hash + seq for `day`, or null if no chained entries today.
  const raw = await fs.readFile(pathForDay(day), "utf8").catch(() => "");
  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]!) as AuditEntry;
      if (e.hash && typeof e.seq === "number") {
        return { prevHash: e.hash, seq: e.seq };
      }
    } catch {
      continue;
    }
  }
  return { prevHash: null, seq: 0 };
}

// Serialize appends so concurrent recordAudit calls produce a valid chain.
let writeChain: Promise<unknown> = Promise.resolve();

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
  const day = dayKey(ts);
  const baseEntry: AuditEntry = {
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

  const run = writeChain.then(async () => {
    const tail = await readTodayChainTail(day);
    let prevHash: string;
    let seq: number;
    if (tail.prevHash) {
      prevHash = tail.prevHash;
      seq = tail.seq + 1;
    } else {
      const prior = await readLastChainState(day);
      prevHash = prior.prevHash;
      seq = 1;
    }
    const entry: AuditEntry = { ...baseEntry, seq, prevHash };
    entry.hash = hashEntry(entry);
    await fs.appendFile(pathForDay(day), JSON.stringify(entry) + "\n", "utf8");
    return entry;
  });
  // Keep chain serial but don't poison it on errors.
  writeChain = run.catch(() => undefined);
  return run;
}

export interface VerifyResult {
  ok: boolean;
  totalEntries: number;
  chainedEntries: number;
  legacyEntries: number;
  brokenAt: { day: string; seq: number; id: string; reason: string } | null;
  firstDay: string | null;
  lastDay: string | null;
  lastHash: string | null;
}

/**
 * Walk every audit file in order and verify each entry's hash matches
 * sha256(canonical(entry-without-hash)) and that prevHash matches the prior
 * entry's hash. Legacy entries without `hash` are counted but not chained;
 * verify still succeeds as long as all chained entries are intact.
 */
export async function verifyAuditChain(): Promise<VerifyResult> {
  await ensureDir(AUDIT_DIR);
  let files: string[] = [];
  try {
    files = (await fs.readdir(AUDIT_DIR))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
  } catch {
    return {
      ok: true,
      totalEntries: 0,
      chainedEntries: 0,
      legacyEntries: 0,
      brokenAt: null,
      firstDay: null,
      lastDay: null,
      lastHash: null,
    };
  }
  let prevHash = GENESIS_HASH;
  let total = 0;
  let chained = 0;
  let legacy = 0;
  let lastChainedHash: string | null = null;
  let firstDay: string | null = null;
  let lastDay: string | null = null;
  let dayLocalSeq = 0;
  let dayCursor: string | null = null;
  for (const f of files) {
    const day = f.replace(".jsonl", "");
    if (!firstDay) firstDay = day;
    lastDay = day;
    if (day !== dayCursor) {
      dayCursor = day;
      dayLocalSeq = 0;
    }
    const raw = await fs.readFile(path.join(AUDIT_DIR, f), "utf8").catch(() => "");
    const lines = raw.split("\n").filter(Boolean);
    for (const line of lines) {
      total++;
      let entry: AuditEntry;
      try {
        entry = JSON.parse(line) as AuditEntry;
      } catch {
        return {
          ok: false,
          totalEntries: total,
          chainedEntries: chained,
          legacyEntries: legacy,
          brokenAt: { day, seq: -1, id: "?", reason: "invalid_json" },
          firstDay,
          lastDay,
          lastHash: lastChainedHash,
        };
      }
      if (!entry.hash || typeof entry.seq !== "number") {
        legacy++;
        continue;
      }
      dayLocalSeq++;
      if (entry.seq !== dayLocalSeq) {
        return {
          ok: false,
          totalEntries: total,
          chainedEntries: chained,
          legacyEntries: legacy,
          brokenAt: {
            day,
            seq: entry.seq,
            id: entry.id,
            reason: `seq_out_of_order expected ${dayLocalSeq}`,
          },
          firstDay,
          lastDay,
          lastHash: lastChainedHash,
        };
      }
      if (entry.prevHash !== prevHash) {
        return {
          ok: false,
          totalEntries: total,
          chainedEntries: chained,
          legacyEntries: legacy,
          brokenAt: { day, seq: entry.seq, id: entry.id, reason: "prev_hash_mismatch" },
          firstDay,
          lastDay,
          lastHash: lastChainedHash,
        };
      }
      const expected = hashEntry(entry);
      if (expected !== entry.hash) {
        return {
          ok: false,
          totalEntries: total,
          chainedEntries: chained,
          legacyEntries: legacy,
          brokenAt: { day, seq: entry.seq, id: entry.id, reason: "hash_mismatch" },
          firstDay,
          lastDay,
          lastHash: lastChainedHash,
        };
      }
      chained++;
      prevHash = entry.hash;
      lastChainedHash = entry.hash;
    }
  }
  return {
    ok: true,
    totalEntries: total,
    chainedEntries: chained,
    legacyEntries: legacy,
    brokenAt: null,
    firstDay,
    lastDay,
    lastHash: lastChainedHash,
  };
}

export const _internals = { hashEntry, canonicalize, GENESIS_HASH };


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
