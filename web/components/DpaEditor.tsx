"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, CheckCircle, Warning, ShieldCheck } from "@phosphor-icons/react/dist/ssr";

interface DpaStatus {
  currentVersion: string;
  summary: string;
  accepted: boolean;
  stale: boolean;
  required: boolean;
  acceptance: {
    version: string;
    acceptedAt: number;
    acceptedByUserId: string;
    acceptedByEmail: string;
    acceptedFromIp: string | null;
  } | null;
}

interface DpaResponse {
  status: DpaStatus;
  canEdit: boolean;
}

interface Props {
  workspaceId: string;
}

function fmtTs(ms: number): string {
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  } catch {
    return String(ms);
  }
}

/**
 * Workspace Data Processing Agreement editor.
 *
 * Owners must accept the current DPA version before /v1 endpoints will
 * process customer code. Acceptance pins version, signatory, timestamp,
 * and source IP for procurement / SOC 2 evidence. Bumping
 * DPA_CURRENT_VERSION (lib/dpa.ts) immediately invalidates older
 * acceptances and forces a fresh re-accept.
 */
export function DpaEditor({ workspaceId }: Props) {
  const [data, setData] = useState<DpaResponse | null>(null);
  const [view, setView] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setView("loading");
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/dpa`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as DpaResponse;
      setData(j);
      setView("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setView("error");
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const accept = useCallback(async () => {
    if (!data?.canEdit) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/dpa`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: data.status.currentVersion }),
      });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try {
          const j = (await r.json()) as { error?: { message?: string } };
          if (j.error?.message) msg = j.error.message;
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [data, workspaceId, load]);

  const withdraw = useCallback(async () => {
    if (!data?.canEdit) return;
    if (!confirm("Withdraw DPA acceptance? /v1 calls for this workspace will be blocked until a new acceptance is recorded.")) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/dpa`, { method: "DELETE" });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try {
          const j = (await r.json()) as { error?: { message?: string } };
          if (j.error?.message) msg = j.error.message;
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [data, workspaceId, load]);

  if (view === "loading") {
    return (
      <section className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex items-center gap-2 text-sm text-neutral-500">
          <FileText weight="duotone" className="h-4 w-4" />
          Loading DPA status
        </div>
      </section>
    );
  }

  if (view === "error" || !data) {
    return (
      <section className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30">
        <div className="flex items-start gap-2 text-sm text-red-700 dark:text-red-300">
          <Warning weight="duotone" className="mt-0.5 h-4 w-4" />
          <div>
            <div className="font-medium">DPA status unavailable</div>
            <div className="opacity-80">{error ?? "Unknown error"}</div>
          </div>
        </div>
      </section>
    );
  }

  const s = data.status;
  const accepted = s.accepted;
  const stateColor = accepted
    ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30"
    : "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30";

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck weight="duotone" className="h-5 w-5 text-neutral-700 dark:text-neutral-300" />
        <h2 className="text-sm font-semibold">Data Processing Agreement</h2>
      </div>

      <p className="mb-3 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
        {s.summary}
      </p>

      <div className={`rounded-md border p-3 text-sm ${stateColor}`}>
        {accepted ? (
          <div className="flex items-start gap-2">
            <CheckCircle weight="duotone" className="mt-0.5 h-4 w-4 text-emerald-700 dark:text-emerald-300" />
            <div className="space-y-1">
              <div className="font-medium text-emerald-900 dark:text-emerald-200">
                Accepted, version {s.acceptance?.version}
              </div>
              <div className="text-emerald-800/80 dark:text-emerald-300/80">
                {s.acceptance?.acceptedByEmail}, {fmtTs(s.acceptance?.acceptedAt ?? 0)}
                {s.acceptance?.acceptedFromIp ? `, from ${s.acceptance.acceptedFromIp}` : ""}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <Warning weight="duotone" className="mt-0.5 h-4 w-4 text-amber-700 dark:text-amber-300" />
            <div className="space-y-1">
              <div className="font-medium text-amber-900 dark:text-amber-200">
                {s.stale ? "Re-acceptance required" : "Acceptance required"}
              </div>
              <div className="text-amber-800/80 dark:text-amber-300/80">
                {s.stale
                  ? `Workspace pinned version ${s.acceptance?.version}, current is ${s.currentVersion}. /v1 calls are blocked until an owner accepts ${s.currentVersion}.`
                  : `/v1 calls are blocked until an owner accepts version ${s.currentVersion}.`}
              </div>
            </div>
          </div>
        )}
      </div>

      {data.canEdit ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={accept}
            disabled={busy || accepted}
            className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            <CheckCircle weight="duotone" className="h-4 w-4" />
            {accepted ? "Already accepted" : `Accept version ${s.currentVersion}`}
          </button>
          {accepted ? (
            <button
              type="button"
              onClick={withdraw}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              Withdraw
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-neutral-500">Only workspace owners can accept the DPA.</p>
      )}

      {error ? (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}
    </section>
  );
}
