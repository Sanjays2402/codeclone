"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock, FloppyDisk, Warning, Trash } from "@phosphor-icons/react/dist/ssr";

interface PolicyResponse {
  policy: {
    maxLifetimeSec: number;
    idleTimeoutSec: number;
    updatedAt: number | null;
    updatedBy: string | null;
  };
  effective: {
    maxLifetimeSec: number;
    idleTimeoutSec: number;
    sourceWorkspaceId: string | null;
  };
  canEdit: boolean;
  bounds: {
    maxLifetime: { min: number; max: number };
    idleTimeout: { min: number; max: number };
  };
}

interface Props {
  workspaceId: string;
}

const HOUR = 3600;
const DAY = 86400;

function fmtDuration(sec: number): string {
  if (sec === 0) return "no limit";
  if (sec >= DAY && sec % DAY === 0) return `${sec / DAY}d`;
  if (sec >= HOUR && sec % HOUR === 0) return `${sec / HOUR}h`;
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

/**
 * Workspace session policy editor.
 *
 * Owners cap how long any member's session can live and how long it can
 * be idle before it's rejected. Enforcement runs on every authenticated
 * request via lib/auth#currentSessionFromCookieHeader, so changes take
 * effect immediately for all members without rotating cookies.
 */
export function SessionPolicyEditor({ workspaceId }: Props) {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [maxLifetimeSec, setMaxLifetimeSec] = useState(0);
  const [idleTimeoutSec, setIdleTimeoutSec] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/session-policy`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as PolicyResponse;
      setData(j);
      setMaxLifetimeSec(j.policy.maxLifetimeSec);
      setIdleTimeoutSec(j.policy.idleTimeoutSec);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    if (!data?.canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/session-policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxLifetimeSec, idleTimeoutSec }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { policy: PolicyResponse["policy"] };
      setData((d) => (d ? { ...d, policy: j.policy } : d));
      setMaxLifetimeSec(j.policy.maxLifetimeSec);
      setIdleTimeoutSec(j.policy.idleTimeoutSec);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [data?.canEdit, idleTimeoutSec, maxLifetimeSec, workspaceId]);

  const clear = useCallback(async () => {
    if (!data?.canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/session-policy`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { policy: PolicyResponse["policy"] };
      setData((d) => (d ? { ...d, policy: j.policy } : d));
      setMaxLifetimeSec(0);
      setIdleTimeoutSec(0);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [data?.canEdit, workspaceId]);

  const dirty = data
    ? maxLifetimeSec !== data.policy.maxLifetimeSec || idleTimeoutSec !== data.policy.idleTimeoutSec
    : false;

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] flex items-center gap-1.5">
          <Clock weight="duotone" size={14} /> session policy
        </div>
        {savedFlash && (
          <span className="mono text-[10.5px] text-[var(--color-ink-4)]">saved</span>
        )}
      </div>

      <div className="ruled rounded-md p-4">
        <p className="text-[12.5px] text-[var(--color-ink-3)] mb-3 leading-relaxed">
          Cap how long any member&rsquo;s sign-in can live and how long it can
          be idle. Applied to everyone in this workspace. The strictest
          policy across a user&rsquo;s workspaces wins. Use 0 for no limit.
        </p>

        {status === "loading" && (
          <div className="mono text-[11px] text-[var(--color-ink-4)]">loading...</div>
        )}

        {status === "error" && (
          <div className="text-[12.5px] text-red-600 mb-2 flex items-center gap-1.5">
            <Warning weight="duotone" size={14} /> {error}
          </div>
        )}

        {status === "ready" && data && (
          <>
            <div className="grid sm:grid-cols-2 gap-4 mb-3">
              <label className="block">
                <span className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] block mb-1">
                  max session lifetime (seconds)
                </span>
                <input
                  type="number"
                  min={0}
                  max={data.bounds.maxLifetime.max}
                  value={maxLifetimeSec}
                  disabled={!data.canEdit || saving}
                  onChange={(e) => setMaxLifetimeSec(Math.max(0, parseInt(e.target.value || "0", 10) || 0))}
                  className="w-full px-3 h-9 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[13px] mono disabled:opacity-60"
                />
                <span className="mono text-[10.5px] text-[var(--color-ink-4)] mt-1 block">
                  {fmtDuration(maxLifetimeSec)} (min {fmtDuration(data.bounds.maxLifetime.min)}, max {fmtDuration(data.bounds.maxLifetime.max)})
                </span>
              </label>

              <label className="block">
                <span className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] block mb-1">
                  idle timeout (seconds)
                </span>
                <input
                  type="number"
                  min={0}
                  max={data.bounds.idleTimeout.max}
                  value={idleTimeoutSec}
                  disabled={!data.canEdit || saving}
                  onChange={(e) => setIdleTimeoutSec(Math.max(0, parseInt(e.target.value || "0", 10) || 0))}
                  className="w-full px-3 h-9 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[13px] mono disabled:opacity-60"
                />
                <span className="mono text-[10.5px] text-[var(--color-ink-4)] mt-1 block">
                  {fmtDuration(idleTimeoutSec)} (min {fmtDuration(data.bounds.idleTimeout.min)}, max {fmtDuration(data.bounds.idleTimeout.max)})
                </span>
              </label>
            </div>

            <div className="mono text-[10.5px] text-[var(--color-ink-4)] mb-3">
              effective for you: lifetime {fmtDuration(data.effective.maxLifetimeSec)},
              idle {fmtDuration(data.effective.idleTimeoutSec)}
              {data.effective.sourceWorkspaceId && data.effective.sourceWorkspaceId !== workspaceId
                ? " (set by another workspace)"
                : ""}
            </div>

            {data.canEdit ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || !dirty}
                  className="inline-flex items-center gap-1.5 px-3 h-9 rounded border border-[var(--color-rule)] text-[13px] disabled:opacity-50 hover:bg-[var(--color-paper-2)]"
                >
                  <FloppyDisk weight="duotone" size={14} /> save policy
                </button>
                <button
                  type="button"
                  onClick={clear}
                  disabled={saving || (maxLifetimeSec === 0 && idleTimeoutSec === 0 && !data.policy.updatedAt)}
                  className="inline-flex items-center gap-1.5 px-3 h-9 rounded border border-[var(--color-rule)] text-[13px] text-[var(--color-ink-3)] disabled:opacity-50 hover:bg-[var(--color-paper-2)]"
                >
                  <Trash weight="duotone" size={14} /> remove policy
                </button>
              </div>
            ) : (
              <div className="mono text-[11px] text-[var(--color-ink-4)]">
                only workspace owners can edit the session policy.
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
