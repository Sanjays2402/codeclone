"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ShieldCheck,
  ArrowsClockwise,
  DownloadSimple,
  FunnelSimple,
  CheckCircle,
  XCircle,
  WarningCircle,
  User,
  Clock,
  Tag,
} from "@phosphor-icons/react/dist/ssr";
import { H1 } from "../../components/Headings";
import { Empty, ErrorBlock, LoadingRow } from "../../components/States";
import { fmtTs } from "../../lib/format";

interface AuditEntry {
  id: string;
  ts: number;
  actorId: string | null;
  actorEmail: string | null;
  workspaceId: string | null;
  action: string;
  target: { type: string; id?: string; label?: string } | null;
  status: "ok" | "denied" | "error";
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  diff?: unknown;
  meta?: Record<string, unknown> | null;
}

const STATUS_STYLE: Record<AuditEntry["status"], { icon: typeof CheckCircle; cls: string; label: string }> = {
  ok: { icon: CheckCircle, cls: "text-[var(--color-pos)]", label: "ok" },
  denied: { icon: XCircle, cls: "text-[var(--color-neg)]", label: "denied" },
  error: { icon: WarningCircle, cls: "text-[var(--color-neg)]", label: "error" },
};

function StatusBadge({ status }: { status: AuditEntry["status"] }) {
  const s = STATUS_STYLE[status];
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1 mono text-[11px] ${s.cls}`}>
      <Icon size={14} weight="duotone" />
      {s.label}
    </span>
  );
}

export default function AuditPage() {
  const [items, setItems] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [status, setStatus] = useState<"" | "ok" | "denied" | "error">("");
  const [authed, setAuthed] = useState<boolean | null>(null);

  const buildQuery = useCallback(() => {
    const q = new URLSearchParams();
    if (action.trim()) q.set("action", action.trim());
    if (actor.trim()) q.set("actorId", actor.trim());
    if (workspaceId.trim()) q.set("workspaceId", workspaceId.trim());
    if (status) q.set("status", status);
    q.set("limit", "200");
    return q.toString();
  }, [action, actor, workspaceId, status]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/audit?${buildQuery()}`, { cache: "no-store" });
      if (r.status === 401) {
        setAuthed(false);
        setItems([]);
        return;
      }
      setAuthed(true);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { items: AuditEntry[] };
      setItems(j.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [buildQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const csvHref = useMemo(() => `/api/audit?${buildQuery()}&format=csv`, [buildQuery]);

  return (
    <main className="container py-10">
      <H1 eyebrow="enterprise / audit">
        <span className="inline-flex items-center gap-2">
          <ShieldCheck size={28} weight="duotone" className="text-[var(--color-accent)]" />
          Audit log
        </span>
      </H1>
      <p className="text-[14px] text-[var(--color-ink-2)] -mt-3 mb-6 max-w-2xl">
        Every mutating action across snippets, collections, API keys, webhooks, workspaces, and
        settings is recorded with the actor, IP, request id, and a before / after diff. The log is
        append-only on disk and never edited by the app.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
        className="ruled rounded-md p-4 mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
      >
        <label className="flex flex-col gap-1">
          <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] inline-flex items-center gap-1">
            <Tag size={12} weight="duotone" /> action
          </span>
          <input
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="api_key. or snippet.create"
            className="mono text-[12px] bg-[var(--color-paper-2)] rounded px-2 py-1.5 border border-[var(--color-rule)]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] inline-flex items-center gap-1">
            <User size={12} weight="duotone" /> actor id
          </span>
          <input
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            placeholder="user id"
            className="mono text-[12px] bg-[var(--color-paper-2)] rounded px-2 py-1.5 border border-[var(--color-rule)]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">
            workspace id
          </span>
          <input
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            placeholder="workspace id"
            className="mono text-[12px] bg-[var(--color-paper-2)] rounded px-2 py-1.5 border border-[var(--color-rule)]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">
            status
          </span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            className="mono text-[12px] bg-[var(--color-paper-2)] rounded px-2 py-1.5 border border-[var(--color-rule)]"
          >
            <option value="">any</option>
            <option value="ok">ok</option>
            <option value="denied">denied</option>
            <option value="error">error</option>
          </select>
        </label>
        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 mono text-[12px] px-3 py-1.5 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)]"
          >
            <FunnelSimple size={14} weight="duotone" /> filter
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 mono text-[12px] px-3 py-1.5 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)]"
            title="Refresh"
          >
            <ArrowsClockwise size={14} weight="duotone" />
          </button>
          <a
            href={csvHref}
            className="inline-flex items-center gap-1.5 mono text-[12px] px-3 py-1.5 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)]"
          >
            <DownloadSimple size={14} weight="duotone" /> csv
          </a>
        </div>
      </form>

      {authed === false ? (
        <Empty
          title="Sign in to view the audit log"
          hint="Only signed-in users can read audit history."
          mono="GET /api/audit"
        />
      ) : loading && !items ? (
        <LoadingRow rows={8} />
      ) : error ? (
        <ErrorBlock message={error} />
      ) : !items || items.length === 0 ? (
        <Empty
          title="No audit entries yet"
          hint="Once you create a snippet, rotate a key, or update settings, entries will appear here."
        />
      ) : (
        <div className="ruled rounded-md overflow-hidden">
          <div className="grid grid-cols-[auto_1.1fr_1fr_1.4fr_auto] gap-3 px-4 py-2 mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] border-b border-[var(--color-rule)] bg-[var(--color-paper-2)]">
            <span>status</span>
            <span>when</span>
            <span>actor</span>
            <span>action / target</span>
            <span>ip</span>
          </div>
          {items.map((e) => (
            <div
              key={e.id}
              className="grid grid-cols-[auto_1.1fr_1fr_1.4fr_auto] gap-3 px-4 py-2 items-start text-[12.5px] border-t border-[var(--color-rule)] first:border-t-0"
            >
              <StatusBadge status={e.status} />
              <div className="mono text-[11.5px] text-[var(--color-ink-2)] inline-flex items-center gap-1">
                <Clock size={12} weight="duotone" />
                {fmtTs(e.ts)}
              </div>
              <div className="truncate">
                <div className="truncate">{e.actorEmail ?? "anonymous"}</div>
                {e.workspaceId && (
                  <div className="mono text-[10.5px] text-[var(--color-ink-3)] truncate">
                    ws: {e.workspaceId.slice(0, 8)}
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <div className="mono text-[12px]">{e.action}</div>
                {e.target && (
                  <div className="mono text-[10.5px] text-[var(--color-ink-3)] truncate">
                    {e.target.type}
                    {e.target.id ? `:${e.target.id.slice(0, 12)}` : ""}
                    {e.target.label ? ` (${e.target.label})` : ""}
                  </div>
                )}
              </div>
              <div className="mono text-[10.5px] text-[var(--color-ink-3)]">{e.ip ?? "—"}</div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
