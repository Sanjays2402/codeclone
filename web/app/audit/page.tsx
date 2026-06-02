"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  LinkSimple,
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
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Global "/" shortcut focuses the action filter so power users can jump to
  // the filter box without reaching for the mouse, matching the convention
  // used by GitHub, Linear, and Slack (and the same shortcut already live on
  // /history, /snippets, /collections, and /pairs). Skipped while the user is
  // already typing in another input/textarea/select or a contenteditable
  // surface, so we never hijack a literal slash they meant to type. Ignores
  // modifier combos so browser shortcuts like Cmd+/ keep working.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (t.isContentEditable) return;
      }
      const el = searchInputRef.current;
      if (!el) return;
      e.preventDefault();
      el.focus();
      el.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [actor, setActor] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [status, setStatus] = useState<"" | "ok" | "denied" | "error">("");
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    ok: boolean;
    totalEntries: number;
    chainedEntries: number;
    legacyEntries: number;
    brokenAt: { day: string; seq: number; id: string; reason: string } | null;
    lastHash: string | null;
  } | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [serveVerifying, setServeVerifying] = useState(false);
  const [serveVerify, setServeVerify] = useState<{
    configured: boolean;
    serveUrl?: string;
    reason?: string;
    upstreamStatus?: number;
    reachError?: string | null;
    result?: {
      ok: boolean;
      enabled?: boolean;
      total_entries?: number;
      chained_entries?: number;
      legacy_entries?: number;
      last_hash?: string | null;
      last_seq?: number | null;
      broken_at_seq?: number | null;
      broken_reason?: string | null;
    } | null;
  } | null>(null);
  const [serveVerifyError, setServeVerifyError] = useState<string | null>(null);

  const verifyServeChain = useCallback(async () => {
    setServeVerifying(true);
    setServeVerifyError(null);
    try {
      const r = await fetch("/api/audit/serve-verify", { cache: "no-store" });
      const j = await r.json();
      if (r.status === 401) {
        setServeVerifyError("sign in to verify");
        return;
      }
      setServeVerify(j);
    } catch (e) {
      setServeVerifyError(e instanceof Error ? e.message : String(e));
    } finally {
      setServeVerifying(false);
    }
  }, []);

  const verifyChain = useCallback(async () => {
    setVerifying(true);
    setVerifyError(null);
    try {
      const r = await fetch("/api/audit/verify", { cache: "no-store" });
      const j = await r.json();
      if (r.status === 401) {
        setVerifyError("sign in to verify");
        return;
      }
      setVerifyResult(j);
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : String(e));
    } finally {
      setVerifying(false);
    }
  }, []);

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
        append-only on disk and never edited by the app. You see entries from workspaces you
        belong to plus your own account events; other tenants are filtered out at the query layer.
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
          <div className="relative">
            <input
              ref={searchInputRef}
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="api_key. or snippet.create"
              aria-keyshortcuts="/"
              className="mono text-[12px] bg-[var(--color-paper-2)] rounded px-2 py-1.5 pr-7 border border-[var(--color-rule)] w-full"
            />
            <kbd
              aria-hidden="true"
              title="Press / to focus search"
              className="hidden sm:inline absolute right-1.5 top-1/2 -translate-y-1/2 mono text-[10px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-4)] bg-[var(--color-paper)]"
            >
              /
            </kbd>
          </div>
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
          <button
            type="button"
            onClick={() => void verifyChain()}
            disabled={verifying}
            className="inline-flex items-center gap-1.5 mono text-[12px] px-3 py-1.5 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] disabled:opacity-50"
            title="Verify the on-disk audit hash chain"
          >
            <LinkSimple size={14} weight="duotone" /> verify chain
          </button>
          <button
            type="button"
            onClick={() => void verifyServeChain()}
            disabled={serveVerifying}
            className="inline-flex items-center gap-1.5 mono text-[12px] px-3 py-1.5 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] disabled:opacity-50"
            title="Verify the inference service (/v1) audit hash chain"
          >
            <LinkSimple size={14} weight="duotone" /> verify serve chain
          </button>
        </div>
      </form>

      {(verifyResult || verifyError) && (
        <div
          className={`ruled rounded-md p-3 mb-5 text-[12.5px] flex items-start gap-2 ${
            verifyError
              ? "text-[var(--color-neg)]"
              : verifyResult && verifyResult.ok
                ? "text-[var(--color-pos)]"
                : "text-[var(--color-neg)]"
          }`}
          role="status"
          aria-live="polite"
        >
          {verifyError ? (
            <>
              <WarningCircle size={16} weight="duotone" />
              <span>verify failed: {verifyError}</span>
            </>
          ) : verifyResult && verifyResult.ok ? (
            <>
              <CheckCircle size={16} weight="duotone" />
              <div className="flex-1 min-w-0">
                <div>
                  chain intact: {verifyResult.chainedEntries} chained
                  {verifyResult.legacyEntries > 0
                    ? `, ${verifyResult.legacyEntries} legacy pre-chain`
                    : ""}
                </div>
                {verifyResult.lastHash && (
                  <div className="mono text-[10.5px] text-[var(--color-ink-3)] truncate">
                    head: {verifyResult.lastHash}
                  </div>
                )}
              </div>
            </>
          ) : verifyResult ? (
            <>
              <XCircle size={16} weight="duotone" />
              <div>
                <div>chain broken at day {verifyResult.brokenAt?.day}, seq {verifyResult.brokenAt?.seq}</div>
                <div className="mono text-[10.5px] text-[var(--color-ink-3)]">
                  reason: {verifyResult.brokenAt?.reason}
                </div>
              </div>
            </>
          ) : null}
        </div>
      )}

      {(serveVerify || serveVerifyError) && (
        <div
          className={`ruled rounded-md p-3 mb-5 text-[12.5px] flex items-start gap-2 ${
            serveVerifyError
              ? "text-[var(--color-neg)]"
              : serveVerify && serveVerify.configured && serveVerify.result?.ok
                ? "text-[var(--color-pos)]"
                : serveVerify && !serveVerify.configured
                  ? "text-[var(--color-ink-2)]"
                  : "text-[var(--color-neg)]"
          }`}
          role="status"
          aria-live="polite"
        >
          {serveVerifyError ? (
            <>
              <WarningCircle size={16} weight="duotone" />
              <span>serve verify failed: {serveVerifyError}</span>
            </>
          ) : serveVerify && !serveVerify.configured ? (
            <>
              <WarningCircle size={16} weight="duotone" />
              <div className="flex-1 min-w-0">
                <div>serve chain not configured</div>
                <div className="mono text-[10.5px] text-[var(--color-ink-3)] truncate">
                  set CODECLONE_SERVE_ADMIN_KEY to enable ({serveVerify.serveUrl})
                </div>
              </div>
            </>
          ) : serveVerify && serveVerify.result?.ok ? (
            <>
              <CheckCircle size={16} weight="duotone" />
              <div className="flex-1 min-w-0">
                <div>
                  serve chain intact: {serveVerify.result.chained_entries ?? 0} chained
                  {(serveVerify.result.legacy_entries ?? 0) > 0
                    ? `, ${serveVerify.result.legacy_entries} legacy pre-chain`
                    : ""}
                </div>
                {serveVerify.result.last_hash && (
                  <div className="mono text-[10.5px] text-[var(--color-ink-3)] truncate">
                    head: {serveVerify.result.last_hash} (seq {serveVerify.result.last_seq})
                  </div>
                )}
              </div>
            </>
          ) : serveVerify && serveVerify.result ? (
            <>
              <XCircle size={16} weight="duotone" />
              <div className="min-w-0">
                <div>serve chain broken at seq {serveVerify.result.broken_at_seq}</div>
                <div className="mono text-[10.5px] text-[var(--color-ink-3)]">
                  reason: {serveVerify.result.broken_reason}
                </div>
              </div>
            </>
          ) : serveVerify ? (
            <>
              <XCircle size={16} weight="duotone" />
              <div>
                serve unreachable ({serveVerify.reachError || `HTTP ${serveVerify.upstreamStatus}`})
              </div>
            </>
          ) : null}
        </div>
      )}

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
