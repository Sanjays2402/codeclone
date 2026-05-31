/**
 * Workspace plans + per-workspace monthly quotas.
 *
 * Until now the `/v1` API enforced one global monthly cap
 * (`CODECLONE_FREE_TIER_MONTHLY`) shared across every install. That works
 * for a single-tenant dev box but immediately falls over for any
 * enterprise prospect that wants to host multiple teams on one deploy:
 * one team's chatty CI can starve another team's compares. Buyers ask
 * for this on their first call ("can we have per-team quotas, billing
 * by seat, free / pro / enterprise tiers?") and reject anything that
 * answers "we share one global counter".
 *
 * Model (intentionally small):
 *   free        1,000   /v1 calls per calendar month  (default)
 *   pro        50,000   /v1 calls per calendar month
 *   enterprise unlimited
 *
 * The plan id lives inline on the workspace record so a single read
 * returns both identity and entitlement. Only the workspace owner may
 * change the plan; every change is written to the audit log by the API
 * route. Quota enforcement is wired into the public /v1/compare and
 * /v1/batch routes via `workspaceQuotaCheck`. The check walks the
 * existing append-only usage log (lib/usage.ts) filtered by
 * `workspaceId`, so we keep one source of truth and avoid a parallel
 * counter that could drift.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { USAGE_DIR, type UsageEvent } from "./usage.ts";

export type PlanId = "free" | "pro" | "enterprise";

export interface PlanLimits {
  id: PlanId;
  label: string;
  /** Monthly /v1 call cap. `null` means unlimited. */
  monthlyCalls: number | null;
  description: string;
}

export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    id: "free",
    label: "Free",
    monthlyCalls: 1_000,
    description: "Up to 1,000 /v1 calls per calendar month. Good for evaluation.",
  },
  pro: {
    id: "pro",
    label: "Pro",
    monthlyCalls: 50_000,
    description: "Up to 50,000 /v1 calls per calendar month. For production teams.",
  },
  enterprise: {
    id: "enterprise",
    label: "Enterprise",
    monthlyCalls: null,
    description: "Unlimited /v1 calls. Contact sales for an SLA and invoice billing.",
  },
};

export const PLAN_IDS: PlanId[] = ["free", "pro", "enterprise"];

export function isPlanId(v: unknown): v is PlanId {
  return v === "free" || v === "pro" || v === "enterprise";
}

export function getPlan(ws: { plan?: PlanId | null } | null | undefined): PlanLimits {
  const id = ws && isPlanId(ws.plan) ? ws.plan : "free";
  return PLANS[id];
}

export interface WorkspaceQuotaCheck {
  workspaceId: string;
  plan: PlanLimits;
  monthToDate: number;
  limit: number | null;
  remaining: number | null;
  allowed: boolean;
}

export function monthPrefix(now: number): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

async function readUsageDay(file: string): Promise<UsageEvent[]> {
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
      if (ev && typeof ev.ts === "number" && typeof ev.keyId === "string") out.push(ev);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * Count /v1 calls for a workspace within a calendar month by scanning the
 * jsonl day files whose date starts with `month`. Cheap enough for
 * realistic enterprise volumes; if a deployment outgrows it, swap in a
 * background aggregate without changing this signature.
 */
export async function countWorkspaceCallsForMonth(
  workspaceId: string,
  month: string,
): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(USAGE_DIR);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    if (!name.startsWith(month)) continue;
    const events = await readUsageDay(path.join(USAGE_DIR, name));
    for (const ev of events) {
      if (ev.workspaceId === workspaceId) total += 1;
    }
  }
  return total;
}

/**
 * Compute month-to-date /v1 usage for a workspace and decide whether the
 * next call is allowed. Reads the same JSONL files used by the dashboard
 * so the counts shown to the user match what the limiter enforces.
 *
 * Returns `null` when there is no workspace context (legacy keys); the
 * /v1 route still applies its global `quotaCheck()` fallback for that
 * path so existing deployments keep working unchanged.
 */
export async function workspaceQuotaCheck(
  workspaceId: string | null | undefined,
  ws: { plan?: PlanId | null } | null,
  now: number = Date.now(),
): Promise<WorkspaceQuotaCheck | null> {
  if (!workspaceId) return null;
  const plan = getPlan(ws);
  if (plan.monthlyCalls == null) {
    return {
      workspaceId,
      plan,
      monthToDate: 0,
      limit: null,
      remaining: null,
      allowed: true,
    };
  }
  const monthToDate = await countWorkspaceCallsForMonth(workspaceId, monthPrefix(now));
  const remaining = Math.max(0, plan.monthlyCalls - monthToDate);
  return {
    workspaceId,
    plan,
    monthToDate,
    limit: plan.monthlyCalls,
    remaining,
    allowed: monthToDate < plan.monthlyCalls,
  };
}

/**
 * Build the standard set of response headers describing a workspace
 * quota decision so clients can do the same backoff/UX they already do
 * for per-key rate limits.
 */
export function planHeaders(check: WorkspaceQuotaCheck): Record<string, string> {
  const limit = check.limit == null ? "unlimited" : String(check.limit);
  const remaining =
    check.remaining == null ? "unlimited" : String(Math.max(0, check.remaining));
  return {
    "x-codeclone-plan": check.plan.id,
    "x-codeclone-plan-limit": limit,
    "x-codeclone-plan-remaining": remaining,
    "x-codeclone-plan-month-to-date": String(check.monthToDate),
  };
}
