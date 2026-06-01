/**
 * Server-side session tracking for codeclone.
 *
 * Cookies remain stateless HMAC tokens (see lib/auth.ts) but now carry a
 * `jti` (session id). Each issued session is also persisted on disk so we
 * can:
 *   - list a user's active sessions (settings UI),
 *   - revoke a single session (other device),
 *   - revoke ALL sessions for a user (force logout everywhere),
 *   - record last-seen IP / user agent / timestamp.
 *
 * Storage:
 *   $CODECLONE_SESSIONS_DIR/<userId>/<jti>.json   one file per session
 *   $CODECLONE_SESSIONS_DIR/_revoked/<jti>.json   tombstone (small)
 *
 * Legacy cookies (no jti) issued before this feature still verify, but
 * cannot be listed or revoked individually. They expire on their own.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const CWD = process.cwd();

export const SESSIONS_DIR = process.env.CODECLONE_SESSIONS_DIR
  ? path.resolve(CWD, process.env.CODECLONE_SESSIONS_DIR)
  : path.resolve(CWD, "..", "sessions");

export const MIN_TTL_SEC = 60 * 60; // 1 hour
export const MAX_TTL_SEC = 60 * 60 * 24 * 90; // 90 days
export const DEFAULT_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

export interface SessionRecord {
  v: 1;
  jti: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
  // sticky label so UI can show "Created from <IP>"; helpful when IP changes.
  createdIp: string | null;
  createdUserAgent: string | null;
  revokedAt?: number;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
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
  const tmp = p + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tmp, p);
}

function userDir(userId: string): string {
  return path.join(SESSIONS_DIR, encodeURIComponent(userId));
}

function sessionPath(userId: string, jti: string): string {
  return path.join(userDir(userId), `${jti}.json`);
}

function revokedPath(jti: string): string {
  return path.join(SESSIONS_DIR, "_revoked", `${jti}.json`);
}

export function newJti(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export function clientIpFromHeaders(h: Headers): string | null {
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return h.get("x-real-ip") || null;
}

export interface CreateSessionInput {
  userId: string;
  jti: string;
  ttlSec: number;
  ip: string | null;
  userAgent: string | null;
}

export async function createSession(input: CreateSessionInput): Promise<SessionRecord> {
  const now = Date.now();
  const rec: SessionRecord = {
    v: 1,
    jti: input.jti,
    userId: input.userId,
    createdAt: now,
    expiresAt: now + input.ttlSec * 1000,
    lastSeenAt: now,
    ip: input.ip,
    userAgent: input.userAgent,
    createdIp: input.ip,
    createdUserAgent: input.userAgent,
  };
  await writeJson(sessionPath(input.userId, input.jti), rec);
  return rec;
}

export async function getSession(userId: string, jti: string): Promise<SessionRecord | null> {
  return readJson<SessionRecord>(sessionPath(userId, jti));
}

export async function isRevoked(jti: string): Promise<boolean> {
  try {
    await fs.access(revokedPath(jti));
    return true;
  } catch {
    return false;
  }
}

export async function touchSession(
  userId: string,
  jti: string,
  ip: string | null,
  userAgent: string | null,
): Promise<void> {
  const rec = await getSession(userId, jti);
  if (!rec) return;
  // Throttle: only rewrite if >60s since last touch, or IP/UA changed.
  const now = Date.now();
  if (
    now - rec.lastSeenAt < 60_000 &&
    rec.ip === ip &&
    rec.userAgent === userAgent
  ) {
    return;
  }
  rec.lastSeenAt = now;
  rec.ip = ip;
  rec.userAgent = userAgent;
  try {
    await writeJson(sessionPath(userId, jti), rec);
  } catch {
    // best-effort; never fail a request because of telemetry
  }
}

export async function listSessions(userId: string): Promise<SessionRecord[]> {
  const dir = userDir(userId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: SessionRecord[] = [];
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const rec = await readJson<SessionRecord>(path.join(dir, name));
    if (!rec) continue;
    if (rec.expiresAt <= now) continue;
    if (await isRevoked(rec.jti)) continue;
    out.push(rec);
  }
  out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return out;
}

export async function revokeSession(userId: string, jti: string): Promise<boolean> {
  const rec = await getSession(userId, jti);
  if (!rec) return false;
  rec.revokedAt = Date.now();
  await writeJson(sessionPath(userId, jti), rec);
  await writeJson(revokedPath(jti), { jti, userId, revokedAt: rec.revokedAt });
  return true;
}

export async function revokeAllSessions(
  userId: string,
  opts: { exceptJti?: string } = {},
): Promise<number> {
  const sessions = await listSessions(userId);
  let n = 0;
  for (const s of sessions) {
    if (opts.exceptJti && s.jti === opts.exceptJti) continue;
    if (await revokeSession(userId, s.jti)) n += 1;
  }
  return n;
}

/**
 * Find the userId that owns a given session id by scanning the
 * sessions store. Returns null if the session is unknown, expired, or
 * already revoked. Used by /v1/sessions/[jti] to resolve a workspace
 * member's session for tenant-scoped revoke without trusting any
 * userId from the request body.
 */
export async function findSessionOwner(jti: string): Promise<{ userId: string; record: SessionRecord } | null> {
  if (!jti || typeof jti !== "string") return null;
  if (await isRevoked(jti)) return null;
  let userDirs: string[];
  try {
    userDirs = await fs.readdir(SESSIONS_DIR);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  for (const enc of userDirs) {
    if (enc.startsWith("_")) continue; // skip _revoked/
    const userId = decodeURIComponent(enc);
    const p = sessionPath(userId, jti);
    const rec = await readJson<SessionRecord>(p);
    if (rec && rec.expiresAt > Date.now() && !rec.revokedAt) {
      return { userId, record: rec };
    }
  }
  return null;
}

export function clampTtl(ttlSec: number): number {
  if (!Number.isFinite(ttlSec)) return DEFAULT_TTL_SEC;
  return Math.max(MIN_TTL_SEC, Math.min(MAX_TTL_SEC, Math.floor(ttlSec)));
}

/**
 * Per-user TTL preference stored alongside sessions.
 */
function ttlPath(userId: string): string {
  return path.join(userDir(userId), "_ttl.json");
}

export async function getUserTtl(userId: string): Promise<number> {
  const rec = await readJson<{ ttlSec: number }>(ttlPath(userId));
  if (!rec || typeof rec.ttlSec !== "number") return DEFAULT_TTL_SEC;
  return clampTtl(rec.ttlSec);
}

export async function setUserTtl(userId: string, ttlSec: number): Promise<number> {
  const clamped = clampTtl(ttlSec);
  await writeJson(ttlPath(userId), { ttlSec: clamped, updatedAt: Date.now() });
  return clamped;
}

/**
 * Enforce a concurrent-session cap for a user.
 *
 * After persisting a brand-new session, the caller invokes this with the
 * owner-configured cap (the strictest non-zero value across the user's
 * workspaces; see `effectiveSessionPolicyForUser`). If the total number of
 * active sessions exceeds the cap, the oldest sessions (by `createdAt`,
 * tie-broken by `jti` for determinism) are revoked one by one until the
 * count drops to the cap. The just-issued session is always preserved by
 * passing its `jti` as `keepJti`.
 *
 * Returns the list of evicted SessionRecords so the caller can audit them.
 * Pass cap <= 0 to mean "no cap" - this is a no-op.
 *
 * Note: cross-tenant isolation is preserved by construction. Sessions are
 * stored under the user's own directory and listed/revoked per userId, so
 * a workspace-scoped cap can never reach into another user's sessions.
 */
export async function enforceConcurrentSessionCap(
  userId: string,
  cap: number,
  keepJti: string,
): Promise<SessionRecord[]> {
  if (!Number.isFinite(cap) || cap <= 0) return [];
  const active = await listSessions(userId);
  if (active.length <= cap) return [];
  // Oldest first; if multiple sessions share a createdAt the jti acts as a
  // stable tie-breaker so the same set is evicted regardless of fs order.
  const ordered = [...active].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.jti < b.jti ? -1 : a.jti > b.jti ? 1 : 0;
  });
  const evicted: SessionRecord[] = [];
  // We need to evict (active.length - cap) entries. Never touch keepJti.
  let toEvict = active.length - cap;
  for (const s of ordered) {
    if (toEvict <= 0) break;
    if (s.jti === keepJti) continue;
    if (s.revokedAt) continue;
    if (await revokeSession(userId, s.jti)) {
      evicted.push(s);
      toEvict -= 1;
    }
  }
  return evicted;
}
