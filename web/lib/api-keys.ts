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

const CWD = process.cwd();

export const KEYS_DIR = process.env.CODECLONE_KEYS_DIR
  ? path.resolve(CWD, process.env.CODECLONE_KEYS_DIR)
  : path.resolve(CWD, "..", "api-keys");

const KEY_PREFIX = "cc_live_";
const SECRET_BYTES = 24; // 24 random bytes -> 32 base64url chars
const MAX_LABEL_LEN = 60;
const ID_LEN = 10;

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
  expiresAt?: number; // optional epoch ms; absent means never expires
}

export interface ApiKeySummary {
  id: string;
  label: string;
  prefix: string;
  createdAt: number;
  lastUsedAt?: number;
  usageCount: number;
  revoked?: boolean;
  userId?: string;
  expiresAt?: number;
  expired?: boolean;
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
    expiresAt: rec.expiresAt,
    expired: isExpired(rec),
  };
}

export interface CreatedKey {
  record: ApiKeySummary;
  plaintext: string;
}

export interface CreateOptions {
  userId?: string;
  expiresInDays?: unknown;
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
    const exp = normalizeExpiresInDays(opts.expiresInDays);
    if (exp) rec.expiresAt = exp;
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
 */
export async function recordUse(id: string): Promise<void> {
  try {
    const rec = await loadKey(id);
    if (!rec) return;
    rec.usageCount = (rec.usageCount ?? 0) + 1;
    rec.lastUsedAt = Date.now();
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
