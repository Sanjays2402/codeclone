"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ClockClockwise,
  MagnifyingGlass,
  PencilSimple,
  Tag,
  Trash,
  DownloadSimple,
  ArrowSquareOut,
  Check,
  X as XIcon,
  Plus,
} from "@phosphor-icons/react/dist/ssr";
import { H1 } from "../../components/Headings";
import { Empty, ErrorBlock, LoadingRow } from "../../components/States";
import { fmtTs } from "../../lib/format";

interface ShareSummary {
  id: string;
  language: string;
  cloneLabel: string;
  shingleJaccard: number;
  createdAt: number;
  updatedAt?: number;
  title?: string;
  tags?: string[];
  bytes: { a: number; b: number };
}

type Status = "loading" | "ready" | "error";

function pctBadge(v: number): string {
  if (v >= 0.85) return "text-[var(--color-pos)] border-[color:var(--color-pos)] bg-[var(--color-pos-soft)]";
  if (v >= 0.55) return "text-[var(--color-accent-ink)] border-[color:var(--color-accent)] bg-[var(--color-accent-soft)]";
  if (v >= 0.25) return "text-[var(--color-ink-2)] border-[var(--color-rule)] bg-[var(--color-paper-2)]";
  return "text-[var(--color-ink-3)] border-[var(--color-rule)] bg-[var(--color-paper-2)]";
}

export default function HistoryPage() {
  const [items, setItems] = useState<ShareSummary[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string>("");
  const [q, setQ] = useState("");
  const [activeTag, setActiveTag] = useState<string>("");
  const [editingId, setEditingId] = useState<string>("");
  const [editTitle, setEditTitle] = useState("");
  const [tagDraftId, setTagDraftId] = useState<string>("");
  const [tagDraft, setTagDraft] = useState("");
  const [busy, setBusy] = useState<string>("");
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/share?limit=500", { cache: "no-store" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Request failed (${res.status}).`);
      }
      const j = (await res.json()) as { items: ShareSummary[] };
      setItems(j.items ?? []);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (editingId) titleInputRef.current?.focus();
  }, [editingId]);

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) {
      for (const t of it.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [items]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((it) => {
      if (activeTag && !it.tags?.includes(activeTag)) return false;
      if (!needle) return true;
      return (
        it.id.toLowerCase().includes(needle) ||
        (it.title?.toLowerCase().includes(needle) ?? false) ||
        it.language.toLowerCase().includes(needle) ||
        it.cloneLabel.toLowerCase().includes(needle)
      );
    });
  }, [items, q, activeTag]);

  const startEdit = (it: ShareSummary) => {
    setEditingId(it.id);
    setEditTitle(it.title ?? "");
  };
  const cancelEdit = () => {
    setEditingId("");
    setEditTitle("");
  };
  const saveTitle = async (id: string) => {
    setBusy(id);
    try {
      const next = editTitle.trim();
      const res = await fetch(`/api/share/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: next ? next : null }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Save failed (${res.status}).`);
      }
      cancelEdit();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const addTag = async (it: ShareSummary) => {
    const raw = tagDraft.trim();
    if (!raw) return;
    const tag = raw.toLowerCase().replace(/\s+/g, "-");
    const next = Array.from(new Set([...(it.tags ?? []), tag]));
    setBusy(it.id);
    try {
      const res = await fetch(`/api/share/${it.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Tag failed (${res.status}).`);
      }
      setTagDraft("");
      setTagDraftId("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const removeTag = async (it: ShareSummary, tag: string) => {
    const next = (it.tags ?? []).filter((t) => t !== tag);
    setBusy(it.id);
    try {
      const res = await fetch(`/api/share/${it.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Untag failed (${res.status}).`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this comparison? This cannot be undone.")) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/share/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Delete failed (${res.status}).`);
      }
      setItems((prev) => prev.filter((x) => x.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div>
      <H1 eyebrow="history · saved comparisons">
        Every comparison you share is saved here.
      </H1>

      <section className="ruled rounded-md p-3 mb-5 bg-[var(--color-paper)] flex flex-col sm:flex-row gap-3 sm:items-center">
        <label className="flex-1 flex items-center gap-2 px-2.5 py-1.5 rounded-sm border border-[var(--color-rule)] bg-[var(--color-paper-2)] focus-within:border-[color:var(--color-accent)]">
          <MagnifyingGlass weight="duotone" size={14} className="text-[var(--color-ink-3)]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by title, id, language, or label"
            className="flex-1 bg-transparent outline-none text-[13px] placeholder:text-[var(--color-ink-4)]"
          />
        </label>
        <div className="flex items-center gap-2 mono text-[11px] text-[var(--color-ink-3)]">
          <span>{filtered.length} of {items.length}</span>
        </div>
      </section>

      {allTags.length > 0 && (
        <section className="flex flex-wrap items-center gap-1.5 mb-5">
          <span className="eyebrow mr-1">tags</span>
          <button
            onClick={() => setActiveTag("")}
            className={`mono text-[11px] uppercase tracking-[0.14em] px-2 py-0.5 rounded-sm border ${
              activeTag === ""
                ? "border-[color:var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-paper)]"
                : "border-[var(--color-rule)] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            }`}
          >
            all
          </button>
          {allTags.map(([t, n]) => (
            <button
              key={t}
              onClick={() => setActiveTag(activeTag === t ? "" : t)}
              className={`mono text-[11px] uppercase tracking-[0.14em] px-2 py-0.5 rounded-sm border ${
                activeTag === t
                  ? "border-[color:var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-paper)]"
                  : "border-[var(--color-rule)] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              }`}
            >
              {t} · {n}
            </button>
          ))}
        </section>
      )}

      {status === "loading" && <LoadingRow rows={6} />}
      {status === "error" && <ErrorBlock message={error || "Could not load history."} />}
      {status === "ready" && filtered.length === 0 && (
        <Empty
          title={items.length === 0 ? "No saved comparisons yet." : "No comparisons match your filter."}
          hint={
            items.length === 0
              ? "Run a comparison and tap Share to save it here."
              : "Try a different search or clear the active tag."
          }
          mono={items.length === 0 ? "open /compare to start" : undefined}
        />
      )}
      {status === "ready" && filtered.length > 0 && (
        <div className="ruled rounded-md overflow-hidden">
          {filtered.map((it, i) => {
            const editing = editingId === it.id;
            const tagging = tagDraftId === it.id;
            const pct = (it.shingleJaccard * 100).toFixed(1);
            return (
              <div
                key={it.id}
                className={`px-4 py-3 flex flex-col gap-2 ${
                  i > 0 ? "border-t border-[var(--color-rule)]" : ""
                } ${busy === it.id ? "opacity-60" : ""}`}
              >
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex-1 min-w-0">
                    {editing ? (
                      <div className="flex items-center gap-2">
                        <input
                          ref={titleInputRef}
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void saveTitle(it.id);
                            if (e.key === "Escape") cancelEdit();
                          }}
                          placeholder="Untitled comparison"
                          className="flex-1 bg-[var(--color-paper-2)] border border-[var(--color-rule)] rounded-sm px-2 py-1 text-[14px] outline-none focus:border-[color:var(--color-accent)]"
                          maxLength={120}
                        />
                        <button
                          onClick={() => void saveTitle(it.id)}
                          className="inline-flex items-center gap-1 mono text-[11px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[color:var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-paper)] hover:opacity-90"
                        >
                          <Check weight="duotone" size={13} /> save
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="inline-flex items-center gap-1 mono text-[11px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
                        >
                          <XIcon weight="duotone" size={13} /> cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link
                          href={`/r/${it.id}`}
                          className="text-[14px] sm:text-[15px] tracking-tight font-medium text-[var(--color-ink)] hover:underline truncate"
                        >
                          {it.title ?? "Untitled comparison"}
                        </Link>
                        <button
                          onClick={() => startEdit(it)}
                          className="text-[var(--color-ink-4)] hover:text-[var(--color-ink-2)]"
                          title="Rename"
                        >
                          <PencilSimple weight="duotone" size={13} />
                        </button>
                      </div>
                    )}
                    <div className="mono text-[11px] text-[var(--color-ink-4)] mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <span>/r/{it.id}</span>
                      <span>lang {it.language}</span>
                      <span>{it.bytes.a}/{it.bytes.b} bytes</span>
                      <span>saved {fmtTs(it.createdAt)}</span>
                      {it.updatedAt && it.updatedAt !== it.createdAt && (
                        <span>edited {fmtTs(it.updatedAt)}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`mono text-[11px] uppercase tracking-[0.14em] px-1.5 py-px border rounded-sm ${pctBadge(
                        it.shingleJaccard,
                      )}`}
                    >
                      {it.cloneLabel} · {pct}%
                    </span>
                    <Link
                      href={`/r/${it.id}`}
                      className="inline-flex items-center gap-1 mono text-[11px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
                      title="Open shared view"
                    >
                      <ArrowSquareOut weight="duotone" size={13} /> open
                    </Link>
                    <a
                      href={`/api/share/${it.id}`}
                      download={`codeclone-${it.id}.json`}
                      className="inline-flex items-center gap-1 mono text-[11px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
                      title="Download JSON"
                    >
                      <DownloadSimple weight="duotone" size={13} /> json
                    </a>
                    <button
                      onClick={() => void remove(it.id)}
                      className="inline-flex items-center gap-1 mono text-[11px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-3)] hover:text-[var(--color-neg)] hover:border-[color:var(--color-neg-bar)]"
                      title="Delete"
                    >
                      <Trash weight="duotone" size={13} /> delete
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Tag weight="duotone" size={12} className="text-[var(--color-ink-4)]" />
                  {(it.tags ?? []).map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm border border-[var(--color-rule)] bg-[var(--color-paper-2)] text-[var(--color-ink-2)]"
                    >
                      {t}
                      <button
                        onClick={() => void removeTag(it, t)}
                        className="text-[var(--color-ink-4)] hover:text-[var(--color-neg)]"
                        aria-label={`Remove tag ${t}`}
                      >
                        <XIcon weight="bold" size={10} />
                      </button>
                    </span>
                  ))}
                  {tagging ? (
                    <span className="inline-flex items-center gap-1">
                      <input
                        autoFocus
                        value={tagDraft}
                        onChange={(e) => setTagDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void addTag(it);
                          if (e.key === "Escape") {
                            setTagDraft("");
                            setTagDraftId("");
                          }
                        }}
                        placeholder="tag-name"
                        maxLength={32}
                        className="bg-[var(--color-paper-2)] border border-[var(--color-rule)] rounded-sm px-1.5 py-0.5 mono text-[11px] outline-none focus:border-[color:var(--color-accent)] w-32"
                      />
                      <button
                        onClick={() => void addTag(it)}
                        className="mono text-[10.5px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm border border-[color:var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-paper)]"
                      >
                        add
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => {
                        setTagDraftId(it.id);
                        setTagDraft("");
                      }}
                      className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm border border-dashed border-[var(--color-rule)] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
                    >
                      <Plus weight="bold" size={10} /> tag
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-6 mono text-[11px] text-[var(--color-ink-4)] flex items-center gap-1.5">
        <ClockClockwise weight="duotone" size={12} />
        Shares are stored on disk at {`{`}CODECLONE_SHARES_DIR{`}`}. Anyone with the link can view a shared comparison.
      </p>
    </div>
  );
}
