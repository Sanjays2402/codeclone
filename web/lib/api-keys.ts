/**
 * Filesystem-backed API key store.
 *
 * Each key is stored at $CODECLONE_KEYS_DIR/<id>.json (defaults to
 * ../api-keys relative to web/). We store only a SHA-256 hash of the
 * secret; the plaintext is returned exactly once at creation time.
 *
 * Schema is versioned via the `v` field. Records track usage count and
 * last-used timestamp so the UI can show meaningful activity.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { normalizeRpm } from "./rate-limit.ts";
import { sanitizeCidrList } from "./ip-allowlist.ts";
import { apiKeyPolicyDeadline, getWorkspace } from "./workspaces.ts";

const MIN_RPM_HINT = 1;

const CWD = process.cwd();

export const KEYS_DIR = process.env.CODECLONE_KEYS_DIR
  ? path.resolve(CWD, process.env.CODECLONE_KEYS_DIR)
  : path.resolve(CWD, "..", "api-keys");

const KEY_PREFIX = "cc_live_";
const SECRET_BYTES = 24; // 24 random bytes -> 32 base64url chars
const MAX_LABEL_LEN = 60;
const ID_LEN = 10;

/**
 * Canonical scope identifiers. A key is granted one or more scopes at
 * creation (or rotation) time; /v1 endpoints reject calls that present
 * a key missing the required scope. Legacy keys with no `scopes` field
 * are treated as fully privileged so older integrations keep working.
 */
export const ALL_SCOPES = [
  "compare:write",
  "batch:write",
  "shares:read",
  "shares:write",
  "usage:read",
  "audit:read",
  "webhooks:read",
  "webhooks:write",
  "members:read",
  "members:write",
  "export:read",
  "erasure:write",
  "snippets:read",
  "snippets:write",
  "keys:read",
  "keys:write",
  "collections:read",
  "collections:write",
  "sessions:read",
  "sessions:write",
  "runs:read",
  "allowlist:read",
  "allowlist:write",
  "lockdown:read",
  "lockdown:write",
] as const;
export type Scope = (typeof ALL_SCOPES)[number];

export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  "compare:write": "Call POST /v1/compare on two snippets.",
  "batch:write": "Call POST /v1/batch for bulk pairwise comparisons.",
  "shares:read": "List and fetch saved comparison results via /v1/shares.",
  "shares:write": "Delete saved comparison results via DELETE /v1/shares/:id.",
  "usage:read": "Read this workspace's /v1 usage and plan state via GET /v1/usage.",
  "audit:read": "Stream this workspace's audit log to a SIEM via GET /v1/audit.",
  "webhooks:read": "List and fetch this workspace's webhook endpoints via GET /v1/webhooks.",
  "webhooks:write": "Create and delete webhook endpoints via POST/DELETE /v1/webhooks.",
  "members:read": "List this workspace's members and their roles via GET /v1/members for IGA reconciliation.",
  "members:write": "Invite, change role, suspend, reinstate, or remove members via POST /v1/members and PATCH/DELETE /v1/members/:user_id. Caller must be an owner of the workspace.",
  "export:read": "Download this workspace's GDPR Article 20 data portability bundle via GET /v1/export.",
  "erasure:write": "Execute GDPR Article 17 (right to erasure) bulk deletion of this workspace's saved comparisons via POST /v1/erasure.",
  "snippets:read": "List and fetch the calling user's saved snippets via GET /v1/snippets and GET /v1/snippets/:id.",
  "snippets:write": "Create, update, and delete the calling user's saved snippets via POST/PATCH/DELETE /v1/snippets.",
  "keys:read": "List this workspace's API keys via GET /v1/keys for SOC2 key inventory and rotation tracking.",
  "keys:write": "Rotate, revoke, or edit this workspace's API keys via POST /v1/keys/:id/rotate, DELETE /v1/keys/:id, and PATCH /v1/keys/:id (narrow scopes, retune rpm, tighten ipAllowlist, shift expiresAt, rename) for automated SOC2 90-day rotation and continuous least-privilege.",
  "collections:read": "List and fetch this workspace's share collections via GET /v1/collections and GET /v1/collections/:id.",
  "collections:write": "Create, update, and delete this workspace's share collections via POST/PATCH/DELETE /v1/collections.",
  "sessions:read": "List active dashboard sessions for every member of this workspace via GET /v1/sessions for SecOps incident triage and SOC2 CC6.1 access reviews.",
  "sessions:write": "Revoke individual or all dashboard sessions for a member of this workspace via DELETE /v1/sessions/:jti and POST /v1/sessions/revoke-all for credential-compromise containment.",
  "runs:read": "Read training run metadata, hyperparameters, and per-step metrics via GET /v1/runs and GET /v1/runs/:id for MLflow / Weights & Biases / SIEM ingest.",
  "allowlist:read": "Read this workspace's IP CIDR allowlist via GET /v1/allowlist for SecOps compliance evidence and SIEM reconciliation.",
  "allowlist:write": "Replace, append, or clear this workspace's IP CIDR allowlist via PUT/POST/DELETE /v1/allowlist for SOAR-driven incident response (block attacker IPs, sync VPN egress ranges). Caller's API key must belong to a workspace owner.",
  "lockdown:read": "Read this workspace's break-glass lockdown status via GET /v1/lockdown for SOAR polling and SOC2 CC7.3 incident-response evidence.",
  "lockdown:write": "Place or release this workspace's break-glass lockdown via POST/DELETE /v1/lockdown so a SIEM-fired SOAR playbook can halt all /v1 traffic during a credential-compromise incident without a human dashboard login. Caller's API key must belong to a workspace owner.",
};

function normalizeScopes(input: unknown): Scope[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) return undefined;
  const valid = new Set<string>(ALL_SCOPES);
  const out = new Set<Scope>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const v = raw.trim().toLowerCase();
    if (valid.has(v)) out.add(v as Scope);
  }
  if (out.size === 0) return undefined;
  return [...out].sort();
}

export function hasScope(
  rec: { scopes?: string[] } | null | undefined,
  required: Scope,
): boolean {
  if (!rec) return false;
  // Legacy keys (no scopes recorded) keep working with full privileges.
  if (!Array.isArray(rec.scopes)) return true;
  return rec.scopes.includes(required);
}

export interface ApiKeyRecord {
  v: 1;
  id: string;
  label: string;
  prefix: string; // first 12 chars of the plaintext key, shown in UI
  hash: string; // sha-256 of the full plaintext key, hex
  createdAt: number;
  lastUsedAt?: number;
  usageCount: number;
  revoked?: boolean;
  userId?: string; // owning user; absent on legacy/unscoped records
  workspaceId?: string; // workspace this key is bound to; gates IP allowlist enforcement
  expiresAt?: number; // optional epoch ms; absent means never expires
  scopes?: Scope[]; // permission scopes; absent on legacy records = full access
  rateLimit?: { rpm: number }; // per-key requests-per-minute cap; absent = default
  ipAllowlist?: string[]; // per-key source IP CIDR allowlist; absent/empty = open
  /**
   * Ring buffer of recent source IPs that successfully used the key.
   * Bounded length so admins can spot leaked keys ("why is this key
   * being called from 3 countries?") without unbounded log growth.
   */
  recentIps?: RecentIp[];
}

export interface RecentIp {
  ip: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
}

/** Max distinct source IPs we keep per key. */
export const RECENT_IPS_LIMIT = 5;

export interface ApiKeySummary {
  id: string;
  label: string;
  prefix: string;
  createdAt: number;
  lastUsedAt?: number;
  usageCount: number;
  revoked?: boolean;
  userId?: string;
  workspaceId?: string;
  expiresAt?: number;
  expired?: boolean;
  scopes?: Scope[];
  rateLimit?: { rpm: number };
  ipAllowlist?: string[];
  recentIps?: RecentIp[];
}

const MAX_EXPIRES_DAYS = 365;

function normalizeExpiresInDays(input: unknown): number | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n)) return undefined;
  if (n <= 0) return undefined;
  const days = Math.min(Math.floor(n), MAX_EXPIRES_DAYS);
  return Date.now() + days * 24 * 60 * 60 * 1000;
}

function isExpired(rec: { expiresAt?: number }): boolean {
  return typeof rec.expiresAt === "number" && rec.expiresAt <= Date.now();
}

function isKeyId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9_-]{6,32}$/.test(id);
}

async function ensureDir() {
  await fs.mkdir(KEYS_DIR, { recursive: true });
}

function keyFile(id: string): string {
  return path.join(KEYS_DIR, `${id}.json`);
}

function sanitizeLabel(t: unknown): string {
  if (typeof t !== "string") return "Untitled key";
  const cleaned = t.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LEN);
  return cleaned || "Untitled key";
}

function hashKey(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

export function summarize(rec: ApiKeyRecord): ApiKeySummary {
  return {
    id: rec.id,
    label: rec.label,
    prefix: rec.prefix,
    createdAt: rec.createdAt,
    lastUsedAt: rec.lastUsedAt,
    usageCount: rec.usageCount,
    revoked: rec.revoked,
    userId: rec.userId,
    workspaceId: rec.workspaceId,
    expiresAt: rec.expiresAt,
    expired: isExpired(rec),
    scopes: rec.scopes,
    rateLimit: rec.rateLimit,
    ipAllowlist: Array.isArray(rec.ipAllowlist) && rec.ipAllowlist.length > 0 ? rec.ipAllowlist : undefined,
    recentIps: Array.isArray(rec.recentIps) && rec.recentIps.length > 0
      ? rec.recentIps.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      : undefined,
  };
}

export interface CreatedKey {
  record: ApiKeySummary;
  plaintext: string;
}

export interface CreateOptions {
  userId?: string;
  workspaceId?: string;
  expiresInDays?: unknown;
  scopes?: unknown;
  rpm?: unknown;
  ipAllowlist?: unknown;
}

export async function createKey(label: unknown, opts: CreateOptions = {}): Promise<CreatedKey> {
  await ensureDir();
  for (let attempt = 0; attempt < 4; attempt++) {
    const id = crypto.randomBytes(8).toString("base64url").slice(0, ID_LEN);
    const file = keyFile(id);
    try {
      await fs.access(file);
      continue;
    } catch {
      // free
    }
    const secret = crypto.randomBytes(SECRET_BYTES).toString("base64url");
    const plaintext = `${KEY_PREFIX}${secret}`;
    const rec: ApiKeyRecord = {
      v: 1,
      id,
      label: sanitizeLabel(label),
      prefix: plaintext.slice(0, 12),
      hash: hashKey(plaintext),
      createdAt: Date.now(),
      usageCount: 0,
    };
    if (opts.userId && typeof opts.userId === "string") {
      rec.userId = opts.userId;
    }
    if (opts.workspaceId && typeof opts.workspaceId === "string" && /^ws_[A-Za-z0-9_-]{6,32}$/.test(opts.workspaceId)) {
      rec.workspaceId = opts.workspaceId;
    }
    const exp = normalizeExpiresInDays(opts.expiresInDays);
    if (exp) rec.expiresAt = exp;
    // Workspace API key max-age policy clamp. If the workspace owner has
    // configured a maxAgeDays cap, the key's expiresAt is forced down to
    // createdAt + maxAgeDays. Applied even when the caller passes no
    // expiresInDays so policy is enforced by default for the entire
    // workspace, not opt-in per key.
    if (rec.workspaceId) {
      try {
        const ws = await getWorkspace(rec.workspaceId);
        const deadline = apiKeyPolicyDeadline(ws, rec.createdAt);
        if (deadline !== null) {
          rec.expiresAt = rec.expiresAt ? Math.min(rec.expiresAt, deadline) : deadline;
        }
      } catch {
        // Filesystem read failure: do not block key creation, but a missing
        // clamp here is still caught at /v1 request time by
        // enforceWorkspaceApiKeyPolicyForKey.
      }
    }
    const scopes = normalizeScopes(opts.scopes);
    if (scopes) rec.scopes = scopes;
    const rpm = normalizeRpm(opts.rpm);
    if (typeof rpm === "number") rec.rateLimit = { rpm };
    if (opts.ipAllowlist !== undefined && opts.ipAllowlist !== null) {
      const { ok } = sanitizeCidrList(opts.ipAllowlist);
      if (ok.length > 0) rec.ipAllowlist = ok;
    }
    await fs.writeFile(file, JSON.stringify(rec), "utf-8");
    return { record: summarize(rec), plaintext };
  }
  throw new Error("could not allocate api key id");
}

export async function loadKey(id: string): Promise<ApiKeyRecord | null> {
  if (!isKeyId(id)) return null;
  try {
    const buf = await fs.readFile(keyFile(id), "utf-8");
    const rec = JSON.parse(buf) as ApiKeyRecord;
    if (!rec || rec.v !== 1 || typeof rec.id !== "string") return null;
    return rec;
  } catch {
    return null;
  }
}

export interface RotatedKey {
  record: ApiKeySummary;
  plaintext: string;
}

/**
 * Issue a fresh secret for an existing key while preserving id, label,
 * createdAt, usageCount, lastUsedAt, owner and expiresAt. Returns the
 * new plaintext (shown to the caller exactly once). Refuses to rotate
 * revoked or expired keys, and refuses cross-user rotation when a
 * userId scope is supplied.
 */
export async function rotateKey(
  id: string,
  userId?: string,
): Promise<RotatedKey | null> {
  const rec = await loadKey(id);
  if (!rec) return null;
  if (userId !== undefined && rec.userId && rec.userId !== userId) return null;
  if (rec.revoked) return null;
  if (isExpired(rec)) return null;
  const secret = crypto.randomBytes(SECRET_BYTES).toString("base64url");
  const plaintext = `${KEY_PREFIX}${secret}`;
  rec.prefix = plaintext.slice(0, 12);
  rec.hash = hashKey(plaintext);
  await fs.writeFile(keyFile(id), JSON.stringify(rec), "utf-8");
  return { record: summarize(rec), plaintext };
}

/**
 * Mutate a non-secret field on an existing key. Currently supports
 * the per-key rate limit (rpm). Returns the updated summary, or null
 * if the key is missing or owned by a different user.
 */
export async function updateKey(
  id: string,
  patch: { rpm?: unknown; ipAllowlist?: unknown },
  userId?: string,
): Promise<{ summary: ApiKeySummary; rejectedCidrs: string[] } | null> {
  const rec = await loadKey(id);
  if (!rec) return null;
  if (userId !== undefined && rec.userId && rec.userId !== userId) return null;
  if ("rpm" in patch) {
    if (patch.rpm === null || patch.rpm === "" || patch.rpm === undefined) {
      delete rec.rateLimit;
    } else {
      const rpm = normalizeRpm(patch.rpm);
      if (typeof rpm !== "number") {
        throw new Error(`rpm must be an integer between ${MIN_RPM_HINT} and 100000`);
      }
      rec.rateLimit = { rpm };
    }
  }
  let rejectedCidrs: string[] = [];
  if ("ipAllowlist" in patch) {
    if (patch.ipAllowlist === null || patch.ipAllowlist === undefined) {
      delete rec.ipAllowlist;
    } else if (Array.isArray(patch.ipAllowlist) && patch.ipAllowlist.length === 0) {
      delete rec.ipAllowlist;
    } else {
      const { ok, rejected } = sanitizeCidrList(patch.ipAllowlist);
      rejectedCidrs = rejected;
      if (ok.length === 0) {
        throw new Error(
          `ipAllowlist contained no valid CIDR entries. Rejected: ${rejected.join(", ") || "(none)"}`,
        );
      }
      rec.ipAllowlist = ok;
    }
  }
  await fs.writeFile(keyFile(id), JSON.stringify(rec), "utf-8");
  return { summary: summarize(rec), rejectedCidrs };
}

/**
 * Tenant-scoped key update. Mutates non-secret, non-revocation fields
 * on an existing key while preserving id, prefix, hash, createdAt,
 * usageCount, lastUsedAt, owner, recentIps and workspace binding.
 *
 * Supported fields: `label`, `scopes` (narrowing only, never widening),
 * `rpm` (per-key rate-limit override; pass null to clear), `ipAllowlist`
 * (CIDR list; pass null/[] to clear), `expiresAt` (epoch ms; clamped to
 * the workspace API key max-age policy when set; null clears).
 *
 * Returns null when the id does not exist OR belongs to a different
 * workspace. Throws on bad input so the route can surface a 400.
 * Refuses to mutate a revoked or expired key (route returns 400).
 * `diff` is suitable for audit logging; `changed` is false when the
 * patch is a no-op.
 */
export interface UpdateKeyForWorkspaceInput {
  label?: unknown;
  scopes?: unknown;
  rpm?: unknown;
  ipAllowlist?: unknown;
  expiresAt?: unknown;
}

export interface UpdateKeyForWorkspaceResult {
  summary: ApiKeySummary;
  diff: {
    before: Partial<Pick<ApiKeySummary, "label" | "scopes" | "rateLimit" | "ipAllowlist" | "expiresAt">>;
    after: Partial<Pick<ApiKeySummary, "label" | "scopes" | "rateLimit" | "ipAllowlist" | "expiresAt">>;
  };
  changed: boolean;
  rejectedCidrs: string[];
}

export async function updateKeyForWorkspace(
  id: string,
  workspaceId: string,
  patch: UpdateKeyForWorkspaceInput,
): Promise<UpdateKeyForWorkspaceResult | null> {
  const rec = await loadKey(id);
  if (!rec) return null;
  if (rec.workspaceId !== workspaceId) return null;
  if (rec.revoked) throw new Error("Key is revoked and cannot be edited.");
  if (isExpired(rec)) throw new Error("Key is expired and cannot be edited.");

  const before: UpdateKeyForWorkspaceResult["diff"]["before"] = {};
  const after: UpdateKeyForWorkspaceResult["diff"]["after"] = {};
  let changed = false;
  let rejectedCidrs: string[] = [];

  if (patch.label !== undefined) {
    const label = sanitizeLabel(patch.label);
    if (label !== rec.label) {
      before.label = rec.label;
      after.label = label;
      rec.label = label;
      changed = true;
    }
  }

  if (patch.scopes !== undefined) {
    if (patch.scopes === null) {
      throw new Error(
        "scopes cannot be cleared. A null scopes field would silently widen this key to legacy full-privilege mode. Pass an array of scope strings instead.",
      );
    }
    const next = normalizeScopes(patch.scopes);
    if (!next) {
      throw new Error(
        "scopes must be a non-empty array of valid scope strings. Use GET /v1/keys/:id to see the current scope set.",
      );
    }
    // Narrowing-only: refuse to grant a scope the key does not
    // already hold. Legacy keys with no `scopes` field are full-
    // privilege; once narrowed they are pinned to the new set.
    const current = Array.isArray(rec.scopes) ? rec.scopes : (ALL_SCOPES as readonly Scope[]);
    const widened = next.filter((s) => !current.includes(s));
    if (widened.length > 0) {
      throw new Error(
        `scopes patch must narrow, not widen. Refused new scopes: ${widened.join(", ")}. Rotate or recreate the key to grant additional scopes.`,
      );
    }
    const curArr = Array.isArray(rec.scopes) ? rec.scopes.slice() : null;
    const sameLen = curArr ? curArr.length === next.length : false;
    const same = !!curArr && sameLen && next.every((s) => curArr.includes(s));
    if (!same) {
      before.scopes = curArr ?? undefined;
      after.scopes = next.slice();
      rec.scopes = next;
      changed = true;
    }
  }

  if (patch.rpm !== undefined) {
    const curRl = rec.rateLimit ? { ...rec.rateLimit } : undefined;
    if (patch.rpm === null || patch.rpm === "") {
      if (rec.rateLimit) {
        before.rateLimit = curRl;
        after.rateLimit = undefined;
        delete rec.rateLimit;
        changed = true;
      }
    } else {
      const rpm = normalizeRpm(patch.rpm);
      if (typeof rpm !== "number") {
        throw new Error(`rpm must be an integer between ${MIN_RPM_HINT} and 100000.`);
      }
      if (!curRl || curRl.rpm !== rpm) {
        before.rateLimit = curRl;
        after.rateLimit = { rpm };
        rec.rateLimit = { rpm };
        changed = true;
      }
    }
  }

  if (patch.ipAllowlist !== undefined) {
    const curList = Array.isArray(rec.ipAllowlist) && rec.ipAllowlist.length > 0
      ? rec.ipAllowlist.slice()
      : undefined;
    if (
      patch.ipAllowlist === null ||
      (Array.isArray(patch.ipAllowlist) && patch.ipAllowlist.length === 0)
    ) {
      if (curList) {
        before.ipAllowlist = curList;
        after.ipAllowlist = undefined;
        delete rec.ipAllowlist;
        changed = true;
      }
    } else {
      const { ok, rejected } = sanitizeCidrList(patch.ipAllowlist);
      rejectedCidrs = rejected;
      if (ok.length === 0) {
        throw new Error(
          `ipAllowlist contained no valid CIDR entries. Rejected: ${rejected.join(", ") || "(none)"}.`,
        );
      }
      const sameLen = curList ? curList.length === ok.length : false;
      const same = !!curList && sameLen && ok.every((c) => curList.includes(c));
      if (!same) {
        before.ipAllowlist = curList;
        after.ipAllowlist = ok.slice();
        rec.ipAllowlist = ok;
        changed = true;
      }
    }
  }

  if (patch.expiresAt !== undefined) {
    const curExp = rec.expiresAt;
    if (patch.expiresAt === null) {
      // Refuse to lift expiry when a workspace policy demands one.
      if (rec.workspaceId) {
        try {
          const ws = await getWorkspace(rec.workspaceId);
          const deadline = apiKeyPolicyDeadline(ws, rec.createdAt);
          if (deadline !== null) {
            throw new Error(
              "expiresAt cannot be cleared: workspace API key max-age policy requires an expiry.",
            );
          }
        } catch (e) {
          // Re-throw policy violation; swallow read failures.
          if (e instanceof Error && e.message.startsWith("expiresAt cannot be cleared")) {
            throw e;
          }
        }
      }
      if (curExp !== undefined) {
        before.expiresAt = curExp;
        after.expiresAt = undefined;
        delete rec.expiresAt;
        changed = true;
      }
    } else {
      const n = typeof patch.expiresAt === "number" ? patch.expiresAt : Number(patch.expiresAt);
      if (!Number.isFinite(n) || n <= Date.now()) {
        throw new Error("expiresAt must be a future epoch-ms timestamp.");
      }
      let next = Math.floor(n);
      // Clamp to workspace API key max-age policy.
      if (rec.workspaceId) {
        try {
          const ws = await getWorkspace(rec.workspaceId);
          const deadline = apiKeyPolicyDeadline(ws, rec.createdAt);
          if (deadline !== null) next = Math.min(next, deadline);
        } catch {
          // ignore read failures; /v1 request-time enforcement still applies.
        }
      }
      if (curExp !== next) {
        before.expiresAt = curExp;
        after.expiresAt = next;
        rec.expiresAt = next;
        changed = true;
      }
    }
  }

  if (changed) {
    await fs.writeFile(keyFile(id), JSON.stringify(rec), "utf-8");
  }
  return { summary: summarize(rec), diff: { before, after }, changed, rejectedCidrs };
}

export async function revokeKey(id: string, userId?: string): Promise<boolean> {
  const rec = await loadKey(id);
  if (!rec) return false;
  if (userId !== undefined && rec.userId && rec.userId !== userId) return false;
  if (rec.revoked) return true;
  rec.revoked = true;
  await fs.writeFile(keyFile(id), JSON.stringify(rec), "utf-8");
  return true;
}

export async function deleteKey(id: string, userId?: string): Promise<boolean> {
  if (userId !== undefined) {
    const rec = await loadKey(id);
    if (!rec) return false;
    if (rec.userId && rec.userId !== userId) return false;
  }
  if (!isKeyId(id)) return false;
  try {
    await fs.unlink(keyFile(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Tenant-scoped key listing. Returns only keys bound to the given
 * workspaceId. Used by /v1/keys so a key minted in workspace A can
 * never enumerate keys from workspace B even if both live on the
 * same store.
 */
export async function listKeysForWorkspace(workspaceId: string): Promise<ApiKeySummary[]> {
  await ensureDir();
  let names: string[];
  try {
    names = await fs.readdir(KEYS_DIR);
  } catch {
    return [];
  }
  const out: ApiKeySummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!isKeyId(id)) continue;
    const rec = await loadKey(id);
    if (!rec) continue;
    if (rec.workspaceId !== workspaceId) continue;
    out.push(summarize(rec));
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/**
 * Tenant-scoped key fetch. Returns null when the id does not exist OR
 * belongs to a different workspace. The route surfaces both as 404 so
 * a caller cannot probe for the existence of another tenant's key id.
 */
export async function loadKeyForWorkspace(
  id: string,
  workspaceId: string,
): Promise<ApiKeyRecord | null> {
  const rec = await loadKey(id);
  if (!rec) return null;
  if (rec.workspaceId !== workspaceId) return null;
  return rec;
}

/**
 * Tenant-scoped key rotation. Returns null when the id does not exist,
 * belongs to a different workspace, is revoked, or is expired. Never
 * leaks information about keys outside the calling workspace.
 */
export async function rotateKeyForWorkspace(
  id: string,
  workspaceId: string,
): Promise<RotatedKey | null> {
  const rec = await loadKey(id);
  if (!rec) return null;
  if (rec.workspaceId !== workspaceId) return null;
  if (rec.revoked) return null;
  if (isExpired(rec)) return null;
  const secret = crypto.randomBytes(SECRET_BYTES).toString("base64url");
  const plaintext = `${KEY_PREFIX}${secret}`;
  rec.prefix = plaintext.slice(0, 12);
  rec.hash = hashKey(plaintext);
  await fs.writeFile(keyFile(id), JSON.stringify(rec), "utf-8");
  return { record: summarize(rec), plaintext };
}

/**
 * Tenant-scoped key revocation. Returns true when the key was found
 * within the workspace and is now revoked (idempotent: already-revoked
 * keys return true). Returns false when the id does not exist or
 * belongs to a different workspace.
 */
export async function revokeKeyForWorkspace(
  id: string,
  workspaceId: string,
): Promise<boolean> {
  const rec = await loadKey(id);
  if (!rec) return false;
  if (rec.workspaceId !== workspaceId) return false;
  if (rec.revoked) return true;
  rec.revoked = true;
  await fs.writeFile(keyFile(id), JSON.stringify(rec), "utf-8");
  return true;
}

export async function listKeys(userId?: string): Promise<ApiKeySummary[]> {
  await ensureDir();
  let names: string[];
  try {
    names = await fs.readdir(KEYS_DIR);
  } catch {
    return [];
  }
  const out: ApiKeySummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!isKeyId(id)) continue;
    const rec = await loadKey(id);
    if (!rec) continue;
    if (userId !== undefined) {
      // Scoped listing: only owned records, never legacy/unowned.
      if (rec.userId !== userId) continue;
    }
    out.push(summarize(rec));
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/**
 * Look up a key by its plaintext value. Returns the matching record only
 * when not revoked. Uses constant-time comparison on the hash.
 */
export async function findByPlaintext(plain: string): Promise<ApiKeyRecord | null> {
  if (typeof plain !== "string" || !plain.startsWith(KEY_PREFIX)) return null;
  await ensureDir();
  let names: string[];
  try {
    names = await fs.readdir(KEYS_DIR);
  } catch {
    return null;
  }
  const target = hashKey(plain);
  const targetBuf = Buffer.from(target, "hex");
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!isKeyId(id)) continue;
    const rec = await loadKey(id);
    if (!rec || rec.revoked) continue;
    if (isExpired(rec)) continue;
    const recBuf = Buffer.from(rec.hash, "hex");
    if (recBuf.length !== targetBuf.length) continue;
    if (crypto.timingSafeEqual(recBuf, targetBuf)) return rec;
  }
  return null;
}

/**
 * Record a successful API call against a key. Best-effort: failures are
 * swallowed so a write hiccup never blocks a 200 response.
 *
 * When `sourceIp` is supplied we maintain a small ring buffer of the
 * most-recently-seen source IPs (up to RECENT_IPS_LIMIT) so admins
 * can audit where a key has been used from. Useful for spotting a
 * leaked key calling from an unexpected network.
 */
export async function recordUse(id: string, sourceIp?: string | null): Promise<void> {
  try {
    const rec = await loadKey(id);
    if (!rec) return;
    rec.usageCount = (rec.usageCount ?? 0) + 1;
    const now = Date.now();
    rec.lastUsedAt = now;
    const ip = typeof sourceIp === "string" ? sourceIp.trim() : "";
    if (ip) {
      const list: RecentIp[] = Array.isArray(rec.recentIps) ? rec.recentIps.slice() : [];
      const existing = list.find((e) => e && e.ip === ip);
      if (existing) {
        existing.lastSeenAt = now;
        existing.count = (existing.count ?? 0) + 1;
      } else {
        list.push({ ip, firstSeenAt: now, lastSeenAt: now, count: 1 });
      }
      // Keep only the most-recently-seen RECENT_IPS_LIMIT distinct IPs.
      list.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      rec.recentIps = list.slice(0, RECENT_IPS_LIMIT);
    }
    await fs.writeFile(keyFile(id), JSON.stringify(rec), "utf-8");
  } catch {
    // ignore
  }
}

export function extractBearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!h) {
    // also accept x-api-key for curl convenience
    const x = req.headers.get("x-api-key");
    return x && x.trim() ? x.trim() : null;
  }
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}
