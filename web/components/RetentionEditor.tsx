"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, FloppyDisk, Warning, Trash, MagnifyingGlass } from "@phosphor-icons/react/dist/ssr";

interface RetentionResponse {
  policy: {
    auditDays: number;
    updatedAt: number | null;
    updatedBy: string | null;
  };
  cutoffMs: number | null;
  canEdit: boolean;
  bounds: { auditDays: { min: number; max: number } };
}

interface PurgePreview {
  dryRun: true;
  cutoffMs: number | null;
  affectedEntries: number;
  affectedFiles: string[];
  scannedFiles: number;
  scannedEntries: number;
  oldestAffectedTs: number | null;
  newestAffectedTs: number | null;
  note: string;
}

interface Props {
  workspaceId: string;
}

function fmtDate(ms: number | null): string {
  if (!ms) return "never";
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ") + "Z";
}

/**
 * Owner-only editor for the workspace audit log retention policy.
 *
 * The policy is enforced at the read layer in lib/audit#listAudit so the
 * tamper-evident hash chain stays verifiable. The preview button calls
 * the dry-run purge endpoint and shows how many entries would be hidden
 * under the current or proposed window.
 */
export function RetentionEditor({ workspaceId }: Props) {
  const [data, setData] = useState<RetentionResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [auditDays, setAuditDays] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [preview, setPreview] = useState<PurgePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/retention`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as RetentionResponse;
      setData(j);
      setAuditDays(j.policy.auditDays);
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
      const r = await fetch(`/api/workspaces/${workspaceId}/retention`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ auditDays }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { policy: RetentionResponse["policy"]; cutoffMs: number | null };
      setData((d) => (d ? { ...d, policy: j.policy, cutoffMs: j.cutoffMs } : d));
      setAuditDays(j.policy.auditDays);
      setSavedFlash(true);
      setPreview(null);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [auditDays, data?.canEdit, workspaceId]);

  const clear = useCallback(async () => {
    if (!data?.canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/retention`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { policy: RetentionResponse["policy"]; cutoffMs: number | null };
      setData((d) => (d ? { ...d, policy: j.policy, cutoffMs: j.cutoffMs } : d));
      setAuditDays(0);
      setPreview(null);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [data?.canEdit, workspaceId]);

  const runPreview = useCallback(async () => {
    if (!data?.canEdit) return;
    setPreviewing(true);
    setError(null);
    try {
      const body = auditDays > 0 ? { auditDays } : {};
      const r = await fetch(`/api/workspaces/${workspaceId}/retention/purge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      setPreview((await r.json()) as PurgePreview);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  }, [auditDays, data?.canEdit, workspaceId]);

  const dirty = data ? auditDays !== data.policy.auditDays : false;

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] flex items-center gap-1.5">
          <Archive weight="duotone" size={14} /> audit retention
        </div>
        {savedFlash && (
          <span className="mono text-[10.5px] text-[var(--color-ink-4)]">saved</span>
        )}
      </div>

      <div className="ruled rounded-md p-4">
        <p className="text-[12.5px] text-[var(--color-ink-3)] mb-3 leading-relaxed">
          Hide audit entries for this workspace older than N days from every
          read path, including CSV export and the audit UI. The underlying
          hash-chained log on disk is preserved so SOC2 tamper-evidence
          stays verifiable. Use 0 to keep everything visible.
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
            <div className="mb-3">
              <label className="block max-w-sm">
                <span className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] block mb-1">
                  retention window (days)
                </span>
                <input
                  type="number"
                  min={0}
                  max={data.bounds.auditDays.max}
                  value={auditDays}
                  disabled={!data.canEdit || saving}
                  onChange={(e) => setAuditDays(Math.max(0, parseInt(e.target.value || "0", 10) || 0))}
                  className="w-full px-3 h-9 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[13px] mono disabled:opacity-60"
                />
                <span className="mono text-[10.5px] text-[var(--color-ink-4)] mt-1 block">
                  {auditDays === 0
                    ? "no retention (keep forever)"
                    : `${auditDays} days (min ${data.bounds.auditDays.min}, max ${data.bounds.auditDays.max})`}
                </span>
              </label>
            </div>

            <div className="text-[12px] text-[var(--color-ink-3)] mb-3 mono">
              current cutoff: <span className="text-[var(--color-ink-2)]">{fmtDate(data.cutoffMs)}</span>
              {data.policy.updatedAt ? (
                <>
                  {" "}· last changed <span className="text-[var(--color-ink-2)]">{fmtDate(data.policy.updatedAt)}</span>
                </>
              ) : null}
            </div>

            {error && (
              <div className="text-[12.5px] text-red-600 mb-2 flex items-center gap-1.5">
                <Warning weight="duotone" size={14} /> {error}
              </div>
            )}

            {data.canEdit ? (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || !dirty}
                  className="inline-flex items-center gap-1.5 px-3 h-8 rounded border border-[var(--color-rule)] text-[13px] bg-[var(--color-paper)] hover:bg-[var(--color-paper-2)] disabled:opacity-50"
                >
                  <FloppyDisk weight="duotone" size={14} /> save
                </button>
                <button
                  type="button"
                  onClick={runPreview}
                  disabled={previewing}
                  className="inline-flex items-center gap-1.5 px-3 h-8 rounded border border-[var(--color-rule)] text-[13px] text-[var(--color-ink-3)] hover:bg-[var(--color-paper-2)] disabled:opacity-50"
                >
                  <MagnifyingGlass weight="duotone" size={14} /> preview hidden
                </button>
                {data.policy.auditDays > 0 && (
                  <button
                    type="button"
                    onClick={clear}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 px-3 h-8 rounded border border-[var(--color-rule)] text-[13px] text-[var(--color-ink-3)] hover:bg-[var(--color-paper-2)] disabled:opacity-50"
                  >
                    <Trash weight="duotone" size={14} /> clear
                  </button>
                )}
              </div>
            ) : (
              <div className="mono text-[11px] text-[var(--color-ink-4)]">owner only</div>
            )}

            {preview && (
              <div className="mt-4 ruled rounded p-3 bg-[var(--color-paper-2)]">
                <div className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] mb-2">
                  dry run
                </div>
                {preview.cutoffMs == null ? (
                  <div className="text-[12.5px] text-[var(--color-ink-3)]">
                    No retention window. Nothing would be hidden.
                  </div>
                ) : preview.affectedEntries === 0 ? (
                  <div className="text-[12.5px] text-[var(--color-ink-3)]">
                    No entries fall outside the {auditDays || data.policy.auditDays} day window. Scanned{" "}
                    {preview.scannedEntries} entries across {preview.scannedFiles} day files.
                  </div>
                ) : (
                  <div className="text-[12.5px] text-[var(--color-ink-3)] space-y-1">
                    <div>
                      <span className="mono text-[var(--color-ink-2)]">{preview.affectedEntries}</span> entries
                      would be hidden across{" "}
                      <span className="mono text-[var(--color-ink-2)]">{preview.affectedFiles.length}</span> day
                      files.
                    </div>
                    <div className="mono text-[11px] text-[var(--color-ink-4)]">
                      oldest {fmtDate(preview.oldestAffectedTs)} · newest {fmtDate(preview.newestAffectedTs)}
                    </div>
                    <div className="mono text-[11px] text-[var(--color-ink-4)]">
                      cutoff {fmtDate(preview.cutoffMs)}
                    </div>
                  </div>
                )}
                <p className="text-[11.5px] text-[var(--color-ink-4)] mt-2 leading-relaxed">
                  {preview.note}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
