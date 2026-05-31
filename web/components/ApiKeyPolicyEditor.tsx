"use client";

import { useCallback, useEffect, useState } from "react";
import { Key, FloppyDisk, Warning, Trash } from "@phosphor-icons/react/dist/ssr";

interface PolicyResponse {
  policy: {
    maxAgeDays: number;
    updatedAt: number | null;
    updatedBy: string | null;
  };
  canEdit: boolean;
  bounds: {
    maxAgeDays: { min: number; max: number };
  };
}

interface Props {
  workspaceId: string;
}

/**
 * Workspace API key max age policy editor.
 *
 * Owners cap how long any API key minted in the workspace may live before
 * it must be rotated. Enforcement runs both at key creation
 * (lib/api-keys.ts#createKey clamps expiresAt) and on every /v1 request
 * (lib/api-key-policy-enforce.ts), so tightening the policy immediately
 * locks out drift keys and the next rotation snaps every key into
 * compliance.
 */
export function ApiKeyPolicyEditor({ workspaceId }: Props) {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [maxAgeDays, setMaxAgeDays] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/api-key-policy`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as PolicyResponse;
      setData(j);
      setMaxAgeDays(j.policy.maxAgeDays);
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
      const r = await fetch(`/api/workspaces/${workspaceId}/api-key-policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxAgeDays }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error?.message || j?.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { policy: PolicyResponse["policy"] };
      setData((d) => (d ? { ...d, policy: j.policy } : d));
      setMaxAgeDays(j.policy.maxAgeDays);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [data?.canEdit, maxAgeDays, workspaceId]);

  const clear = useCallback(async () => {
    if (!data?.canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/api-key-policy`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { policy: PolicyResponse["policy"] };
      setData((d) => (d ? { ...d, policy: j.policy } : d));
      setMaxAgeDays(0);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [data?.canEdit, workspaceId]);

  const dirty = data ? maxAgeDays !== data.policy.maxAgeDays : false;

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] flex items-center gap-1.5">
          <Key weight="duotone" size={14} /> api key max age
        </div>
        {savedFlash && (
          <span className="mono text-[10.5px] text-[var(--color-ink-4)]">saved</span>
        )}
      </div>

      <div className="ruled rounded-md p-4">
        <p className="text-[12.5px] text-[var(--color-ink-3)] mb-3 leading-relaxed">
          Force every API key in this workspace to expire within N days of
          creation. New keys are clamped at issue time, and any older key
          past the deadline is refused at /v1 with HTTP 401
          {" "}<code className="mono text-[11.5px]">api_key_policy_expired</code>{" "}
          until rotated. Use 0 for no policy.
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
                max key age (days)
              </span>
              <input
                type="number"
                min={0}
                max={data.bounds.maxAgeDays.max}
                value={maxAgeDays}
                disabled={!data.canEdit || saving}
                onChange={(e) => setMaxAgeDays(Math.max(0, parseInt(e.target.value || "0", 10) || 0))}
                className="w-full px-3 h-9 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[13px] mono disabled:opacity-60"
                aria-describedby="api-key-policy-bounds"
              />
              <span id="api-key-policy-bounds" className="mono text-[10.5px] text-[var(--color-ink-4)] mt-1 block">
                {maxAgeDays === 0 ? "no limit" : `${maxAgeDays}d`}
                {" "}(min {data.bounds.maxAgeDays.min}d, max {data.bounds.maxAgeDays.max}d)
              </span>
            </label>

            {data.policy.maxAgeDays > 0 && (
              <div className="mono text-[10.5px] text-[var(--color-ink-4)] mb-3">
                in force: keys expire within {data.policy.maxAgeDays}d of creation
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
                  disabled={saving || (maxAgeDays === 0 && !data.policy.updatedAt)}
                  className="inline-flex items-center gap-1.5 px-3 h-9 rounded border border-[var(--color-rule)] text-[13px] text-[var(--color-ink-3)] disabled:opacity-50 hover:bg-[var(--color-paper-2)]"
                >
                  <Trash weight="duotone" size={14} /> remove policy
                </button>
              </div>
            ) : (
              <div className="mono text-[11px] text-[var(--color-ink-4)]">
                only workspace owners can edit the API key max age policy.
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
