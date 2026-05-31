"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ShieldCheck,
  FloppyDisk,
  Warning,
  Trash,
} from "@phosphor-icons/react/dist/ssr";

interface PolicyResponse {
  policy: {
    requireEnrollment: boolean;
    gracePeriodDays: number;
    updatedAt: number | null;
    updatedBy: string | null;
  };
  canEdit: boolean;
  bounds: {
    gracePeriodDays: { min: number; max: number };
  };
}

interface Props {
  workspaceId: string;
}

/**
 * Workspace MFA enrollment policy editor.
 *
 * Owners flip on a workspace-wide requirement that every active member
 * have a confirmed TOTP enrollment. Existing members get the configured
 * grace window from the moment the policy is enabled; new members get
 * the same window from when they join. Once the deadline passes,
 * mutating endpoints refuse the user's requests with HTTP 403
 * mfa_enrollment_required and the dashboard surfaces a banner pointing
 * to /settings/security so the user can self-remediate.
 */
export function MfaPolicyEditor({ workspaceId }: Props) {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [requireEnrollment, setRequireEnrollment] = useState(false);
  const [gracePeriodDays, setGracePeriodDays] = useState(7);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/mfa-policy`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as PolicyResponse;
      setData(j);
      setRequireEnrollment(j.policy.requireEnrollment);
      setGracePeriodDays(j.policy.gracePeriodDays || 7);
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
      const r = await fetch(`/api/workspaces/${workspaceId}/mfa-policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requireEnrollment, gracePeriodDays }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error?.message || j?.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { policy: PolicyResponse["policy"] };
      setData((d) => (d ? { ...d, policy: j.policy } : d));
      setRequireEnrollment(j.policy.requireEnrollment);
      setGracePeriodDays(j.policy.gracePeriodDays || 7);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [data?.canEdit, requireEnrollment, gracePeriodDays, workspaceId]);

  const clear = useCallback(async () => {
    if (!data?.canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/mfa-policy`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { policy: PolicyResponse["policy"] };
      setData((d) => (d ? { ...d, policy: j.policy } : d));
      setRequireEnrollment(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [data?.canEdit, workspaceId]);

  const dirty = data
    ? requireEnrollment !== data.policy.requireEnrollment ||
      (requireEnrollment && gracePeriodDays !== data.policy.gracePeriodDays)
    : false;

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] flex items-center gap-1.5">
          <ShieldCheck weight="duotone" size={14} /> mfa enrollment policy
        </div>
        {savedFlash && (
          <span className="mono text-[10.5px] text-[var(--color-ink-4)]">saved</span>
        )}
      </div>

      <div className="ruled rounded-md p-4">
        <p className="text-[12.5px] text-[var(--color-ink-3)] mb-3 leading-relaxed">
          Require every active member of this workspace to enroll TOTP
          before they can create API keys, webhooks, snippets, or other
          mutations. Members get the grace window from when this policy
          is enabled (or from when they join). After the deadline, their
          requests are refused with HTTP 403
          {" "}<code className="mono text-[11.5px]">mfa_enrollment_required</code>{" "}
          until they enroll at /settings/security.
        </p>

        {status === "loading" && (
          <div className="mono text-[11px] text-[var(--color-ink-4)]" role="status">
            loading...
          </div>
        )}

        {status === "error" && (
          <div className="text-[12.5px] text-red-600 mb-2 flex items-center gap-1.5" role="alert">
            <Warning weight="duotone" size={14} /> {error}
          </div>
        )}

        {status === "ready" && data && (
          <>
            <label className="flex items-center gap-2 mb-3 text-[13px]">
              <input
                type="checkbox"
                checked={requireEnrollment}
                disabled={!data.canEdit || saving}
                onChange={(e) => setRequireEnrollment(e.target.checked)}
                className="h-4 w-4"
              />
              <span>require TOTP enrollment for all members</span>
            </label>

            <label className="block mb-3 max-w-xs">
              <span className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] block mb-1">
                grace period (days)
              </span>
              <input
                type="number"
                min={data.bounds.gracePeriodDays.min}
                max={data.bounds.gracePeriodDays.max}
                value={gracePeriodDays}
                disabled={!data.canEdit || saving || !requireEnrollment}
                onChange={(e) =>
                  setGracePeriodDays(
                    Math.max(0, parseInt(e.target.value || "0", 10) || 0),
                  )
                }
                className="w-full px-3 h-9 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[13px] mono disabled:opacity-60"
                aria-describedby="mfa-policy-bounds"
              />
              <span
                id="mfa-policy-bounds"
                className="mono text-[10.5px] text-[var(--color-ink-4)] mt-1 block"
              >
                {gracePeriodDays === 0 ? "enforce immediately" : `${gracePeriodDays}d window`}
                {" "}(min {data.bounds.gracePeriodDays.min}, max {data.bounds.gracePeriodDays.max})
              </span>
            </label>

            {data.policy.requireEnrollment && (
              <div className="mono text-[10.5px] text-[var(--color-ink-4)] mb-3">
                in force since{" "}
                {data.policy.updatedAt
                  ? new Date(data.policy.updatedAt).toISOString().slice(0, 10)
                  : "unknown"}
                {" "}with a {data.policy.gracePeriodDays}d grace window
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
                  disabled={
                    saving ||
                    (!requireEnrollment && !data.policy.requireEnrollment)
                  }
                  className="inline-flex items-center gap-1.5 px-3 h-9 rounded border border-[var(--color-rule)] text-[13px] text-[var(--color-ink-3)] disabled:opacity-50 hover:bg-[var(--color-paper-2)]"
                >
                  <Trash weight="duotone" size={14} /> remove policy
                </button>
              </div>
            ) : (
              <div className="mono text-[11px] text-[var(--color-ink-4)]">
                only workspace owners can edit the MFA enrollment policy.
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
