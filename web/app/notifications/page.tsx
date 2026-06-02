"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Bell,
  Check,
  Trash,
  ArrowSquareOut,
  CheckCircle,
  WarningCircle,
  ShareNetwork,
  Stack,
  Info,
  DownloadSimple,
} from "@phosphor-icons/react/dist/ssr";
import { H1 } from "../../components/Headings";
import { Empty, ErrorBlock, LoadingRow } from "../../components/States";
import { fmtTs } from "../../lib/format";

type Kind = "share.created" | "batch.completed" | "webhook.failed" | "system";

interface Notification {
  v: 1;
  id: string;
  kind: Kind;
  title: string;
  body?: string;
  href?: string;
  createdAt: number;
  readAt?: number;
}

type Status = "loading" | "ready" | "error" | "unauth";
type Filter = "all" | "unread";

function iconFor(kind: Kind) {
  switch (kind) {
    case "share.created":
      return <ShareNetwork weight="duotone" size={16} className="text-[var(--color-accent)]" />;
    case "batch.completed":
      return <Stack weight="duotone" size={16} className="text-[var(--color-pos)]" />;
    case "webhook.failed":
      return <WarningCircle weight="duotone" size={16} className="text-[var(--color-neg)]" />;
    default:
      return <Info weight="duotone" size={16} className="text-[var(--color-ink-3)]" />;
  }
}

function kindLabel(kind: Kind): string {
  switch (kind) {
    case "share.created":
      return "share";
    case "batch.completed":
      return "batch";
    case "webhook.failed":
      return "webhook";
    default:
      return "system";
  }
}

export default function NotificationsPage() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications?limit=200", { cache: "no-store" });
      if (res.status === 401) {
        setStatus("unauth");
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Request failed (${res.status}).`);
      }
      const j = (await res.json()) as { items: Notification[]; unread: number };
      setItems(j.items ?? []);
      setUnread(j.unread ?? 0);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = useMemo(() => {
    return filter === "unread" ? items.filter((n) => !n.readAt) : items;
  }, [items, filter]);

  const toggleRead = async (n: Notification) => {
    setBusy(n.id);
    try {
      const res = await fetch(`/api/notifications/${n.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ read: !n.readAt }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Update failed (${res.status}).`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const remove = async (n: Notification) => {
    setBusy(n.id);
    try {
      const res = await fetch(`/api/notifications/${n.id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Delete failed (${res.status}).`);
      }
      setItems((prev) => prev.filter((x) => x.id !== n.id));
      if (!n.readAt) setUnread((u) => Math.max(0, u - 1));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const markAllRead = async () => {
    setBusy("__all__");
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "mark-all-read" }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Update failed (${res.status}).`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const clearAll = async () => {
    if (!confirm("Clear all notifications? This cannot be undone.")) return;
    setBusy("__all__");
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "clear" }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Clear failed (${res.status}).`);
      }
      setItems([]);
      setUnread(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div>
      <H1 eyebrow="notifications · activity inbox">
        Heads-up when something finishes or breaks.
      </H1>

      <section className="ruled rounded-md p-3 mb-5 bg-[var(--color-paper)] flex flex-col sm:flex-row gap-3 sm:items-center">
        <div className="flex items-center gap-1.5">
          {(["all", "unread"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border ${
                filter === f
                  ? "border-[color:var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-paper)]"
                  : "border-[var(--color-rule)] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              }`}
            >
              {f}
              {f === "unread" && unread > 0 ? ` · ${unread}` : ""}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 mono text-[11px] text-[var(--color-ink-3)] sm:ml-2">
          <Bell weight="duotone" size={13} />
          <span>{items.length} total</span>
        </div>
        <div className="flex items-center gap-1.5 sm:ml-auto">
          <button
            onClick={() => void markAllRead()}
            disabled={busy === "__all__" || unread === 0}
            className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-2)] hover:border-[color:var(--color-accent)] hover:text-[var(--color-ink)] disabled:opacity-40 disabled:pointer-events-none"
          >
            <CheckCircle weight="duotone" size={13} /> mark all read
          </button>
          <a
            href={`/api/notifications?format=csv&limit=200${filter === "unread" ? "&unread=1" : ""}`}
            download="codeclone-notifications.csv"
            aria-disabled={items.length === 0}
            tabIndex={items.length === 0 ? -1 : 0}
            onClick={(e) => {
              if (items.length === 0) e.preventDefault();
            }}
            className={`inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-2)] hover:border-[color:var(--color-accent)] hover:text-[var(--color-ink)] ${items.length === 0 ? "opacity-40 pointer-events-none" : ""}`}
            title="Download notifications as CSV"
          >
            <DownloadSimple weight="duotone" size={13} /> Download CSV
          </a>
          <button
            onClick={() => void clearAll()}
            disabled={busy === "__all__" || items.length === 0}
            className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-3)] hover:text-[var(--color-neg)] hover:border-[color:var(--color-neg-bar)] disabled:opacity-40 disabled:pointer-events-none"
          >
            <Trash weight="duotone" size={13} /> clear
          </button>
        </div>
      </section>

      {status === "loading" && <LoadingRow rows={5} />}
      {status === "error" && <ErrorBlock message={error || "Could not load notifications."} />}
      {status === "unauth" && (
        <Empty
          title="Sign in to see your notifications."
          hint="Activity from your shares, batches, and webhooks lives in your account."
          mono="open /signin"
        />
      )}
      {status === "ready" && visible.length === 0 && (
        <Empty
          title={items.length === 0 ? "No activity yet." : "All caught up."}
          hint={
            items.length === 0
              ? "Run a comparison, ship a batch, or trigger a webhook to see updates here."
              : "Nothing unread. Switch filter to 'all' to review past activity."
          }
          mono={items.length === 0 ? "open /compare to start" : undefined}
        />
      )}
      {status === "ready" && visible.length > 0 && (
        <div className="ruled rounded-md overflow-hidden">
          {visible.map((n, i) => {
            const unreadRow = !n.readAt;
            return (
              <div
                key={n.id}
                className={`px-4 py-3 flex flex-wrap items-start gap-3 ${
                  i > 0 ? "border-t border-[var(--color-rule)]" : ""
                } ${busy === n.id ? "opacity-60" : ""} ${
                  unreadRow ? "bg-[var(--color-accent-soft)]" : ""
                }`}
              >
                <div className="pt-0.5">{iconFor(n.kind)}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[14px] tracking-tight font-medium text-[var(--color-ink)]">
                      {n.title}
                    </span>
                    {unreadRow && (
                      <span className="mono text-[10px] uppercase tracking-[0.14em] px-1.5 py-px rounded-sm border border-[color:var(--color-accent)] text-[var(--color-accent-ink)] bg-[var(--color-paper)]">
                        new
                      </span>
                    )}
                  </div>
                  {n.body && (
                    <div className="text-[12.5px] text-[var(--color-ink-2)] mt-0.5 break-words">
                      {n.body}
                    </div>
                  )}
                  <div className="mono text-[11px] text-[var(--color-ink-4)] mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    <span>{kindLabel(n.kind)}</span>
                    <span>{fmtTs(n.createdAt)}</span>
                    {n.readAt && <span>read {fmtTs(n.readAt)}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {n.href && (
                    <Link
                      href={n.href}
                      className="inline-flex items-center gap-1 mono text-[11px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
                    >
                      <ArrowSquareOut weight="duotone" size={13} /> open
                    </Link>
                  )}
                  <button
                    onClick={() => void toggleRead(n)}
                    className="inline-flex items-center gap-1 mono text-[11px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
                    title={unreadRow ? "Mark as read" : "Mark as unread"}
                  >
                    <Check weight="duotone" size={13} /> {unreadRow ? "read" : "unread"}
                  </button>
                  <button
                    onClick={() => void remove(n)}
                    className="inline-flex items-center gap-1 mono text-[11px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-3)] hover:text-[var(--color-neg)] hover:border-[color:var(--color-neg-bar)]"
                    title="Delete"
                  >
                    <Trash weight="duotone" size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-6 mono text-[11px] text-[var(--color-ink-4)] flex items-center gap-1.5">
        <Bell weight="duotone" size={12} />
        Stored per user under {`{`}CODECLONE_NOTIFICATIONS_DIR{`}`}. The bell in the top bar polls for new items.
      </p>
    </div>
  );
}
