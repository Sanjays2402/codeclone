"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Plugs,
  Plus,
  Trash,
  Check,
  Copy,
  Warning,
  CheckCircle,
  XCircle,
  Pause,
  Play,
  ArrowClockwise,
  CaretDown,
  CaretRight,
  Buildings,
  Key,
  ArrowsClockwise,
} from "@phosphor-icons/react/dist/ssr";
import { H1, H2 } from "../../components/Headings";
import { Empty, ErrorBlock, LoadingRow } from "../../components/States";
import { fmtInt, fmtTs } from "../../lib/format";

interface WebhookSummary {
  id: string;
  workspaceId?: string;
  label: string;
  url: string;
  events: string[];
  secretPrefix: string;
  pendingSecretPrefix?: string;
  pendingCreatedAt?: number;
  pendingExpiresAt?: number;
  createdAt: number;
  updatedAt?: number;
  disabled?: boolean;
  successCount: number;
  failureCount: number;
  lastDeliveryAt?: number;
  lastStatus?: number;
  lastError?: string;
}

interface DeliveryRecord {
  id: string;
  webhookId: string;
  event: string;
  attemptedAt: number;
  attempts: number;
  status: number;
  ok: boolean;
  durationMs: number;
  error?: string;
  requestBodyPreview: string;
  responseBodyPreview?: string;
  redeliveredFrom?: string;
}

type Status = "loading" | "ready" | "error";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          /* clipboard blocked */
        }
      }}
      className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)]"
    >
      {copied ? <Check size={12} weight="bold" /> : <Copy size={12} weight="duotone" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

interface WorkspaceOption {
  id: string;
  name: string;
  slug: string;
  myRole: "owner" | "editor" | "viewer" | null;
}

export default function WebhooksPage() {
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [wsStatus, setWsStatus] = useState<Status>("loading");
  const [wsError, setWsError] = useState("");
  const [activeWs, setActiveWs] = useState<string>("");
  const [items, setItems] = useState<WebhookSummary[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>(["compare.completed"]);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState("");
  const [revealed, setRevealed] = useState<{ id: string; secret: string; kind: "create" | "rotate"; expiresAt?: number } | null>(null);
  const [busy, setBusy] = useState("");
  const [rotateErr, setRotateErr] = useState("");
  const [open, setOpen] = useState<string>("");
  const [deliveries, setDeliveries] = useState<Record<string, DeliveryRecord[]>>({});
  const [delivStatus, setDelivStatus] = useState<Record<string, Status>>({});
  const [redelivering, setRedelivering] = useState<string>("");
  const [redeliverErr, setRedeliverErr] = useState<string>("");

  const myRole = useMemo(
    () => workspaces.find((w) => w.id === activeWs)?.myRole ?? null,
    [workspaces, activeWs],
  );
  const canWrite = myRole === "owner" || myRole === "editor";

  const loadWorkspaces = useCallback(async () => {
    setWsStatus("loading");
    setWsError("");
    try {
      const res = await fetch("/api/workspaces", { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 401) {
          setWsError("Sign in to manage webhooks.");
          setWsStatus("error");
          return;
        }
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Request failed (${res.status}).`);
      }
      const j = (await res.json()) as { items: WorkspaceOption[] };
      setWorkspaces(j.items ?? []);
      setWsStatus("ready");
      if (j.items && j.items.length > 0) {
        setActiveWs((prev) => (prev && j.items.some((w) => w.id === prev) ? prev : j.items[0].id));
      }
    } catch (e) {
      setWsError(e instanceof Error ? e.message : String(e));
      setWsStatus("error");
    }
  }, []);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  const refresh = useCallback(async () => {
    if (!activeWs) {
      setStatus("ready");
      setItems([]);
      return;
    }
    setStatus("loading");
    try {
      const res = await fetch(`/api/webhooks?workspaceId=${encodeURIComponent(activeWs)}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
        const msg =
          typeof j.error === "string"
            ? j.error
            : j.error?.message ?? `Request failed (${res.status}).`;
        throw new Error(msg);
      }
      const j = (await res.json()) as { items: WebhookSummary[] };
      setItems(j.items ?? []);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [activeWs]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setCreateErr("");
      setCreating(true);
      try {
        const res = await fetch("/api/webhooks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: label.trim() || "Untitled webhook",
            url: url.trim(),
            events: selectedEvents.length ? selectedEvents : ["compare.completed"],
            workspaceId: activeWs,
          }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          record?: WebhookSummary;
          secret?: string;
          error?: string;
        };
        if (!res.ok || !j.record || !j.secret) {
          throw new Error(j.error ?? `Request failed (${res.status}).`);
        }
        setRevealed({ id: j.record.id, secret: j.secret, kind: "create" });
        setLabel("");
        setUrl("");
        setSelectedEvents(["compare.completed"]);
        await refresh();
      } catch (err) {
        setCreateErr(err instanceof Error ? err.message : String(err));
      } finally {
        setCreating(false);
      }
    },
    [label, url, selectedEvents, refresh, activeWs],
  );

  const toggle = useCallback(
    async (id: string, disabled: boolean) => {
      setBusy(id);
      try {
        await fetch(`/api/webhooks/${id}?workspaceId=${encodeURIComponent(activeWs)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ disabled }),
        });
        await refresh();
      } finally {
        setBusy("");
      }
    },
    [refresh, activeWs],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!confirm("Delete this webhook? Delivery history will be removed.")) return;
      setBusy(id);
      try {
        await fetch(`/api/webhooks/${id}?workspaceId=${encodeURIComponent(activeWs)}`, {
          method: "DELETE",
        });
        await refresh();
      } finally {
        setBusy("");
      }
    },
    [refresh, activeWs],
  );

  const rotate = useCallback(
    async (id: string) => {
      if (
        !confirm(
          "Issue a new signing secret? Both the current and new secret will sign every delivery for 24 hours so you can roll receivers forward without dropped events.",
        )
      )
        return;
      setBusy(id);
      setRotateErr("");
      try {
        const res = await fetch(
          `/api/webhooks/${id}/rotate?workspaceId=${encodeURIComponent(activeWs)}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        );
        const j = (await res.json().catch(() => ({}))) as {
          secret?: string;
          record?: WebhookSummary;
          expiresAt?: number;
          error?: { message?: string } | string;
        };
        if (!res.ok || !j.secret || !j.record) {
          const msg =
            typeof j.error === "string"
              ? j.error
              : j.error?.message ?? `Rotation failed (${res.status}).`;
          throw new Error(msg);
        }
        setRevealed({ id: j.record.id, secret: j.secret, kind: "rotate", expiresAt: j.expiresAt });
        await refresh();
      } catch (e) {
        setRotateErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy("");
      }
    },
    [activeWs, refresh],
  );

  const finalize = useCallback(
    async (id: string) => {
      if (!confirm("Finalize rotation now? The old signing secret will stop working immediately.")) return;
      setBusy(id);
      setRotateErr("");
      try {
        const res = await fetch(
          `/api/webhooks/${id}/rotate?workspaceId=${encodeURIComponent(activeWs)}`,
          { method: "PUT" },
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
          const msg =
            typeof j.error === "string"
              ? j.error
              : j.error?.message ?? `Finalize failed (${res.status}).`;
          throw new Error(msg);
        }
        await refresh();
      } catch (e) {
        setRotateErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy("");
      }
    },
    [activeWs, refresh],
  );

  const cancelRotate = useCallback(
    async (id: string) => {
      if (!confirm("Cancel the in-flight rotation? The pending secret will be discarded.")) return;
      setBusy(id);
      setRotateErr("");
      try {
        const res = await fetch(
          `/api/webhooks/${id}/rotate?workspaceId=${encodeURIComponent(activeWs)}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
          const msg =
            typeof j.error === "string"
              ? j.error
              : j.error?.message ?? `Cancel failed (${res.status}).`;
          throw new Error(msg);
        }
        await refresh();
      } catch (e) {
        setRotateErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy("");
      }
    },
    [activeWs, refresh],
  );

  const loadDeliveries = useCallback(
    async (id: string) => {
      setDelivStatus((s) => ({ ...s, [id]: "loading" }));
      try {
        const res = await fetch(
          `/api/webhooks/${id}/deliveries?workspaceId=${encodeURIComponent(activeWs)}`,
          { cache: "no-store" },
        );
        const j = (await res.json()) as { items?: DeliveryRecord[] };
        setDeliveries((d) => ({ ...d, [id]: j.items ?? [] }));
        setDelivStatus((s) => ({ ...s, [id]: "ready" }));
      } catch {
        setDelivStatus((s) => ({ ...s, [id]: "error" }));
      }
    },
    [activeWs],
  );

  const redeliver = useCallback(
    async (webhookId: string, deliveryId: string) => {
      setRedeliverErr("");
      setRedelivering(deliveryId);
      try {
        const res = await fetch(
          `/api/webhooks/${webhookId}/deliveries/${deliveryId}/redeliver?workspaceId=${encodeURIComponent(activeWs)}`,
          { method: "POST" },
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
          const msg =
            typeof j.error === "string"
              ? j.error
              : j.error?.message ?? `Redelivery failed (${res.status}).`;
          throw new Error(msg);
        }
        await loadDeliveries(webhookId);
        await refresh();
      } catch (e) {
        setRedeliverErr(e instanceof Error ? e.message : "Redelivery failed.");
      } finally {
        setRedelivering("");
      }
    },
    [loadDeliveries, refresh, activeWs],
  );

  const toggleOpen = useCallback(
    (id: string) => {
      const next = open === id ? "" : id;
      setOpen(next);
      if (next && !deliveries[id]) void loadDeliveries(id);
    },
    [open, deliveries, loadDeliveries],
  );

  return (
    <main className="mx-auto max-w-[1100px] px-7 py-10">
      <H1 eyebrow="settings">webhooks</H1>
      <p className="text-[14px] text-[var(--color-ink-2)] max-w-[640px] -mt-3 mb-6">
        Get a real-time POST to your URL every time a customer compares
        code through your API key. Each delivery is signed, retried up to
        three times on failure, and logged here for the last 50 events.
        Webhooks are scoped to a single workspace and never visible to other
        tenants.
      </p>

      <section className="ruled rounded-md p-4 mb-8 flex flex-wrap items-center gap-3">
        <Buildings size={16} weight="duotone" className="text-[var(--color-ink-3)]" />
        <label htmlFor="ws-picker" className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">
          workspace
        </label>
        {wsStatus === "loading" && (
          <span className="mono text-[11.5px] text-[var(--color-ink-3)]">Loading workspaces...</span>
        )}
        {wsStatus === "error" && (
          <span className="mono text-[11.5px] text-[var(--color-neg)]">{wsError}</span>
        )}
        {wsStatus === "ready" && workspaces.length === 0 && (
          <span className="mono text-[11.5px] text-[var(--color-ink-3)]">
            You are not a member of any workspace yet. Create one from <Link className="underline" href="/workspaces">Workspaces</Link>.
          </span>
        )}
        {wsStatus === "ready" && workspaces.length > 0 && (
          <>
            <select
              id="ws-picker"
              value={activeWs}
              onChange={(e) => setActiveWs(e.target.value)}
              className="bg-[var(--color-paper)] border border-[var(--color-rule)] rounded-sm px-2 py-1 text-[12.5px] outline-none focus:border-[var(--color-ink-3)]"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.myRole ?? "member"})
                </option>
              ))}
            </select>
            {myRole === "viewer" && (
              <span className="mono text-[10.5px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-3)]">
                read only
              </span>
            )}
          </>
        )}
      </section>

      <section className="ruled rounded-md p-5 mb-10">
        <H2 eyebrow="register">add an endpoint</H2>
        <form onSubmit={create} className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-3 items-start">
          <div className="flex flex-col gap-1">
            <label className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">label</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="prod relay"
              maxLength={60}
              className="bg-[var(--color-paper)] border border-[var(--color-rule)] rounded-sm px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--color-ink-3)]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">target url</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.example.com/codeclone/hook"
              required
              className="mono bg-[var(--color-paper)] border border-[var(--color-rule)] rounded-sm px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--color-ink-3)]"
            />
            <span className="mono text-[10.5px] text-[var(--color-ink-3)]">
              must be a public https endpoint. loopback, RFC1918, link-local, and cloud metadata addresses are blocked at create and at delivery.
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-transparent select-none">submit</span>
            <button
              type="submit"
              disabled={creating || !url.trim() || !activeWs || !canWrite}
              className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[var(--color-rule)] bg-[var(--color-paper-2)] hover:bg-[var(--color-paper-3)] disabled:opacity-50"
              title={!canWrite && activeWs ? "Viewers cannot create webhooks." : undefined}
            >
              <Plus size={12} weight="bold" />
              {creating ? "Creating" : "Create webhook"}
            </button>
          </div>
          <div className="flex flex-col gap-1 md:col-span-3">
            <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">events</span>
            <div className="flex flex-wrap gap-3 mono text-[12px] text-[var(--color-ink-2)]">
              {[
                { id: "compare.completed", hint: "fires when a /v1/compare run finishes" },
                { id: "batch.completed", hint: "fires when a /v1/batch job finishes" },
                { id: "audit.recorded", hint: "streams every audit entry written for this workspace to your SIEM" },
              ].map((ev) => (
                <label key={ev.id} className="flex items-center gap-1.5 cursor-pointer" title={ev.hint}>
                  <input
                    type="checkbox"
                    checked={selectedEvents.includes(ev.id)}
                    onChange={(e) => {
                      setSelectedEvents((prev) =>
                        e.target.checked
                          ? Array.from(new Set([...prev, ev.id]))
                          : prev.filter((x) => x !== ev.id),
                      );
                    }}
                  />
                  <span>{ev.id}</span>
                </label>
              ))}
            </div>
            <span className="mono text-[10.5px] text-[var(--color-ink-3)]">
              audit.recorded forwards every audit entry for this workspace in real time. payload omits diff and meta to keep SIEM volume bounded.
            </span>
          </div>
        </form>
        {createErr && (
          <div className="mt-3 mono text-[12px] text-[var(--color-neg)] flex items-center gap-1.5">
            <Warning size={13} weight="duotone" /> {createErr}
          </div>
        )}
        {revealed && (
          <div className="mt-4 ruled rounded-sm p-3 bg-[var(--color-accent-soft)] border-[color:var(--color-accent)]">
            <div className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-accent-ink)] mb-1.5 flex items-center gap-1.5">
              <Warning size={12} weight="duotone" /> {revealed.kind === "rotate" ? "new signing secret shown once" : "signing secret shown once"}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <code className="mono text-[12px] bg-[var(--color-paper)] px-2 py-1 rounded-sm border border-[var(--color-rule)] break-all">
                {revealed.secret}
              </code>
              <CopyButton text={revealed.secret} />
            </div>
            <p className="mt-2 text-[12px] text-[var(--color-ink-3)]">
              Store this somewhere safe. We only persist its hash. The
              hash is also sent on every delivery via
              <code className="mono px-1">X-CodeClone-Hash</code> so your
              server can verify origin.
              {revealed.kind === "rotate" && (
                <>
                  {" "}During the grace window every delivery is also
                  signed with this new secret via
                  <code className="mono px-1">X-CodeClone-Signature-Next</code>.
                  Roll your verifier forward, then finalize to retire the old secret.
                </>
              )}
            </p>
          </div>
        )}
      </section>

      <H2 eyebrow="endpoints" right={
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex items-center gap-1.5 mono text-[10.5px] uppercase tracking-[0.16em] px-2 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)]"
        >
          <ArrowClockwise size={11} weight="duotone" /> refresh
        </button>
      }>registered webhooks</H2>

      {status === "loading" && <LoadingRow rows={3} />}
      {status === "error" && <ErrorBlock message={error} />}
      {status === "ready" && items.length === 0 && (
        <Empty
          title={activeWs ? "No webhooks yet." : "Select a workspace."}
          hint={
            activeWs
              ? "Register a URL above to start receiving compare.completed events."
              : "Pick a workspace above to view its webhook endpoints."
          }
        />
      )}
      {status === "ready" && items.length > 0 && (
        <div className="ruled rounded-md overflow-hidden">
          {items.map((w, idx) => {
            const isOpen = open === w.id;
            return (
              <div
                key={w.id}
                className={idx > 0 ? "border-t border-[var(--color-rule)]" : ""}
              >
                <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    onClick={() => toggleOpen(w.id)}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left"
                    aria-expanded={isOpen}
                  >
                    {isOpen ? <CaretDown size={12} weight="bold" /> : <CaretRight size={12} weight="bold" />}
                    <Plugs size={16} weight="duotone" className="text-[var(--color-ink-3)] shrink-0" />
                    <span className="text-[13.5px] font-medium truncate">{w.label}</span>
                    {w.disabled && (
                      <span className="mono text-[10px] uppercase tracking-[0.14em] px-1.5 py-px rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-3)]">paused</span>
                    )}
                  </button>
                  <code className="mono text-[11.5px] text-[var(--color-ink-3)] truncate max-w-[280px]">{w.url}</code>
                  <span className="inline-flex items-center gap-1 mono text-[11px] text-[var(--color-pos)]">
                    <CheckCircle size={12} weight="duotone" />
                    {fmtInt(w.successCount)}
                  </span>
                  <span className="inline-flex items-center gap-1 mono text-[11px] text-[var(--color-neg)]">
                    <XCircle size={12} weight="duotone" />
                    {fmtInt(w.failureCount)}
                  </span>
                  <span className="mono text-[10.5px] text-[var(--color-ink-3)]">{fmtTs(w.lastDeliveryAt ?? w.createdAt)}</span>
                  <button
                    type="button"
                    disabled={busy === w.id || !canWrite}
                    onClick={() => void toggle(w.id, !w.disabled)}
                    aria-label={w.disabled ? "Resume" : "Pause"}
                    title={!canWrite ? "Viewers cannot modify webhooks." : undefined}
                    className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)] disabled:opacity-50"
                  >
                    {w.disabled ? <Play size={11} weight="duotone" /> : <Pause size={11} weight="duotone" />}
                    {w.disabled ? "resume" : "pause"}
                  </button>
                  <button
                    type="button"
                    disabled={busy === w.id || !canWrite}
                    onClick={() => void rotate(w.id)}
                    aria-label="Rotate signing secret"
                    title={!canWrite ? "Viewers cannot rotate webhook secrets." : "Issue a new signing secret with a 24h dual-sign window."}
                    className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)] disabled:opacity-50"
                  >
                    <ArrowsClockwise size={11} weight="duotone" /> rotate
                  </button>
                  <button
                    type="button"
                    disabled={busy === w.id || !canWrite}
                    onClick={() => void remove(w.id)}
                    aria-label="Delete webhook"
                    title={!canWrite ? "Viewers cannot delete webhooks." : undefined}
                    className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-neg-soft)] text-[var(--color-neg)] disabled:opacity-50"
                  >
                    <Trash size={11} weight="duotone" /> delete
                  </button>
                </div>
                {isOpen && (
                  <div className="px-4 pb-4 pt-1 bg-[var(--color-paper-2)] border-t border-[var(--color-rule)]">
                    <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 mono text-[11.5px] text-[var(--color-ink-3)]">
                      <span>events: <span className="text-[var(--color-ink-2)]">{w.events.join(", ")}</span></span>
                      <span>secret: <span className="text-[var(--color-ink-2)]">{w.secretPrefix}…</span></span>
                      <span>created: <span className="text-[var(--color-ink-2)]">{fmtTs(w.createdAt)}</span></span>
                      {w.lastError && (
                        <span className="text-[var(--color-neg)]">last error: {w.lastError}</span>
                      )}
                    </div>
                    {w.pendingSecretPrefix && (
                      <div className="mb-3 ruled rounded-sm bg-[var(--color-paper)] p-3 flex flex-wrap items-center gap-3">
                        <Key size={14} weight="duotone" className="text-[var(--color-ink-2)]" />
                        <span className="mono text-[11.5px] text-[var(--color-ink-2)]">
                          rotation in progress: dual-signing with <span className="text-[var(--color-ink-1)]">{w.pendingSecretPrefix}…</span>
                          {w.pendingExpiresAt ? <> until {fmtTs(w.pendingExpiresAt)}</> : null}
                        </span>
                        <span className="flex-1" />
                        <button
                          type="button"
                          disabled={busy === w.id || !canWrite}
                          onClick={() => void finalize(w.id)}
                          className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)] disabled:opacity-50"
                        >
                          finalize now
                        </button>
                        <button
                          type="button"
                          disabled={busy === w.id || !canWrite}
                          onClick={() => void cancelRotate(w.id)}
                          className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-neg-soft)] text-[var(--color-neg)] disabled:opacity-50"
                        >
                          cancel
                        </button>
                      </div>
                    )}
                    {rotateErr && open === w.id && (
                      <div className="mb-3 mono text-[11.5px] text-[var(--color-neg)]">{rotateErr}</div>
                    )}
                    <div className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] mb-1.5">recent deliveries</div>
                    {delivStatus[w.id] === "loading" && <LoadingRow rows={3} />}
                    {delivStatus[w.id] === "error" && <ErrorBlock message="Could not load delivery log." />}
                    {delivStatus[w.id] === "ready" && (deliveries[w.id]?.length ?? 0) === 0 && (
                      <Empty title="No deliveries yet." hint="Make an authenticated POST to /v1/compare to trigger one." />
                    )}
                    {delivStatus[w.id] === "ready" && (deliveries[w.id]?.length ?? 0) > 0 && (
                      <div className="ruled rounded-sm overflow-hidden bg-[var(--color-paper)]">
                        {deliveries[w.id]!.map((d, i) => (
                          <div
                            key={d.id}
                            className={
                              "px-3 py-2 flex items-center gap-3 flex-wrap " +
                              (i > 0 ? "border-t border-[var(--color-rule)]" : "")
                            }
                          >
                            {d.ok ? (
                              <CheckCircle size={13} weight="duotone" className="text-[var(--color-pos)]" />
                            ) : (
                              <XCircle size={13} weight="duotone" className="text-[var(--color-neg)]" />
                            )}
                            <span className="mono text-[11px] text-[var(--color-ink-2)]">{d.event}</span>
                            <span className="mono text-[11px] text-[var(--color-ink-3)]">{d.status || "ERR"}</span>
                            <span className="mono text-[11px] text-[var(--color-ink-3)]">{d.attempts}× / {Math.round(d.durationMs)}ms</span>
                            <span className="mono text-[11px] text-[var(--color-ink-3)]">{fmtTs(d.attemptedAt)}</span>
                            {d.error && <span className="mono text-[11px] text-[var(--color-neg)] truncate">{d.error}</span>}
                            {d.redeliveredFrom && (
                              <span
                                className="mono text-[10px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-3)]"
                                title={`Replay of ${d.redeliveredFrom}`}
                              >
                                replay
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => void redeliver(w.id, d.id)}
                              disabled={redelivering === d.id || !canWrite}
                              title={!canWrite ? "Viewers cannot redeliver webhooks." : "Resend this exact payload to the endpoint. Useful for testing receiver fixes."}
                              className="ml-auto inline-flex items-center gap-1.5 mono text-[10.5px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)] disabled:opacity-50 disabled:cursor-not-allowed"
                              aria-label="Redeliver this webhook payload"
                            >
                              <ArrowClockwise size={12} weight="duotone" />
                              {redelivering === d.id ? "Sending" : "Redeliver"}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {redeliverErr && (
                      <div className="mt-2 mono text-[11px] text-[var(--color-neg)]" role="alert">
                        {redeliverErr}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <H2 eyebrow="payload">what your endpoint will receive</H2>
      <div className="ruled rounded-md p-4 bg-[var(--color-paper-2)]">
        <pre className="mono text-[12px] leading-[1.55] overflow-x-auto text-[var(--color-ink-2)]">{`POST <your-url>
Content-Type: application/json
User-Agent: codeclone-webhooks/1.0
X-CodeClone-Event: compare.completed
X-CodeClone-Delivery: <unique-id>
X-CodeClone-Signature: t=<unix-ts>,v1=<hmac-sha256(secretHash, "<ts>.<body>")>
X-CodeClone-Hash: <first 16 hex chars of sha256(secret)>

{
  "event": "compare.completed",
  "created_at": 1716950400,
  "data": {
    "key_id": "abc123",
    "language": "python",
    "bytes": { "a": 142, "b": 158 },
    "scores": { "jaccardExact": 0.62, "shingleJaccard": 0.71, "lineSimilarity": 0.55 },
    "clone": { "label": "Near-clone (Type-2)", "type": 2, "confidence": 0.72 },
    "latency_ms": 4.812
  }
}`}</pre>
      </div>
    </main>
  );
}
