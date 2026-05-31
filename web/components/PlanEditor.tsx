"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Receipt, CheckCircle, Warning, ArrowUpRight } from "@phosphor-icons/react/dist/ssr";

interface PlanOption {
  id: "free" | "pro" | "enterprise";
  label: string;
  monthlyCalls: number | null;
  description: string;
}

interface PlanResponse {
  plan: { id: PlanOption["id"]; label: string; monthlyCalls: number | null };
  usage: { monthToDate: number; limit: number | null; remaining: number | null };
  catalog: PlanOption[];
  canEdit: boolean;
}

interface Props {
  workspaceId: string;
}

/**
 * Workspace billing plan editor.
 *
 * Shows the current plan, this calendar month's /v1 burn against the
 * cap, and (for owners) lets you switch between free, pro, and
 * enterprise tiers. The /v1 routes enforce the picked plan; updates
 * land in the audit log with a before/after diff so security reviewers
 * can trace every change. Non-owners see a read-only summary so they
 * understand why a 429 came back during a load test.
 */
export function PlanEditor({ workspaceId }: Props) {
  const [data, setData] = useState<PlanResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/plan`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as PlanResponse;
      setData(j);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const choose = useCallback(async (id: PlanOption["id"]) => {
    if (!data?.canEdit || saving) return;
    if (data.plan.id === id) return;
    setSaving(id);
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message || j?.error || `HTTP ${r.status}`);
      setData((d) => (d ? { ...d, ...(j as PlanResponse) } : (j as PlanResponse)));
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  }, [data, workspaceId, saving]);

  const usagePct = useMemo(() => {
    if (!data) return 0;
    const { monthToDate, limit } = data.usage;
    if (!limit) return 0;
    return Math.min(100, Math.round((monthToDate / limit) * 100));
  }, [data]);

  return (
    <section className="border border-[var(--color-rule)] rounded-md p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Receipt weight="duotone" size={16} className="text-[var(--color-ink-3)]" />
        <h2 className="text-[13px] font-medium">Billing plan</h2>
        {savedFlash && (
          <span className="inline-flex items-center gap-1 text-[12px] text-emerald-600">
            <CheckCircle weight="duotone" size={12} /> saved
          </span>
        )}
      </div>
      <p className="text-[12px] text-[var(--color-ink-3)]">
        Caps /v1 API calls per calendar month for this workspace. Counts
        the same usage events the dashboard shows, so what you see here is
        what the limiter enforces.
      </p>

      {status === "loading" && (
        <div className="h-24 rounded bg-[var(--color-paper-2)] animate-pulse" aria-label="Loading plan" />
      )}
      {status === "error" && (
        <div className="text-[12px] text-red-600 inline-flex items-center gap-1">
          <Warning weight="duotone" size={12} /> {error || "Failed to load plan."}
        </div>
      )}

      {status === "ready" && data && (
        <>
          <div className="rounded border border-[var(--color-rule)] p-3 bg-[var(--color-paper-2)]">
            <div className="flex items-baseline justify-between gap-2">
              <div className="text-[12px] text-[var(--color-ink-3)]">This month</div>
              <div className="text-[12px] tabular-nums">
                {data.usage.monthToDate.toLocaleString()} /{" "}
                {data.usage.limit == null ? "unlimited" : data.usage.limit.toLocaleString()}{" "}
                calls
              </div>
            </div>
            <div className="mt-2 h-1.5 rounded bg-[var(--color-rule)] overflow-hidden">
              <div
                className={`h-full ${usagePct >= 90 ? "bg-red-500" : usagePct >= 70 ? "bg-amber-500" : "bg-emerald-500"}`}
                style={{ width: data.usage.limit == null ? "100%" : `${usagePct}%` }}
                aria-label={`${usagePct}% of monthly cap used`}
              />
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            {data.catalog.map((p) => {
              const active = data.plan.id === p.id;
              const busy = saving === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={!data.canEdit || busy || active}
                  onClick={() => void choose(p.id)}
                  aria-pressed={active}
                  className={`text-left p-3 rounded border transition ${
                    active
                      ? "border-[var(--color-ink-1)] bg-[var(--color-paper-1)]"
                      : "border-[var(--color-rule)] hover:bg-[var(--color-paper-2)]"
                  } ${!data.canEdit || busy ? "opacity-70 cursor-not-allowed" : "cursor-pointer"}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="text-[13px] font-medium">{p.label}</div>
                    {active && (
                      <span className="text-[11px] inline-flex items-center gap-1 text-emerald-600">
                        <CheckCircle weight="duotone" size={12} /> current
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] mt-1 tabular-nums">
                    {p.monthlyCalls == null
                      ? "Unlimited /v1 calls"
                      : `${p.monthlyCalls.toLocaleString()} /v1 calls / month`}
                  </div>
                  <div className="text-[11px] text-[var(--color-ink-3)] mt-1">{p.description}</div>
                  {!active && data.canEdit && (
                    <div className="mt-2 text-[11px] text-[var(--color-ink-2)] inline-flex items-center gap-1">
                      <ArrowUpRight weight="duotone" size={12} />
                      {busy ? "saving…" : "switch"}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {!data.canEdit && (
            <p className="text-[11px] text-[var(--color-ink-3)]">
              Only the workspace owner can change the plan.
            </p>
          )}
          {error && (
            <div className="text-[12px] text-red-600 inline-flex items-center gap-1">
              <Warning weight="duotone" size={12} /> {error}
            </div>
          )}
        </>
      )}
    </section>
  );
}
