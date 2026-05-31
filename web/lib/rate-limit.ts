/**
 * Per-API-key sliding-window rate limiter.
 *
 * Backed by the filesystem to match the rest of the app (no external
 * dependencies, survives across `next dev` reloads, easy to reason
 * about in air-gapped enterprise deploys). Storage layout:
 *
 *   $CODECLONE_RATELIMIT_DIR/<keyId>.json
 *     { v: 1, windowStart: <epoch ms>, count: <int> }
 *
 * The window is a fixed 60-second bucket. When a request lands and the
 * bucket has rolled over, we reset; otherwise we increment. If the
 * post-increment count exceeds the key's `rateLimit.rpm`, we return a
 * 429 response with standard headers:
 *
 *   X-RateLimit-Limit:     <rpm>
 *   X-RateLimit-Remaining: <max(0, rpm - count)>
 *   X-RateLimit-Reset:     <epoch seconds of next window>
 *   X-RateLimit-Policy:    "<rpm>;w=60"
 *   Retry-After:           <seconds until next window>
 *
 * Successful responses get the same headers (minus Retry-After) so
 * clients can implement adaptive backoff. The default limit applies to
 * legacy keys with no `rateLimit` field; admins can override per key.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface KeyLike {
  id: string;
  rateLimit?: { rpm: number };
}

const CWD = process.cwd();

export const RATELIMIT_DIR = process.env.CODECLONE_RATELIMIT_DIR
  ? path.resolve(CWD, process.env.CODECLONE_RATELIMIT_DIR)
  : path.resolve(CWD, "..", "rate-limit");

export const DEFAULT_RPM = 60;
export const MIN_RPM = 1;
export const MAX_RPM = 100_000;
const WINDOW_MS = 60_000;

export interface RateLimitConfig {
  rpm: number;
}

export interface CounterRecord {
  v: 1;
  windowStart: number;
  count: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // epoch ms when current window ends
  retryAfter: number; // seconds until reset (>=1)
}

export function normalizeRpm(input: unknown): number | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n)) return undefined;
  const r = Math.floor(n);
  if (r < MIN_RPM || r > MAX_RPM) return undefined;
  return r;
}

export function effectiveRpm(
  rec: { rateLimit?: { rpm: number } } | null | undefined,
): number {
  const rpm = rec?.rateLimit?.rpm;
  if (typeof rpm === "number" && rpm >= MIN_RPM && rpm <= MAX_RPM) return Math.floor(rpm);
  return DEFAULT_RPM;
}

async function ensureDir() {
  await fs.mkdir(RATELIMIT_DIR, { recursive: true });
}

function counterFile(id: string): string {
  // mild safety: ids are validated upstream, but keep paths flat
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(RATELIMIT_DIR, `${safe}.json`);
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
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(rec), "utf8");
  await fs.rename(tmp, file);
}

/**
 * Atomically (within a single Node process) bump the counter for the
 * given key and return the decision. Two concurrent processes can race
 * but the worst case is a small over-count within one window, which is
 * acceptable for a rate limiter intended for soft quota enforcement.
 */
export async function check(
  keyId: string,
  rpm: number,
  now: number = Date.now(),
): Promise<RateLimitDecision> {
  await ensureDir();
  const file = counterFile(keyId);
  const existing = await readCounter(file);
  let windowStart = existing?.windowStart ?? now;
  let count = existing?.count ?? 0;
  if (now - windowStart >= WINDOW_MS) {
    windowStart = now;
    count = 0;
  }
  count += 1;
  await writeCounter(file, { v: 1, windowStart, count });
  const resetAt = windowStart + WINDOW_MS;
  const remaining = Math.max(0, rpm - count);
  const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
  return {
    allowed: count <= rpm,
    limit: rpm,
    remaining,
    resetAt,
    retryAfter,
  };
}

export function rateLimitHeaders(d: RateLimitDecision): Record<string, string> {
  const h: Record<string, string> = {
    "X-RateLimit-Limit": String(d.limit),
    "X-RateLimit-Remaining": String(d.remaining),
    "X-RateLimit-Reset": String(Math.floor(d.resetAt / 1000)),
    "X-RateLimit-Policy": `${d.limit};w=60`,
  };
  if (!d.allowed) h["Retry-After"] = String(d.retryAfter);
  return h;
}

/**
 * Helper used by /v1 routes. Returns either a ready-to-send 429
 * Response or the headers to merge into a successful response.
 */
export async function enforce(
  key: KeyLike,
): Promise<{ response: Response | null; headers: Record<string, string> }> {
  const rpm = effectiveRpm(key);
  const decision = await check(key.id, rpm);
  const headers = rateLimitHeaders(decision);
  if (!decision.allowed) {
    const body = {
      error: {
        type: "rate_limited",
        message: `API key exceeded its limit of ${rpm} requests per minute. Retry in ${decision.retryAfter}s or raise the limit on the key.`,
        limit: rpm,
        retry_after_seconds: decision.retryAfter,
      },
    };
    return {
      response: new Response(JSON.stringify(body), {
        status: 429,
        headers: { ...headers, "Content-Type": "application/json" },
      }),
      headers,
    };
  }
  return { response: null, headers };
}

/** Test helper: clear the on-disk counter for a key. */
export async function _resetForTest(keyId: string): Promise<void> {
  try {
    await fs.unlink(counterFile(keyId));
  } catch {
    // ignore
  }
}
