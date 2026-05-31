/**
 * Magic-link issuance throttling and brute-force lockout.
 *
 * Two independent fixed-window counters back each attempt at
 * /api/auth/request:
 *
 *   - per-email   keyed by sha256(lowercased email)
 *   - per-ip      keyed by sha256(client ip)
 *
 * When either counter exceeds its configured ceiling within the
 * rolling window, the source enters a "locked" state for the
 * remainder of the window. Locked sources receive a structured 429
 * with Retry-After + X-RateLimit-* headers. Every block is audited
 * so security teams can detect credential-stuffing and email-bombing
 * campaigns from the existing audit log + SIEM stream.
 *
 * Storage is the filesystem to match the rest of codeclone (no
 * runtime deps, survives next dev reloads, easy to inspect in
 * air-gapped enterprise deploys). Each counter lives at:
 *
 *   $CODECLONE_AUTH_THROTTLE_DIR/<scope>-<hash>.json
 *     { v: 1, windowStart, count, lockedUntil? }
 *
 * Defaults are conservative and overridable via env:
 *   CODECLONE_AUTH_THROTTLE_EMAIL_MAX   default 5  / 15 min
 *   CODECLONE_AUTH_THROTTLE_IP_MAX      default 20 / 15 min
 *   CODECLONE_AUTH_THROTTLE_WINDOW_SEC  default 900
 *   CODECLONE_AUTH_THROTTLE_LOCKOUT_SEC default 900
 *
 * Setting any *_MAX to 0 disables that scope (useful for tests).
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const CWD = process.cwd();

export const THROTTLE_DIR = process.env.CODECLONE_AUTH_THROTTLE_DIR
  ? path.resolve(CWD, process.env.CODECLONE_AUTH_THROTTLE_DIR)
  : path.resolve(CWD, "..", "auth-throttle");

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.floor(n);
}

export function config() {
  return {
    emailMax: intEnv("CODECLONE_AUTH_THROTTLE_EMAIL_MAX", 5),
    ipMax: intEnv("CODECLONE_AUTH_THROTTLE_IP_MAX", 20),
    windowSec: Math.max(1, intEnv("CODECLONE_AUTH_THROTTLE_WINDOW_SEC", 900)),
    lockoutSec: Math.max(1, intEnv("CODECLONE_AUTH_THROTTLE_LOCKOUT_SEC", 900)),
  };
}

export type Scope = "email" | "ip";

interface CounterRecord {
  v: 1;
  windowStart: number;
  count: number;
  lockedUntil?: number;
}

export interface ThrottleDecision {
  allowed: boolean;
  scope: Scope;
  limit: number;
  remaining: number;
  retryAfter: number; // seconds; 0 when allowed
  resetAt: number; // epoch ms when window or lockout ends
  locked: boolean;
}

function hashId(scope: Scope, raw: string): string {
  const h = crypto.createHash("sha256");
  h.update(`${scope}:${raw}`);
  return h.digest("hex").slice(0, 32);
}

function fileFor(scope: Scope, raw: string): string {
  return path.join(THROTTLE_DIR, `${scope}-${hashId(scope, raw)}.json`);
}

async function readCounter(file: string): Promise<CounterRecord | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const obj = JSON.parse(raw) as CounterRecord;
    if (!obj || obj.v !== 1) return null;
    if (typeof obj.windowStart !== "number" || typeof obj.count !== "number") return null;
    return obj;
  } catch {
    return null;
  }
}

async function writeCounter(file: string, rec: CounterRecord): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, JSON.stringify(rec), "utf8");
  await fs.rename(tmp, file);
}

/**
 * Inspect (and optionally update) the counter for a scope+identifier.
 *
 * Modes:
 *   "check"     - read current state, do not mutate. Used by the
 *                 request path before deciding to send a magic link.
 *   "register"  - increment after a successful issuance to count it
 *                 against the window. May trip the lockout.
 *
 * The split lets us return a definitive 429 *before* doing any work
 * (the cheap path) while still counting genuine requests.
 */
export async function evaluate(
  scope: Scope,
  identifier: string,
  mode: "check" | "register",
  now: number = Date.now(),
): Promise<ThrottleDecision> {
  const cfg = config();
  const max = scope === "email" ? cfg.emailMax : cfg.ipMax;
  // A max of 0 disables this scope entirely.
  if (max <= 0 || !identifier) {
    return {
      allowed: true,
      scope,
      limit: max,
      remaining: max,
      retryAfter: 0,
      resetAt: now,
      locked: false,
    };
  }
  const file = fileFor(scope, identifier);
  const existing = await readCounter(file);
  const windowMs = cfg.windowSec * 1000;
  const lockMs = cfg.lockoutSec * 1000;

  // Honor an active lockout regardless of the rolling window.
  if (existing?.lockedUntil && existing.lockedUntil > now) {
    const retryAfter = Math.max(1, Math.ceil((existing.lockedUntil - now) / 1000));
    return {
      allowed: false,
      scope,
      limit: max,
      remaining: 0,
      retryAfter,
      resetAt: existing.lockedUntil,
      locked: true,
    };
  }

  let windowStart = existing?.windowStart ?? now;
  let count = existing?.count ?? 0;
  if (now - windowStart >= windowMs || (existing?.lockedUntil && existing.lockedUntil <= now)) {
    windowStart = now;
    count = 0;
  }

  if (mode === "register") {
    count += 1;
    let lockedUntil: number | undefined;
    if (count > max) {
      lockedUntil = now + lockMs;
    }
    await writeCounter(file, { v: 1, windowStart, count, lockedUntil });
    if (lockedUntil) {
      return {
        allowed: false,
        scope,
        limit: max,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((lockedUntil - now) / 1000)),
        resetAt: lockedUntil,
        locked: true,
      };
    }
    const resetAt = windowStart + windowMs;
    return {
      allowed: true,
      scope,
      limit: max,
      remaining: Math.max(0, max - count),
      retryAfter: 0,
      resetAt,
      locked: false,
    };
  }

  // "check": do not mutate, just report whether the next register would
  // be allowed.
  const wouldBe = count + 1;
  const resetAt = windowStart + windowMs;
  if (wouldBe > max) {
    // We would trip the lockout. Surface that now so the caller can
    // skip the issuance work entirely.
    return {
      allowed: false,
      scope,
      limit: max,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      resetAt,
      locked: false,
    };
  }
  return {
    allowed: true,
    scope,
    limit: max,
    remaining: Math.max(0, max - count),
    retryAfter: 0,
    resetAt,
    locked: false,
  };
}

export function throttleHeaders(d: ThrottleDecision): Record<string, string> {
  const h: Record<string, string> = {
    "X-RateLimit-Limit": String(d.limit),
    "X-RateLimit-Remaining": String(d.remaining),
    "X-RateLimit-Reset": String(Math.floor(d.resetAt / 1000)),
    "X-RateLimit-Policy": `${d.limit};w=${config().windowSec};scope=${d.scope}`,
  };
  if (!d.allowed) h["Retry-After"] = String(d.retryAfter);
  return h;
}

/** Best-effort client IP extraction (Vercel/Next/proxy aware). */
export function clientIpFrom(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return (
    headers.get("x-real-ip") ||
    headers.get("cf-connecting-ip") ||
    headers.get("fly-client-ip") ||
    ""
  );
}

/** Admin / status views: list active lockouts across both scopes. */
export interface ActiveLockout {
  scope: Scope;
  hash: string; // privacy-preserving identifier (sha256 prefix)
  count: number;
  windowStart: number;
  lockedUntil: number;
}

export async function listActiveLockouts(now: number = Date.now()): Promise<ActiveLockout[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(THROTTLE_DIR);
  } catch {
    return [];
  }
  const out: ActiveLockout[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const m = name.match(/^(email|ip)-([a-f0-9]+)\.json$/);
    if (!m) continue;
    const scope = m[1] as Scope;
    const hash = m[2];
    const rec = await readCounter(path.join(THROTTLE_DIR, name));
    if (!rec || !rec.lockedUntil || rec.lockedUntil <= now) continue;
    out.push({
      scope,
      hash,
      count: rec.count,
      windowStart: rec.windowStart,
      lockedUntil: rec.lockedUntil,
    });
  }
  out.sort((a, b) => b.lockedUntil - a.lockedUntil);
  return out;
}

/** Test helper: wipe all throttle counters. */
export async function _resetAllForTest(): Promise<void> {
  try {
    const entries = await fs.readdir(THROTTLE_DIR);
    await Promise.all(
      entries
        .filter((n) => n.endsWith(".json") || n.endsWith(".tmp"))
        .map((n) => fs.unlink(path.join(THROTTLE_DIR, n)).catch(() => undefined)),
    );
  } catch {
    // ignore
  }
}
