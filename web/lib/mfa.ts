/**
 * TOTP-based MFA (step-up auth) for codeclone.
 *
 * Implements RFC 6238 / RFC 4226 with SHA-1, 6 digits, 30-second period.
 * No external dependencies (uses node:crypto).
 *
 * Storage: filesystem, alongside the rest of the app.
 *   $CODECLONE_MFA_DIR/<userId>.json         per-user TOTP record
 *   $CODECLONE_MFA_DIR/_stepup/<jti>.json    step-up grants for a session
 *
 * A user may have either:
 *   - no record: MFA disabled
 *   - a record with `pending` set: enrollment started, not yet confirmed
 *   - a record with `enrolledAt`: MFA active, requires verification for
 *     gated routes
 *
 * Backup codes are single-use; storing only sha-256 hashes.
 *
 * The step-up grant model: when a user successfully verifies a TOTP code
 * for their current session, we record a grant (keyed by session jti)
 * that lasts STEPUP_TTL_SEC. Gated routes call `requireStepUp(jti)` and
 * reject with 401 + { error: "mfa_required" } if no fresh grant exists.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const CWD = process.cwd();

export const MFA_DIR = process.env.CODECLONE_MFA_DIR
  ? path.resolve(CWD, process.env.CODECLONE_MFA_DIR)
  : path.resolve(CWD, "..", "mfa");

export const PERIOD_SEC = 30;
export const DIGITS = 6;
export const WINDOW = 1; // accept current +/- 1 step
export const STEPUP_TTL_SEC = 5 * 60; // 5 minutes
export const BACKUP_CODE_COUNT = 10;
const ENROLL_TTL_SEC = 10 * 60;

const ISSUER = "codeclone";

export interface MfaRecord {
  v: 1;
  userId: string;
  secret: string; // base32, plaintext (server-side only)
  enrolledAt?: number;
  pending?: { createdAt: number };
  backupCodeHashes: string[];
  lastUsedStep?: number; // prevents replay within the same 30s window
}

export interface StepUpGrant {
  v: 1;
  jti: string;
  userId: string;
  grantedAt: number;
  expiresAt: number;
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
  const tmp = p + ".tmp." + crypto.randomBytes(4).toString("hex");
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tmp, p);
}

function recordPath(userId: string) {
  return path.join(MFA_DIR, userId + ".json");
}

function grantPath(jti: string) {
  return path.join(MFA_DIR, "_stepup", jti + ".json");
}

// ---- base32 (RFC 4648, no padding for display) ----
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, "").toUpperCase().replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 character.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---- HOTP / TOTP ----
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const buf = Buffer.alloc(8);
  // counter is up to 2^53; write high+low 32-bit halves
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);
  const hmac = crypto.createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const mod = 10 ** digits;
  return String(code % mod).padStart(digits, "0");
}

export function totpStepFromTime(timeMs = Date.now()): number {
  return Math.floor(timeMs / 1000 / PERIOD_SEC);
}

export function totp(secretBase32: string, timeMs = Date.now()): string {
  return hotp(base32Decode(secretBase32), totpStepFromTime(timeMs));
}

export function verifyTotp(
  secretBase32: string,
  token: string,
  timeMs = Date.now(),
  lastUsedStep?: number,
): { ok: boolean; step?: number } {
  if (!/^\d{6}$/.test(token)) return { ok: false };
  const secret = base32Decode(secretBase32);
  const center = totpStepFromTime(timeMs);
  for (let w = -WINDOW; w <= WINDOW; w++) {
    const step = center + w;
    if (typeof lastUsedStep === "number" && step <= lastUsedStep) continue;
    const candidate = hotp(secret, step);
    if (timingSafeStringEq(candidate, token)) return { ok: true, step };
  }
  return { ok: false };
}

function timingSafeStringEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---- backup codes ----
function generateBackupCode(): string {
  // 10 chars from a readable alphabet, formatted xxxxx-xxxxx
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const out: string[] = [];
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) out.push(alpha[bytes[i] % alpha.length]);
  return out.slice(0, 5).join("") + "-" + out.slice(5).join("");
}

function hashBackup(code: string): string {
  return crypto.createHash("sha256").update(code.toUpperCase()).digest("hex");
}

// ---- enrollment / state ----
export async function getMfa(userId: string): Promise<MfaRecord | null> {
  return readJson<MfaRecord>(recordPath(userId));
}

export function isEnrolled(rec: MfaRecord | null): boolean {
  return Boolean(rec && rec.enrolledAt);
}

export interface EnrollmentStart {
  secret: string; // base32, show to user once
  otpauthUrl: string; // for QR code
  pendingCreatedAt: number;
}

export async function startEnrollment(
  userId: string,
  email: string,
): Promise<EnrollmentStart> {
  const existing = await getMfa(userId);
  if (existing && existing.enrolledAt) {
    throw new Error("MFA is already enabled. Disable it first to re-enroll.");
  }
  const secretBytes = crypto.randomBytes(20); // 160 bits
  const secret = base32Encode(secretBytes);
  const rec: MfaRecord = {
    v: 1,
    userId,
    secret,
    pending: { createdAt: Date.now() },
    backupCodeHashes: [],
  };
  await writeJson(recordPath(userId), rec);
  const label = encodeURIComponent(`${ISSUER}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer: ISSUER,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SEC),
  });
  return {
    secret,
    otpauthUrl: `otpauth://totp/${label}?${params.toString()}`,
    pendingCreatedAt: rec.pending!.createdAt,
  };
}

export async function confirmEnrollment(
  userId: string,
  token: string,
): Promise<{ backupCodes: string[] }> {
  const rec = await getMfa(userId);
  if (!rec) throw new Error("Start enrollment first.");
  if (rec.enrolledAt) throw new Error("MFA already enabled.");
  if (!rec.pending) throw new Error("No pending enrollment.");
  if (Date.now() - rec.pending.createdAt > ENROLL_TTL_SEC * 1000) {
    throw new Error("Enrollment expired. Start again.");
  }
  const v = verifyTotp(rec.secret, token);
  if (!v.ok) throw new Error("Code did not match. Try again.");
  // generate backup codes
  const plain: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const c = generateBackupCode();
    plain.push(c);
    hashes.push(hashBackup(c));
  }
  rec.enrolledAt = Date.now();
  rec.pending = undefined;
  rec.backupCodeHashes = hashes;
  rec.lastUsedStep = v.step;
  await writeJson(recordPath(userId), rec);
  return { backupCodes: plain };
}

/**
 * Regenerate a fresh set of single-use backup codes for an already-enrolled
 * user, atomically replacing any unused codes. Returns the new plaintext
 * codes (the only time they are ever exposed by the server).
 *
 * Callers MUST gate this behind a step-up check so a stolen session cookie
 * cannot silently re-issue codes and lock the legitimate owner out.
 */
export async function regenerateBackupCodes(
  userId: string,
): Promise<{ backupCodes: string[]; previousRemaining: number }> {
  const rec = await getMfa(userId);
  if (!rec || !rec.enrolledAt) {
    throw new Error("MFA is not enabled for this account.");
  }
  const previousRemaining = rec.backupCodeHashes.length;
  const plain: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const c = generateBackupCode();
    plain.push(c);
    hashes.push(hashBackup(c));
  }
  rec.backupCodeHashes = hashes;
  await writeJson(recordPath(userId), rec);
  return { backupCodes: plain, previousRemaining };
}

export async function disableMfa(userId: string): Promise<void> {
  try {
    await fs.unlink(recordPath(userId));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// ---- verification + step-up ----
export interface VerifyResult {
  ok: boolean;
  via?: "totp" | "backup";
  remainingBackupCodes?: number;
  reason?: string;
}

export async function verifyAndConsume(
  userId: string,
  token: string,
): Promise<VerifyResult> {
  const rec = await getMfa(userId);
  if (!rec || !rec.enrolledAt) return { ok: false, reason: "not_enrolled" };
  const clean = token.replace(/\s+/g, "").toUpperCase();
  // backup code path
  if (clean.includes("-") || clean.length === 10) {
    const formatted = clean.length === 10 ? clean.slice(0, 5) + "-" + clean.slice(5) : clean;
    const h = hashBackup(formatted);
    const idx = rec.backupCodeHashes.findIndex((x) =>
      crypto.timingSafeEqual(Buffer.from(x, "hex"), Buffer.from(h, "hex")),
    );
    if (idx === -1) return { ok: false, reason: "invalid_code" };
    rec.backupCodeHashes.splice(idx, 1);
    await writeJson(recordPath(userId), rec);
    return { ok: true, via: "backup", remainingBackupCodes: rec.backupCodeHashes.length };
  }
  // totp path
  const v = verifyTotp(rec.secret, token, Date.now(), rec.lastUsedStep);
  if (!v.ok) return { ok: false, reason: "invalid_code" };
  rec.lastUsedStep = v.step;
  await writeJson(recordPath(userId), rec);
  return { ok: true, via: "totp" };
}

export async function grantStepUp(jti: string, userId: string): Promise<StepUpGrant> {
  const now = Date.now();
  const grant: StepUpGrant = {
    v: 1,
    jti,
    userId,
    grantedAt: now,
    expiresAt: now + STEPUP_TTL_SEC * 1000,
  };
  await writeJson(grantPath(jti), grant);
  return grant;
}

export async function getStepUp(jti: string): Promise<StepUpGrant | null> {
  const g = await readJson<StepUpGrant>(grantPath(jti));
  if (!g) return null;
  if (g.expiresAt <= Date.now()) {
    try {
      await fs.unlink(grantPath(jti));
    } catch {}
    return null;
  }
  return g;
}

export async function clearStepUp(jti: string): Promise<void> {
  try {
    await fs.unlink(grantPath(jti));
  } catch {}
}

/**
 * Gate a destructive route. Returns:
 *   { allowed: true }                       - either MFA not enrolled, or fresh step-up
 *   { allowed: false, reason: "mfa_required", expiresInSec? }
 *
 * Routes should return 401 with body { error: "mfa_required" } so the UI
 * can prompt for a code and POST it to /api/auth/mfa/challenge before
 * retrying the original request.
 */
export async function requireStepUp(
  userId: string,
  jti: string | null,
): Promise<{ allowed: true } | { allowed: false; reason: "mfa_required" }> {
  const rec = await getMfa(userId);
  if (!rec || !rec.enrolledAt) return { allowed: true };
  if (!jti) return { allowed: false, reason: "mfa_required" };
  const grant = await getStepUp(jti);
  if (!grant || grant.userId !== userId) return { allowed: false, reason: "mfa_required" };
  return { allowed: true };
}

export function publicStatus(rec: MfaRecord | null): {
  enrolled: boolean;
  enrolledAt: number | null;
  pending: boolean;
  backupCodesRemaining: number;
} {
  return {
    enrolled: Boolean(rec && rec.enrolledAt),
    enrolledAt: rec?.enrolledAt ?? null,
    pending: Boolean(rec && rec.pending && !rec.enrolledAt),
    backupCodesRemaining: rec?.backupCodeHashes?.length ?? 0,
  };
}
