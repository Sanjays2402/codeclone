"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Lifebuoy,
  Shield,
  Trash,
  Warning,
  Clock,
} from "@phosphor-icons/react/dist/ssr";

interface Grant {
  userId: string;
  email: string;
  grantedAt: number;
  grantedBy: string;
  expiresAt: number;
  reason: string;
  caseRef: string | null;
  expired: boolean;
  remainingMs: number;
}

interface ListResponse {
  grants: Grant[];
  canEdit: boolean;
  limits: { minMinutes: number; maxMinutes: number };
}

interface Props {
  workspaceId: string;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "expired";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}

export function SupportAccessEditor({ workspaceId }: Props) {
  const [state, setState] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [reason, setReason] = useState("");
  const [caseRef, setCaseRef] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/support-access`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ListResponse;
      setState(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load support grants");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  // Re-render every 30s so the countdown stays roughly fresh without
  // hammering the API. Network reload only happens on explicit actions.
  useEffect(() => {
    const t = setInterval(() => setState((s) => (s ? { ...s } : s)), 30_000);
    return () => clearInterval(t);
  }, []);

  async function grant() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/support-access`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          minutes,
          reason: reason.trim(),
          caseRef: caseRef.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      setEmail("");
      setReason("");
      setCaseRef("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to grant access");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(userId: string) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/support-access?userId=${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to revoke");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <section className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="h-5 w-40 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
        <div className="mt-3 h-16 animate-pulse rounded bg-neutral-100 dark:bg-neutral-900" />
      </section>
    );
  }

  const canEdit = state?.canEdit ?? false;
  const grants = state?.grants ?? [];
  const limits = state?.limits ?? { minMinutes: 15, maxMinutes: 1440 };

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
      <header className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md bg-neutral-100 p-2 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
          <Lifebuoy size={18} weight="duotone" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Support access
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
            Grant a named engineer time-bounded viewer access without making them a permanent
            member. Capped at {Math.floor(limits.maxMinutes / 60)}h. Every grant and revoke is
            written to the audit log with the reason you supply.
          </p>
        </div>
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
          {grants.length} active
        </span>
      </header>

      {err && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          <Warning size={14} weight="duotone" className="mt-0.5 shrink-0" />
          <span className="break-words">{err}</span>
        </div>
      )}

      {grants.length === 0 ? (
        <div className="mt-3 rounded-md border border-dashed border-neutral-200 p-3 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
          No active support grants. Workspace data is only visible to permanent members.
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {grants.map((g) => (
            <li key={g.userId} className="flex items-start gap-3 p-3">
              <div
                className={`mt-0.5 rounded-md p-1.5 ${
                  g.expired
                    ? "bg-neutral-100 text-neutral-500 dark:bg-neutral-900"
                    : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                }`}
              >
                <Shield size={14} weight="duotone" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="break-all text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {g.email}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                    <Clock size={12} weight="duotone" />
                    {g.expired ? "expired" : `${formatRemaining(g.remainingMs)} left`}
                  </span>
                </div>
                <div className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                  <span className="break-words">{g.reason}</span>
                  {g.caseRef ? (
                    <span className="ml-2 rounded bg-neutral-100 px-1 py-0.5 font-mono text-[10px] text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
                      {g.caseRef}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-500">
                  granted {new Date(g.grantedAt).toISOString()} by{" "}
                  <span className="font-mono">{g.grantedBy}</span>
                </div>
              </div>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => revoke(g.userId)}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded border border-neutral-200 px-2 py-1 text-[11px] text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-900"
                >
                  <Trash size={12} weight="duotone" /> revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="mt-4 space-y-3 rounded-md border border-neutral-200 bg-neutral-50/60 p-3 dark:border-neutral-800 dark:bg-neutral-900/40">
          <div className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
            Grant new access
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block text-xs text-neutral-700 dark:text-neutral-300">
              <span className="block text-[11px] font-medium">Engineer email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="support@vendor.example"
                disabled={busy}
                className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-900 outline-none focus:border-neutral-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              />
            </label>
            <label className="block text-xs text-neutral-700 dark:text-neutral-300">
              <span className="block text-[11px] font-medium">
                Duration (minutes, {limits.minMinutes} to {limits.maxMinutes})
              </span>
              <input
                type="number"
                min={limits.minMinutes}
                max={limits.maxMinutes}
                step={5}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                disabled={busy}
                className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-900 outline-none focus:border-neutral-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              />
            </label>
            <label className="block text-xs text-neutral-700 dark:text-neutral-300 sm:col-span-2">
              <span className="block text-[11px] font-medium">Reason (required, audited)</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={500}
                placeholder="Investigating webhook delivery failure reported in ticket"
                disabled={busy}
                className="mt-1 w-full resize-none rounded border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-900 outline-none focus:border-neutral-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              />
            </label>
            <label className="block text-xs text-neutral-700 dark:text-neutral-300 sm:col-span-2">
              <span className="block text-[11px] font-medium">Case reference (optional)</span>
              <input
                type="text"
                value={caseRef}
                onChange={(e) => setCaseRef(e.target.value)}
                placeholder="SUP-2026-0042"
                maxLength={64}
                disabled={busy}
                className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-900 outline-none focus:border-neutral-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              />
            </label>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-neutral-500 dark:text-neutral-500">
              Requires MFA step-up. The engineer must already have signed in once so we can resolve
              their account.
            </p>
            <button
              type="button"
              onClick={grant}
              disabled={busy || !email.trim() || reason.trim().length < 3}
              className="inline-flex items-center gap-1 rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              <Lifebuoy size={12} weight="duotone" /> Grant access
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
