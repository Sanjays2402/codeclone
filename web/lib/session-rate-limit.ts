/**
 * Per-user (cookie-session) sliding-window rate limiter for the
 * browser-facing API surface.
 *
 * The public `/v1/*` API enforces per-API-key limits in `rate-limit.ts`.
 * Routes that are reachable from a signed-in browser session
 * (`/api/compare`, `/api/snippets`, ...) had no per-user ceiling, so a
 * single tenant could DOS the comparator from the web UI with a tight
 * loop. Procurement reviewers flag this as a missing control.
 *
 * Storage layout mirrors `rate-limit.ts` so ops can reason about both
 * limiters the same way:
 *
 *   $CODECLONE_SESSION_RATELIMIT_DIR/<bucket>__<userId>.json
 *     { v: 1, windowStart: <epoch ms>, count: <int> }
 *
 * Buckets let us apply distinct limits to distinct routes (a chatty
 * compare vs an expensive snippet write) without one starving the
 * other.
 *
 * Limits can be overridden per-deploy with environment variables, e.g.
 *   CODECLONE_SESSION_RATELIMIT_COMPARE_RPM=120
 *
 * Anonymous callers (no cookie) fall back to a coarse per-IP bucket so
 * unauthenticated probes can't bypass the ceiling.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { rateLimitHeaders, type RateLimitDecision } from "./rate-limit.ts";

const WINDOW_MS = 60_000;

interface CounterRecord {
  v: 1;
  windowStart: number;
  count: number;
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

async function bump(
  dir: string,
  id: string,
  limit: number,
  now: number = Date.now(),
): Promise<RateLimitDecision> {
  await fs.mkdir(dir, { recursive: true });
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
  const file = path.join(dir, `${safe}.json`);
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
  const remaining = Math.max(0, limit - count);
  const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
  return { allowed: count <= limit, limit, remaining, resetAt, retryAfter };
}

const CWD = process.cwd();

export const SESSION_RATELIMIT_DIR = process.env.CODECLONE_SESSION_RATELIMIT_DIR
  ? path.resolve(CWD, process.env.CODECLONE_SESSION_RATELIMIT_DIR)
  : path.resolve(CWD, "..", "session-rate-limit");

export type SessionBucket = "compare" | "snippets-write" | "default";

const DEFAULTS: Record<SessionBucket, number> = {
  compare: 60,
  "snippets-write": 30,
  default: 120,
};

const ENV_OVERRIDES: Record<SessionBucket, string> = {
  compare: "CODECLONE_SESSION_RATELIMIT_COMPARE_RPM",
  "snippets-write": "CODECLONE_SESSION_RATELIMIT_SNIPPETS_RPM",
  default: "CODECLONE_SESSION_RATELIMIT_DEFAULT_RPM",
};

export function bucketLimit(bucket: SessionBucket): number {
  const raw = process.env[ENV_OVERRIDES[bucket]];
  if (raw) {
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n >= 1 && n <= 100_000) return n;
  }
  return DEFAULTS[bucket];
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96);
}

function counterId(bucket: SessionBucket, subject: string): string {
  return `${safe(bucket)}__${safe(subject)}`;
}

/**
 * Subject extraction. Prefers the authenticated user id, then a stable
 * forwarded client IP. We deliberately do not key on the raw cookie to
 * avoid leaking session tokens onto disk in counter filenames.
 */
export function subjectFor(req: { headers: Headers }, userId: string | null): {
  subject: string;
  kind: "user" | "ip";
} {
  if (userId) return { subject: `u_${userId}`, kind: "user" };
  const fwd = req.headers.get("x-forwarded-for") || "";
  const ip = fwd.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "anon";
  return { subject: `ip_${ip || "anon"}`, kind: "ip" };
}

export interface SessionLimitResult {
  decision: RateLimitDecision;
  headers: Record<string, string>;
  subject: string;
  kind: "user" | "ip";
  bucket: SessionBucket;
}

/**
 * Bump and evaluate the limiter. Callers should merge `headers` onto
 * successful responses and return the 429 response when
 * `decision.allowed` is false.
 */
export async function enforceSession(
  req: { headers: Headers },
  userId: string | null,
  bucket: SessionBucket,
): Promise<SessionLimitResult> {
  const { subject, kind } = subjectFor(req, userId);
  const limit = bucketLimit(bucket);
  const decision = await bump(SESSION_RATELIMIT_DIR, counterId(bucket, subject), limit);
  return { decision, headers: rateLimitHeaders(decision), subject, kind, bucket };
}

export function tooManyRequestsResponse(result: SessionLimitResult): Response {
  const body = {
    error: {
      type: "rate_limited",
      message: `Session exceeded the limit of ${result.decision.limit} requests per minute for ${result.bucket}. Retry in ${result.decision.retryAfter}s.`,
      bucket: result.bucket,
      limit: result.decision.limit,
      retry_after_seconds: result.decision.retryAfter,
    },
  };
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: { ...result.headers, "Content-Type": "application/json" },
  });
}

/** Test helper: wipe the limiter state. */
export async function _resetForTest(): Promise<void> {
  try {
    const entries = await fs.readdir(SESSION_RATELIMIT_DIR);
    await Promise.all(
      entries.map((e) => fs.unlink(path.join(SESSION_RATELIMIT_DIR, e)).catch(() => {})),
    );
  } catch {
    // ignore
  }
}
