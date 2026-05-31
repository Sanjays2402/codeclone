"use client";

import { useCallback, useEffect, useState } from "react";
import { Globe, FloppyDisk, Warning, Trash } from "@phosphor-icons/react/dist/ssr";

interface RegionOption { id: string; label: string }
interface ResidencyResponse {
  residency: {
    region: string | null;
    enforced: boolean;
    updatedAt: number | null;
    updatedBy: string | null;
  };
  canEdit: boolean;
  servingRegion: string;
  match: boolean;
  regions: RegionOption[];
}

interface Props { workspaceId: string }

function fmtDate(ms: number | null): string {
  if (!ms) return "never";
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ") + "Z";
}

/**
 * Owner-only editor for the workspace data residency policy.
 * Pinning a region to anything other than "global" causes the v1 API
 * to refuse requests served by a node whose CODECLONE_REGION does not
 * match, once `enforced` is checked.
 */
export function ResidencyEditor({ workspaceId }: Props) {
  const [data, setData] = useState<ResidencyResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [region, setRegion] = useState<string>("global");
  const [enforced, setEnforced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/residency`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as ResidencyResponse;
      setData(j);
      setRegion(j.residency.region ?? "global");
      setEnforced(j.residency.enforced);
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
      const r = await fetch(`/api/workspaces/${workspaceId}/residency`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ region, enforced }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error((j && j.error) || `HTTP ${r.status}`);
      }
      await load();
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [data?.canEdit, enforced, load, region, workspaceId]);

  const clear = useCallback(async () => {
    if (!data?.canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/residency`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
      setRegion("global");
      setEnforced(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [data?.canEdit, load, workspaceId]);

  const dirty = data
    ? region !== (data.residency.region ?? "global") || enforced !== data.residency.enforced
    : false;

  const isSet = !!data?.residency.region;
  const mismatch = data && isSet && !data.match;

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] flex items-center gap-1.5">
          <Globe weight="duotone" size={14} /> data residency
        </div>
        {savedFlash && (
          <span className="mono text-[10.5px] text-[var(--color-ink-4)]">saved</span>
        )}
      </div>

      <div className="ruled rounded-md p-4">
        <p className="text-[12.5px] text-[var(--color-ink-3)] mb-3 leading-relaxed">
          Pin this workspace&apos;s data to a region. When enforcement is on, the
          public API refuses traffic on nodes outside the pinned region with HTTP
          451 so EU or US-only customers can satisfy procurement. Set to Global
          to remove the restriction.
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
            <div className="grid sm:grid-cols-2 gap-3 mb-3">
              <label className="block">
                <span className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] block mb-1">
                  region
                </span>
                <select
                  value={region}
                  disabled={!data.canEdit || saving}
                  onChange={(e) => setRegion(e.target.value)}
                  className="w-full px-3 h-9 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[13px] disabled:opacity-60"
                >
                  {data.regions.map((r) => (
                    <option key={r.id} value={r.id}>{r.label}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 self-end h-9">
                <input
                  type="checkbox"
                  checked={enforced}
                  disabled={!data.canEdit || saving || region === "global"}
                  onChange={(e) => setEnforced(e.target.checked)}
                  className="accent-current"
                />
                <span className="text-[13px] text-[var(--color-ink-2)]">
                  enforce (refuse out of region traffic)
                </span>
              </label>
            </div>

            <div className="text-[12px] text-[var(--color-ink-3)] mb-3 mono">
              serving region: <span className="text-[var(--color-ink-2)]">{data.servingRegion}</span>
              {data.residency.updatedAt ? (
                <>
                  {" "}&middot; last changed <span className="text-[var(--color-ink-2)]">{fmtDate(data.residency.updatedAt)}</span>
                </>
              ) : null}
            </div>

            {mismatch && (
              <div className="text-[12px] mb-3 px-3 py-2 rounded border border-[var(--color-rule)] bg-[var(--color-paper-2)] text-[var(--color-ink-2)]">
                {data.residency.enforced
                  ? `This node serves "${data.servingRegion}" but the workspace is pinned to "${data.residency.region}". API requests on this node are being refused with HTTP 451.`
                  : `This node serves "${data.servingRegion}" but the workspace is pinned to "${data.residency.region}". Enforcement is off so calls still succeed; mismatches are logged as workspace.residency_warn.`}
              </div>
            )}

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
                {isSet && (
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
          </>
        )}
      </div>
    </section>
  );
}
