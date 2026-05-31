/**
 * Magic-link authentication for codeclone.
 *
 * Storage: filesystem, matching the rest of the app.
 *   $CODECLONE_USERS_DIR/<userId>.json            user records
 *   $CODECLONE_USERS_DIR/_index/<emailHash>.json  email -> userId
 *   $CODECLONE_AUTH_LINKS_DIR/<id>.json           pending magic links (dev mailbox)
 *
 * Sessions are stateless HMAC-signed cookies keyed by CODECLONE_AUTH_SECRET.
 * A dev fallback secret is used when none is set so local dev "just works",
 * but production deployments must set the env var.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const CWD = process.cwd();

export const USERS_DIR = process.env.CODECLONE_USERS_DIR
  ? path.resolve(CWD, process.env.CODECLONE_USERS_DIR)
  : path.resolve(CWD, "..", "users");

export const AUTH_LINKS_DIR = process.env.CODECLONE_AUTH_LINKS_DIR
  ? path.resolve(CWD, process.env.CODECLONE_AUTH_LINKS_DIR)
  : path.resolve(CWD, "..", "runs", "magic-links");

export const COOKIE_NAME = "cc_session";
export const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
export const MAGIC_TTL_SEC = 60 * 15; // 15 minutes

const DEV_SECRET = "codeclone-dev-secret-not-for-production";

export function getSecret(): string {
  return process.env.CODECLONE_AUTH_SECRET || DEV_SECRET;
}

export function isProdSecret(): boolean {
  return Boolean(process.env.CODECLONE_AUTH_SECRET);
}

export interface UserRecord {
  v: 1;
  id: string;
  email: string;
  createdAt: number;
  lastLoginAt?: number;
}

export interface MagicLinkRecord {
  v: 1;
  id: string;
  email: string;
  hash: string; // sha-256 of secret
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
  redirectTo?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length < 3 || trimmed.length > 254) return null;
  if (!EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

function emailHash(email: string): string {
  return crypto.createHash("sha256").update(email).digest("hex").slice(0, 24);
}

function userIdFromEmail(email: string): string {
  // Deterministic, short, URL-safe.
  const h = crypto.createHash("sha256").update("u:" + email).digest("base64url");
  return "u_" + h.slice(0, 12);
}

/**
 * Compute the deterministic user id for a (normalized) email without
 * touching the filesystem or creating a user record. Lets callers check
 * membership-scoped policies before a sign-in side effect occurs.
 */
export function previewUserIdForEmail(email: string): string | null {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  return userIdFromEmail(norm);
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
  const tmp = p + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tmp, p);
}

export async function findOrCreateUser(email: string): Promise<UserRecord> {
  const id = userIdFromEmail(email);
  const userPath = path.join(USERS_DIR, id + ".json");
  const existing = await readJson<UserRecord>(userPath);
  if (existing) return existing;
  const rec: UserRecord = {
    v: 1,
    id,
    email,
    createdAt: Date.now(),
  };
  await writeJson(userPath, rec);
  // Index for reverse lookup (one-way: emailHash -> userId).
  await writeJson(path.join(USERS_DIR, "_index", emailHash(email) + ".json"), { id });
  return rec;
}

export async function getUser(id: string): Promise<UserRecord | null> {
  if (!/^u_[A-Za-z0-9_-]{6,32}$/.test(id)) return null;
  return readJson<UserRecord>(path.join(USERS_DIR, id + ".json"));
}

export async function touchLogin(id: string) {
  const u = await getUser(id);
  if (!u) return;
  u.lastLoginAt = Date.now();
  await writeJson(path.join(USERS_DIR, id + ".json"), u);
}

// ---------- Magic links ----------

export interface IssuedLink {
  id: string;
  url: string;
  secret: string;
  record: MagicLinkRecord;
}

export async function issueMagicLink(
  email: string,
  origin: string,
  redirectTo?: string,
): Promise<IssuedLink> {
  const id = crypto.randomBytes(8).toString("base64url");
  const secret = crypto.randomBytes(24).toString("base64url");
  const hash = crypto.createHash("sha256").update(secret).digest("hex");
  const now = Date.now();
  const rec: MagicLinkRecord = {
    v: 1,
    id,
    email,
    hash,
    createdAt: now,
    expiresAt: now + MAGIC_TTL_SEC * 1000,
    redirectTo,
  };
  await writeJson(path.join(AUTH_LINKS_DIR, id + ".json"), rec);
  const token = `${id}.${secret}`;
  const u = new URL("/api/auth/verify", origin);
  u.searchParams.set("token", token);
  if (redirectTo) u.searchParams.set("redirect", redirectTo);
  return { id, secret, url: u.toString(), record: rec };
}

export async function consumeMagicLink(token: string): Promise<UserRecord | null> {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [id, secret] = token.split(".", 2);
  if (!id || !secret) return null;
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(id)) return null;
  const p = path.join(AUTH_LINKS_DIR, id + ".json");
  const rec = await readJson<MagicLinkRecord>(p);
  if (!rec) return null;
  if (rec.consumedAt) return null;
  if (Date.now() > rec.expiresAt) return null;
  const want = crypto.createHash("sha256").update(secret).digest("hex");
  if (!safeEq(want, rec.hash)) return null;
  rec.consumedAt = Date.now();
  await writeJson(p, rec);
  const user = await findOrCreateUser(rec.email);
  await touchLogin(user.id);
  return user;
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------- Session cookies ----------

export interface SessionPayload {
  uid: string;
  iat: number;
  exp: number;
  jti?: string;
}

export function signSession(uid: string, ttlSec = SESSION_TTL_SEC, jti?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { uid, iat: now, exp: now + ttlSec };
  if (jti) payload.jti = jti;
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", getSecret())
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(cookie: string | undefined | null): SessionPayload | null {
  if (!cookie || typeof cookie !== "string" || !cookie.includes(".")) return null;
  const [body, sig] = cookie.split(".", 2);
  if (!body || !sig) return null;
  const expected = crypto
    .createHmac("sha256", getSecret())
    .update(body)
    .digest("base64url");
  if (!safeEq(sig, expected)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.uid !== "string" || typeof payload.exp !== "number") {
    return null;
  }
  if (Math.floor(Date.now() / 1000) >= payload.exp) return null;
  return payload;
}

export function sessionCookieAttributes(maxAgeSec = SESSION_TTL_SEC): string {
  // HttpOnly, Lax, Path=/. Secure only when explicitly enabled (so localhost works).
  const parts = [
    `Path=/`,
    `Max-Age=${maxAgeSec}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (process.env.CODECLONE_COOKIE_SECURE === "1") parts.push("Secure");
  return parts.join("; ");
}

export function clearedCookieAttributes(): string {
  const parts = [`Path=/`, `Max-Age=0`, `HttpOnly`, `SameSite=Lax`];
  if (process.env.CODECLONE_COOKIE_SECURE === "1") parts.push("Secure");
  return parts.join("; ");
}

export async function currentUserFromCookieHeader(
  cookieHeader: string | null | undefined,
): Promise<UserRecord | null> {
  const ctx = await currentSessionFromCookieHeader(cookieHeader);
  return ctx?.user ?? null;
}

export interface SessionContext {
  user: UserRecord;
  jti: string | null;
  payload: SessionPayload;
}

/**
 * Like currentUserFromCookieHeader but also returns the session id (jti)
 * and checks the server-side revocation list. Callers that need to revoke
 * the current session (signout) or pass it through audit logs should use
 * this.
 */
import { isRevoked as _isRevoked, getSession as _getSession } from "./sessions.ts";
import { effectiveSessionPolicyForUser } from "./workspaces.ts";

export async function currentSessionFromCookieHeader(
  cookieHeader: string | null | undefined,
): Promise<SessionContext | null> {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]+)`));
  if (!m) return null;
  const payload = verifySession(decodeURIComponent(m[1]));
  if (!payload) return null;
  let sessionRec: Awaited<ReturnType<typeof _getSession>> = null;
  if (payload.jti) {
    if (await _isRevoked(payload.jti)) return null;
    sessionRec = await _getSession(payload.uid, payload.jti);
    if (sessionRec && sessionRec.revokedAt) return null;
  }
  const user = await getUser(payload.uid);
  if (!user) return null;
  // Workspace-enforced session policy. Strictest non-zero value across all
  // workspaces the user belongs to. Owners can ratchet down session lifetimes
  // for everyone on the team without rotating cookies.
  const policy = await effectiveSessionPolicyForUser(user.id);
  const nowSec = Math.floor(Date.now() / 1000);
  if (policy.maxLifetimeSec > 0) {
    const createdAtSec = sessionRec ? Math.floor(sessionRec.createdAt / 1000) : payload.iat;
    if (nowSec - createdAtSec > policy.maxLifetimeSec) return null;
  }
  if (policy.idleTimeoutSec > 0) {
    const lastSeenSec = sessionRec ? Math.floor(sessionRec.lastSeenAt / 1000) : payload.iat;
    if (nowSec - lastSeenSec > policy.idleTimeoutSec) return null;
  }
  return { user, jti: payload.jti ?? null, payload };
}
