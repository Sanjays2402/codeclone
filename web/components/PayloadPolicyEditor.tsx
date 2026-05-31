"use client";

import { useCallback, useEffect, useState } from "react";
import { CloudArrowUp, FloppyDisk, Warning, Trash } from "@phosphor-icons/react/dist/ssr";

interface PolicyResponse {
  policy: {
    maxBodyBytes: number;
    updatedAt: number | null;
    updatedBy: string | null;
  };
  canEdit: boolean;
  bounds: {
    maxBodyBytes: { min: number; max: number };
  };
}

interface Props {
  workspaceId: string;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "no limit";
  if (n >= 1024 * 1024) {
    const mb = n / (1024 * 1024);
    return `${mb % 1 === 0 ? mb.toFixed(0) : mb.toFixed(2)} MiB`;
  }
  if (n >= 1024) {
    const kb = n / 1024;
    return `${kb % 1 === 0 ? kb.toFixed(0) : kb.toFixed(1)} KiB`;
  }
  return `${n} B`;
}

/**
 * Workspace request payload size policy editor.
 *
 * Owners cap how large a single /v1 request body may be when issued
 * against an API key bound to this workspace. Enforcement runs in
 * lib/payload-policy-enforce.ts on every /v1 request (pre-parse via
 * Content-Length and post-parse against the serialized body) and emits
 * a `v1.payload_blocked` audit entry on every rejection.
 */
export function PayloadPolicyEditor({ workspaceId }: Props) {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [maxBodyBytes, setMaxBodyBytes] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/payload-policy`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as PolicyResponse;
      setData(j);
      setMaxBodyBytes(j.policy.maxBodyBytes);
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
      const r = await fetch(`/api/workspaces/${workspaceId}/payload-policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxBodyBytes }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error?.message || j?.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { policy: PolicyResponse["policy"] };
      setData((d) => (d ? { ...d, policy: j.policy } : d));
      setMaxBodyBytes(j.policy.maxBodyBytes);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [data?.canEdit, maxBodyBytes, workspaceId]);

  const clear = useCallback(async () => {
    if (!data?.canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/payload-policy`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { policy: PolicyResponse["policy"] };
      setData((d) => (d ? { ...d, policy: j.policy } : d));
      setMaxBodyBytes(0);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [data?.canEdit, workspaceId]);

  const dirty = data ? maxBodyBytes !== data.policy.maxBodyBytes : false;

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] flex items-center gap-1.5">
          <CloudArrowUp weight="duotone" size={14} /> request payload size
        </div>
        {savedFlash && (
          <span className="mono text-[10.5px] text-[var(--color-ink-4)]">saved</span>
        )}
      </div>

      <div className="ruled rounded-md p-4">
        <p className="text-[12.5px] text-[var(--color-ink-3)] mb-3 leading-relaxed">
          Cap the maximum request body in bytes for any /v1 call made with
          an API key bound to this workspace. Over-limit requests are
          rejected with HTTP 413
          {" "}<code className="mono text-[11.5px]">payload_too_large</code>{" "}
          and recorded in the audit log as
          {" "}<code className="mono text-[11.5px]">v1.payload_blocked</code>.
          Use 0 for no policy.
        </p>

        {status === "loading" && (
          <div className="mono text-[11px] text-[var(--color-ink-4)]" role="status">loading...</div>
        )}

        {status === "error" && (
          <div className="text-[12.5px] text-red-600 mb-2 flex items-center gap-1.5" role="alert">
            <Warning weight="duotone" size={14} /> {error}
          </div>
        )}

        {status === "ready" && data && (
          <>
            <label className="block mb-3 max-w-xs">
              <span className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] block mb-1">
                max body bytes
              </span>
              <input
                type="number"
                min={0}
                max={data.bounds.maxBodyBytes.max}
                step={1024}
                value={maxBodyBytes}
                disabled={!data.canEdit || saving}
                onChange={(e) => setMaxBodyBytes(Math.max(0, parseInt(e.target.value || "0", 10) || 0))}
                className="w-full px-3 h-9 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[13px] mono disabled:opacity-60"
                aria-describedby="payload-policy-bounds"
              />
              <span id="payload-policy-bounds" className="mono text-[10.5px] text-[var(--color-ink-4)] mt-1 block">
                {fmtBytes(maxBodyBytes)}
                {" "}(min {fmtBytes(data.bounds.maxBodyBytes.min)}, max {fmtBytes(data.bounds.maxBodyBytes.max)})
              </span>
            </label>

            {data.policy.maxBodyBytes > 0 && (
              <div className="mono text-[10.5px] text-[var(--color-ink-4)] mb-3">
                in force: /v1 requests over {fmtBytes(data.policy.maxBodyBytes)} return 413
              </div>
            )}

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
                  disabled={saving || (maxBodyBytes === 0 && !data.policy.updatedAt)}
                  className="inline-flex items-center gap-1.5 px-3 h-9 rounded border border-[var(--color-rule)] text-[13px] text-[var(--color-ink-3)] disabled:opacity-50 hover:bg-[var(--color-paper-2)]"
                >
                  <Trash weight="duotone" size={14} /> remove policy
                </button>
              </div>
            ) : (
              <div className="mono text-[11px] text-[var(--color-ink-4)]">
                only workspace owners can edit the payload size policy.
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
