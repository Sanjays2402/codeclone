/**
 * Per-key usage tracking and quota.
 *
 * We append a one-line JSON record to $CODECLONE_KEYS_DIR/usage/YYYY-MM-DD.jsonl
 * for every successful authenticated API call. Aggregation reads the last N
 * day files and rolls them up by day and by key. This keeps the hot path
 * append-only (one open/append/close per call) and avoids any global lock.
 *
 * Free-tier quota is intentionally simple: a fixed monthly cap across all
 * keys belonging to the install. Real billing would key off a customer id,
 * but this matches the single-tenant FS model the rest of the app uses.
 */
import fs from "node:fs/promises";
import path from "node:path";

const CWD = process.cwd();

export const KEYS_DIR = process.env.CODECLONE_KEYS_DIR
  ? path.resolve(CWD, process.env.CODECLONE_KEYS_DIR)
  : path.resolve(CWD, "..", "api-keys");

export const USAGE_DIR = path.join(KEYS_DIR, "usage");

export const FREE_TIER_MONTHLY = Number(
  process.env.CODECLONE_FREE_TIER_MONTHLY ?? 1000,
);

export interface UsageEvent {
  ts: number;
  keyId: string;
  endpoint: string;
  bytes?: number;
  latencyMs?: number;
  /**
   * Workspace this call was billed against. Populated when the API key
   * is workspace-bound; used by lib/plans.ts to enforce per-workspace
   * monthly quotas. Optional so legacy unscoped keys still log.
   */
  workspaceId?: string;
}

export interface DailyUsage {
  date: string; // YYYY-MM-DD
  count: number;
}

export interface KeyUsage {
  keyId: string;
  count: number;
}

export interface EndpointUsage {
  endpoint: string;
  count: number;
  avgLatencyMs: number | null;
  totalBytes: number;
}

export interface RecentCall {
  ts: number;
  keyId: string;
  endpoint: string;
  bytes?: number;
  latencyMs?: number;
}

export interface UsageSummary {
  windowDays: number;
  totalCalls: number;
  monthToDate: number;
  freeTierMonthly: number;
  quotaRemaining: number;
  quotaPercent: number;
  byDay: DailyUsage[];
  byKey: KeyUsage[];
  byEndpoint: EndpointUsage[];
  lastEventAt: number | null;
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isDayKey(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

async function ensureDir() {
  await fs.mkdir(USAGE_DIR, { recursive: true });
}

export async function logUsage(ev: UsageEvent): Promise<void> {
  try {
    await ensureDir();
    const file = path.join(USAGE_DIR, `${dayKey(ev.ts)}.jsonl`);
    await fs.appendFile(file, JSON.stringify(ev) + "\n", "utf-8");
  } catch {
    // best-effort: never block a 200 response on usage logging
  }
}

async function readDay(date: string): Promise<UsageEvent[]> {
  const file = path.join(USAGE_DIR, `${date}.jsonl`);
  let buf: string;
  try {
    buf = await fs.readFile(file, "utf-8");
  } catch {
    return [];
  }
  const out: UsageEvent[] = [];
  for (const line of buf.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t) as UsageEvent;
      if (ev && typeof ev.ts === "number" && typeof ev.keyId === "string") {
        out.push(ev);
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function buildEmptyDays(windowDays: number, now: number): string[] {
  const out: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    out.push(dayKey(now - i * 86_400_000));
  }
  return out;
}

export async function summarize(
  windowDays = 30,
  now: number = Date.now(),
): Promise<UsageSummary> {
  await ensureDir();
  const days = buildEmptyDays(windowDays, now);
  const counts = new Map<string, number>(days.map((d) => [d, 0]));
  const byKey = new Map<string, number>();
  const byEndpoint = new Map<
    string,
    { count: number; latencySum: number; latencySamples: number; bytes: number }
  >();
  let totalCalls = 0;
  let lastEventAt: number | null = null;

  const events = await Promise.all(days.map(readDay));
  for (const list of events) {
    for (const ev of list) {
      const dk = dayKey(ev.ts);
      if (!counts.has(dk)) continue;
      counts.set(dk, (counts.get(dk) ?? 0) + 1);
      byKey.set(ev.keyId, (byKey.get(ev.keyId) ?? 0) + 1);
      const epKey = typeof ev.endpoint === "string" && ev.endpoint ? ev.endpoint : "(unknown)";
      const epRec = byEndpoint.get(epKey) ?? {
        count: 0,
        latencySum: 0,
        latencySamples: 0,
        bytes: 0,
      };
      epRec.count += 1;
      if (typeof ev.latencyMs === "number" && Number.isFinite(ev.latencyMs)) {
        epRec.latencySum += ev.latencyMs;
        epRec.latencySamples += 1;
      }
      if (typeof ev.bytes === "number" && Number.isFinite(ev.bytes)) {
        epRec.bytes += ev.bytes;
      }
      byEndpoint.set(epKey, epRec);
      totalCalls += 1;
      if (lastEventAt === null || ev.ts > lastEventAt) lastEventAt = ev.ts;
    }
  }

  // Month-to-date uses the calendar month containing `now`.
  const monthPrefix = dayKey(now).slice(0, 7); // YYYY-MM
  let monthToDate = 0;
  for (const [d, c] of counts.entries()) {
    if (d.startsWith(monthPrefix)) monthToDate += c;
  }

  const quotaRemaining = Math.max(0, FREE_TIER_MONTHLY - monthToDate);
  const quotaPercent = FREE_TIER_MONTHLY
    ? Math.min(100, (monthToDate / FREE_TIER_MONTHLY) * 100)
    : 0;

  return {
    windowDays,
    totalCalls,
    monthToDate,
    freeTierMonthly: FREE_TIER_MONTHLY,
    quotaRemaining,
    quotaPercent: Number(quotaPercent.toFixed(2)),
    byDay: days.map((d) => ({ date: d, count: counts.get(d) ?? 0 })),
    byKey: Array.from(byKey.entries())
      .map(([keyId, count]) => ({ keyId, count }))
      .sort((a, b) => b.count - a.count),
    byEndpoint: Array.from(byEndpoint.entries())
      .map(([endpoint, r]) => ({
        endpoint,
        count: r.count,
        avgLatencyMs:
          r.latencySamples > 0
            ? Number((r.latencySum / r.latencySamples).toFixed(2))
            : null,
        totalBytes: r.bytes,
      }))
      .sort((a, b) => b.count - a.count),
    lastEventAt,
  };
}

/**
 * Return the most recent N usage events across the trailing windowDays.
 * Useful for a Stripe-style "recent API calls" log in the dashboard.
 */
export async function recentEvents(
  limit = 50,
  windowDays = 7,
  now: number = Date.now(),
): Promise<RecentCall[]> {
  await ensureDir();
  const cap = Math.max(1, Math.min(500, Math.floor(limit)));
  const win = Math.max(1, Math.min(90, Math.floor(windowDays)));
  const days = buildEmptyDays(win, now);
  const events = await Promise.all(days.map(readDay));
  const flat: RecentCall[] = [];
  for (const list of events) {
    for (const ev of list) {
      flat.push({
        ts: ev.ts,
        keyId: ev.keyId,
        endpoint: ev.endpoint,
        bytes: ev.bytes,
        latencyMs: ev.latencyMs,
      });
    }
  }
  flat.sort((a, b) => b.ts - a.ts);
  return flat.slice(0, cap);
}

export async function quotaCheck(
  now: number = Date.now(),
): Promise<{ allowed: boolean; remaining: number; monthToDate: number; limit: number }> {
  const s = await summarize(31, now);
  return {
    allowed: s.monthToDate < s.freeTierMonthly,
    remaining: s.quotaRemaining,
    monthToDate: s.monthToDate,
    limit: s.freeTierMonthly,
  };
}

// Exported for tests.
export const __test = { dayKey, buildEmptyDays, isDayKey };
