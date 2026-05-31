"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ShieldCheck,
  FloppyDisk,
  Warning,
  CheckCircle,
  ClockCounterClockwise,
  XCircle,
  Copy,
  ArrowsClockwise,
} from "@phosphor-icons/react/dist/ssr";

const SUPPORTED = [
  { id: "workspace.wipe", label: "Hard-delete workspace" },
  { id: "workspace.transfer_ownership", label: "Transfer ownership" },
] as const;

type OpId = (typeof SUPPORTED)[number]["id"];

interface PolicyResp {
  policy: { operations: string[]; updatedAt: number; updatedBy: string } | null;
  supportedOperations: readonly string[];
}

interface Approval {
  id: string;
  operation: string;
  payload: Record<string, unknown>;
  reason: string;
  requestedBy: string;
  requestedByEmail: string;
  requestedAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "cancelled" | "consumed" | "expired";
  approvedByEmail?: string;
  approvedAt?: number;
}

function fmt(ms: number): string {
  return new Date(ms).toLocaleString();
}

function statusTone(s: Approval["status"]): string {
  if (s === "pending") return "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200";
  if (s === "approved") return "bg-sky-50 text-sky-900 dark:bg-sky-950 dark:text-sky-200";
  if (s === "consumed") return "bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200";
  return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
}

interface Props {
  workspaceId: string;
  currentUserId: string;
}

export function DualControlEditor({ workspaceId, currentUserId }: Props) {
  const [policy, setPolicy] = useState<PolicyResp | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [enabled, setEnabled] = useState<Record<OpId, boolean>>({
    "workspace.wipe": false,
    "workspace.transfer_ownership": false,
  });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [issuedToken, setIssuedToken] = useState<{ id: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const [pr, ar] = await Promise.all([
        fetch(`/api/workspaces/${workspaceId}/dual-control`, { cache: "no-store" }),
        fetch(`/api/workspaces/${workspaceId}/approvals`, { cache: "no-store" }),
      ]);
      if (!pr.ok) throw new Error(`policy HTTP ${pr.status}`);
      if (!ar.ok) throw new Error(`approvals HTTP ${ar.status}`);
      const pj = (await pr.json()) as PolicyResp;
      const aj = (await ar.json()) as { items: Approval[] };
      setPolicy(pj);
      const ops = new Set(pj.policy?.operations ?? []);
      setEnabled({
        "workspace.wipe": ops.has("workspace.wipe"),
        "workspace.transfer_ownership": ops.has("workspace.transfer_ownership"),
      });
      setApprovals(aj.items);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const ops = SUPPORTED.filter((o) => enabled[o.id]).map((o) => o.id);
      const r = await fetch(`/api/workspaces/${workspaceId}/dual-control`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operations: ops }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(j.message || j.error || `HTTP ${r.status}`);
      }
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [enabled, workspaceId, load]);

  const approve = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const r = await fetch(`/api/workspaces/${workspaceId}/approvals/${id}/approve`, {
          method: "POST",
        });
        const j = await r.json();
        if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`);
        setIssuedToken({ id, token: (j as { token: string }).token });
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [workspaceId, load],
  );

  const cancel = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const r = await fetch(`/api/workspaces/${workspaceId}/approvals/${id}/cancel`, {
          method: "POST",
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error || `HTTP ${r.status}`);
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [workspaceId, load],
  );

  return (
    <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 p-5 bg-white dark:bg-zinc-950">
      <header className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-start gap-3">
          <ShieldCheck weight="duotone" className="w-6 h-6 text-zinc-700 dark:text-zinc-300 mt-0.5" />
          <div>
            <h2 className="text-base font-semibold">Dual-control approvals</h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 max-w-xl">
              Require a second owner to approve the most destructive workspace
              actions. Approvals expire in 30 minutes and are single-use.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 inline-flex items-center gap-1"
        >
          <ArrowsClockwise weight="duotone" className="w-4 h-4" /> Refresh
        </button>
      </header>

      {status === "loading" ? (
        <p className="text-sm text-zinc-500">Loading policy</p>
      ) : status === "error" ? (
        <div className="text-sm text-rose-700 dark:text-rose-300 inline-flex items-center gap-2">
          <Warning weight="duotone" className="w-4 h-4" /> {error}
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {SUPPORTED.map((op) => (
              <label key={op.id} className="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={enabled[op.id]}
                  onChange={(e) =>
                    setEnabled((p) => ({ ...p, [op.id]: e.target.checked }))
                  }
                  className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
                />
                <span>
                  Require approval for{" "}
                  <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-900">
                    {op.id}
                  </span>{" "}
                  <span className="text-zinc-500">({op.label})</span>
                </span>
              </label>
            ))}
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              <FloppyDisk weight="duotone" className="w-4 h-4" />
              {saving ? "Saving" : "Save policy"}
            </button>
            {savedFlash && (
              <span className="text-xs text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
                <CheckCircle weight="duotone" className="w-4 h-4" /> Saved
              </span>
            )}
            {error && (
              <span className="text-xs text-rose-700 dark:text-rose-300 inline-flex items-center gap-1">
                <Warning weight="duotone" className="w-4 h-4" /> {error}
              </span>
            )}
          </div>
          {policy?.policy?.updatedAt ? (
            <p className="text-xs text-zinc-500 mt-2">
              Updated {fmt(policy.policy.updatedAt)}
            </p>
          ) : null}

          <div className="mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-800">
            <h3 className="text-sm font-semibold mb-3 inline-flex items-center gap-2">
              <ClockCounterClockwise weight="duotone" className="w-4 h-4" /> Approval queue
            </h3>
            {approvals.length === 0 ? (
              <p className="text-sm text-zinc-500">No pending approvals.</p>
            ) : (
              <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-md border border-zinc-200 dark:border-zinc-800">
                {approvals.map((a) => {
                  const isOwn = a.requestedBy === currentUserId;
                  const isActionable = a.status === "pending" && !isOwn;
                  return (
                    <li key={a.id} className="p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-2 py-0.5 rounded ${statusTone(a.status)}`}>
                            {a.status}
                          </span>
                          <span className="font-mono text-xs">{a.operation}</span>
                        </div>
                        <span className="text-xs text-zinc-500">
                          Requested {fmt(a.requestedAt)} by {a.requestedByEmail}
                        </span>
                      </div>
                      <p className="text-zinc-700 dark:text-zinc-300 mt-1">{a.reason}</p>
                      {Object.keys(a.payload).length > 0 && (
                        <pre className="mt-2 text-xs bg-zinc-50 dark:bg-zinc-900 rounded p-2 overflow-x-auto">
                          {JSON.stringify(a.payload, null, 2)}
                        </pre>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {isActionable && (
                          <button
                            type="button"
                            onClick={() => void approve(a.id)}
                            className="inline-flex items-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1 text-xs font-medium"
                          >
                            <CheckCircle weight="duotone" className="w-4 h-4" /> Approve
                          </button>
                        )}
                        {isOwn && a.status === "pending" && (
                          <span className="text-xs text-zinc-500">
                            A different owner must approve this request.
                          </span>
                        )}
                        {(a.status === "pending" || a.status === "approved") && (
                          <button
                            type="button"
                            onClick={() => void cancel(a.id)}
                            className="inline-flex items-center gap-1 rounded-md border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-xs"
                          >
                            <XCircle weight="duotone" className="w-4 h-4" /> Cancel
                          </button>
                        )}
                        {a.approvedByEmail && (
                          <span className="text-xs text-zinc-500">
                            Approved by {a.approvedByEmail}
                          </span>
                        )}
                      </div>
                      {issuedToken?.id === a.id && (
                        <div className="mt-2 rounded-md border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950 p-2 text-xs">
                          <p className="font-medium mb-1">One-time approval token (shown once):</p>
                          <div className="flex items-center gap-2">
                            <code className="flex-1 break-all font-mono">{issuedToken.token}</code>
                            <button
                              type="button"
                              onClick={() => {
                                void navigator.clipboard.writeText(issuedToken.token);
                                setCopied(true);
                                setTimeout(() => setCopied(false), 1200);
                              }}
                              className="inline-flex items-center gap-1 rounded border border-emerald-400 dark:border-emerald-700 px-2 py-0.5"
                            >
                              <Copy weight="duotone" className="w-3.5 h-3.5" />
                              {copied ? "Copied" : "Copy"}
                            </button>
                          </div>
                          <p className="text-zinc-600 dark:text-zinc-400 mt-1">
                            Pass as <code>approval_token</code> in the destructive call body.
                          </p>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
