"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldSlash, ShieldCheck, Siren, Warning } from "@phosphor-icons/react/dist/ssr";

interface LockdownResponse {
  lockdown: {
    active: true;
    reason: string;
    caseRef: string | null;
    placedAt: number;
    placedBy: string;
  } | null;
  canEdit: boolean;
}

interface Props {
  workspaceId: string;
  workspaceSlug: string;
}

export function LockdownEditor({ workspaceId, workspaceSlug }: Props) {
  const [state, setState] = useState<LockdownResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [caseRef, setCaseRef] = useState("");
  const [releaseConfirm, setReleaseConfirm] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/lockdown`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as LockdownResponse;
      setState(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  async function place() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/lockdown`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim(), caseRef: caseRef.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      setReason("");
      setCaseRef("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to place lockdown");
    } finally {
      setBusy(false);
    }
  }

  async function release() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/lockdown`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: releaseConfirm }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      setReleaseConfirm("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to lift lockdown");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <section className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="h-5 w-32 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
        <div className="mt-3 h-12 animate-pulse rounded bg-neutral-100 dark:bg-neutral-900" />
      </section>
    );
  }

  const active = state?.lockdown?.active === true;
  const canEdit = state?.canEdit ?? false;

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
      <header className="flex items-start gap-3">
        <div
          className={`mt-0.5 rounded-md p-2 ${
            active
              ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
              : "bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400"
          }`}
        >
          {active ? (
            <Siren size={18} weight="duotone" aria-hidden />
          ) : (
            <ShieldCheck size={18} weight="duotone" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Break-glass lockdown
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
            Instantly halt every /v1 API call bound to this workspace with HTTP 423 while you
            rotate keys or investigate an incident. Dashboard sessions keep working so owners
            can lift the lockdown. Placement, release, and every blocked call are audited.
          </p>
        </div>
        {active ? (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-800 dark:bg-red-900/40 dark:text-red-200">
            Locked
          </span>
        ) : (
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
            Open
          </span>
        )}
      </header>

      {err && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          <Warning size={14} weight="duotone" className="mt-0.5 shrink-0" />
          <span className="break-words">{err}</span>
        </div>
      )}

      {active && state?.lockdown ? (
        <div className="mt-3 space-y-3">
          <dl className="grid grid-cols-1 gap-2 rounded-md border border-red-200 bg-red-50/40 p-3 text-xs dark:border-red-900/60 dark:bg-red-950/20 sm:grid-cols-2">
            <div>
              <dt className="font-medium text-neutral-700 dark:text-neutral-300">Reason</dt>
              <dd className="mt-0.5 break-words text-neutral-900 dark:text-neutral-100">
                {state.lockdown.reason}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-neutral-700 dark:text-neutral-300">Case reference</dt>
              <dd className="mt-0.5 break-words text-neutral-900 dark:text-neutral-100">
                {state.lockdown.caseRef || "None"}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-neutral-700 dark:text-neutral-300">Placed at</dt>
              <dd className="mt-0.5 text-neutral-900 dark:text-neutral-100">
                {new Date(state.lockdown.placedAt).toISOString()}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-neutral-700 dark:text-neutral-300">Placed by</dt>
              <dd className="mt-0.5 font-mono text-[11px] text-neutral-900 dark:text-neutral-100">
                {state.lockdown.placedBy}
              </dd>
            </div>
          </dl>

          {canEdit ? (
            <div className="space-y-2">
              <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300">
                To lift, type the workspace slug{" "}
                <code className="rounded bg-neutral-100 px-1 font-mono text-[11px] dark:bg-neutral-900">
                  {workspaceSlug}
                </code>
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  value={releaseConfirm}
                  onChange={(e) => setReleaseConfirm(e.target.value)}
                  placeholder={workspaceSlug}
                  className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
                <button
                  type="button"
                  onClick={release}
                  disabled={busy || releaseConfirm !== workspaceSlug}
                  className="inline-flex items-center justify-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
                >
                  <ShieldCheck size={14} weight="duotone" />
                  Lift lockdown
                </button>
              </div>
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                Requires MFA step-up. Lift is logged.
              </p>
            </div>
          ) : (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Only the workspace owner can lift the lockdown.
            </p>
          )}
        </div>
      ) : (
        <div className="mt-3">
          {canEdit ? (
            <div className="space-y-2">
              <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300">
                Reason (3-500 chars)
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={2}
                placeholder="Suspected key compromise; investigating spike in /v1 calls."
                className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
              <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300">
                Case reference (optional)
              </label>
              <input
                type="text"
                value={caseRef}
                onChange={(e) => setCaseRef(e.target.value)}
                maxLength={120}
                placeholder="INC-2026-0042"
                className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
              />
              <div className="flex items-center justify-between gap-2 pt-1">
                <p className="flex items-center gap-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                  <ShieldSlash size={12} weight="duotone" />
                  Requires MFA step-up. Halts /v1 immediately.
                </p>
                <button
                  type="button"
                  onClick={place}
                  disabled={busy || reason.trim().length < 3}
                  className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-red-500"
                >
                  <Siren size={14} weight="duotone" />
                  Engage lockdown
                </button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Only the workspace owner can engage a lockdown.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
