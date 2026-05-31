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
  CaretLeft,
  CaretRight,
  FunnelSimple,
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

interface Facet {
  name: string;
  count: number;
}

interface SharePage {
  items: ShareSummary[];
  count: number;
  total: number;
  offset: number;
  limit: number;
  facets: {
    languages: Facet[];
    cloneLabels: Facet[];
  };
}

type Status = "loading" | "ready" | "error";

const PAGE_SIZE = 25;

function pctBadge(v: number): string {
  if (v >= 0.85) return "text-[var(--color-pos)] border-[color:var(--color-pos)] bg-[var(--color-pos-soft)]";
  if (v >= 0.55) return "text-[var(--color-accent-ink)] border-[color:var(--color-accent)] bg-[var(--color-accent-soft)]";
  if (v >= 0.25) return "text-[var(--color-ink-2)] border-[var(--color-rule)] bg-[var(--color-paper-2)]";
  return "text-[var(--color-ink-3)] border-[var(--color-rule)] bg-[var(--color-paper-2)]";
}

function buildQuery(params: {
  q: string;
  tag: string;
  language: string;
  cloneLabel: string;
  minScore: number;
  offset: number;
  limit: number;
}): string {
  const sp = new URLSearchParams();
  if (params.q.trim()) sp.set("q", params.q.trim());
  if (params.tag) sp.set("tag", params.tag);
  if (params.language && params.language !== "all") sp.set("language", params.language);
  if (params.cloneLabel && params.cloneLabel !== "all") sp.set("label", params.cloneLabel);
  if (params.minScore > 0) sp.set("minScore", params.minScore.toFixed(2));
  sp.set("offset", String(params.offset));
  sp.set("limit", String(params.limit));
  return sp.toString();
}

function exportHref(format: "csv" | "json", q: string, tag: string): string {
  const params = new URLSearchParams({ format });
  if (q.trim()) params.set("q", q.trim());
  if (tag.trim()) params.set("tag", tag.trim());
  return `/api/share/export?${params.toString()}`;
}

export default function HistoryPage() {
  const [page, setPage] = useState<SharePage | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string>("");

  // Filter state.
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [activeTag, setActiveTag] = useState<string>("");
  const [language, setLanguage] = useState<string>("all");
  const [cloneLabel, setCloneLabel] = useState<string>("all");
  const [minScore, setMinScore] = useState<number>(0);
  const [offset, setOffset] = useState<number>(0);

  // Inline edit state.
  const [editingId, setEditingId] = useState<string>("");
  const [editTitle, setEditTitle] = useState("");
  const [tagDraftId, setTagDraftId] = useState<string>("");
  const [tagDraft, setTagDraft] = useState("");
  const [busy, setBusy] = useState<string>("");
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  // Debounce search input by 250ms so we do not spam the server.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  // Reset to page 0 whenever a filter changes.
  useEffect(() => {
    setOffset(0);
  }, [debouncedQ, activeTag, language, cloneLabel, minScore]);

  const refresh = useCallback(async () => {
    setStatus("loading");
    try {
      const qs = buildQuery({
        q: debouncedQ,
        tag: activeTag,
        language,
        cloneLabel,
        minScore,
        offset,
        limit: PAGE_SIZE,
      });
      const res = await fetch(`/api/share?${qs}`, { cache: "no-store" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Request failed (${res.status}).`);
      }
      const j = (await res.json()) as SharePage;
      setPage(j);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [debouncedQ, activeTag, language, cloneLabel, minScore, offset]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (editingId) titleInputRef.current?.focus();
  }, [editingId]);

  const items = page?.items ?? [];
  const total = page?.total ?? 0;
  const facets = page?.facets ?? { languages: [], cloneLabels: [] };

  const pageStart = items.length === 0 ? 0 : offset + 1;
  const pageEnd = offset + items.length;
  const hasPrev = offset > 0;
  const hasNext = offset + items.length < total;

  const filtersActive =
    debouncedQ.trim() !== "" ||
    activeTag !== "" ||
    language !== "all" ||
    cloneLabel !== "all" ||
    minScore > 0;

  const clearFilters = () => {
    setQ("");
    setActiveTag("");
    setLanguage("all");
    setCloneLabel("all");
    setMinScore(0);
  };

  // Inline edit handlers.
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
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const tagFacets = useMemo(() => {
    // Tag facets are derived from currently visible page items only, since
    // tags are per-record metadata, not a primary facet of the store.
    const counts = new Map<string, number>();
    for (const it of items) {
      for (const t of it.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [items]);

  return (
    <div>
      <H1 eyebrow="history · saved comparisons">
        Every comparison you share is saved here.
      </H1>

      <section className="ruled rounded-md p-3 mb-4 bg-[var(--color-paper)] flex flex-col gap-3">
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
          <label className="flex-1 flex items-center gap-2 px-2.5 py-1.5 rounded-sm border border-[var(--color-rule)] bg-[var(--color-paper-2)] focus-within:border-[color:var(--color-accent)]">
            <MagnifyingGlass weight="duotone" size={14} className="text-[var(--color-ink-3)]" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by title, id, language, or label"
              className="flex-1 bg-transparent outline-none text-[13px] placeholder:text-[var(--color-ink-4)]"
            />
          </label>
          <div className="flex items-center gap-1.5">
            <a
              href={exportHref("csv", debouncedQ, activeTag)}
              aria-disabled={total === 0}
              onClick={(e) => {
                if (total === 0) e.preventDefault();
              }}
              className={`inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border border-[var(--color-rule)] hover:border-[color:var(--color-accent)] hover:text-[var(--color-ink)] ${
                total === 0 ? "opacity-40 pointer-events-none" : "text-[var(--color-ink-2)]"
              }`}
              title="Download filtered history as CSV"
            >
              <DownloadSimple weight="duotone" size={13} /> csv
            </a>
            <a
              href={exportHref("json", debouncedQ, activeTag)}
              aria-disabled={total === 0}
              onClick={(e) => {
                if (total === 0) e.preventDefault();
              }}
              className={`inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border border-[var(--color-rule)] hover:border-[color:var(--color-accent)] hover:text-[var(--color-ink)] ${
                total === 0 ? "opacity-40 pointer-events-none" : "text-[var(--color-ink-2)]"
              }`}
              title="Download filtered history as JSON"
            >
              <DownloadSimple weight="duotone" size={13} /> json
            </a>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-end gap-3 sm:gap-4">
          <label className="flex flex-col gap-1 sm:w-44">
            <span className="eyebrow flex items-center gap-1.5">
              <FunnelSimple weight="duotone" size={12} /> language
            </span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="bg-[var(--color-paper-2)] border border-[var(--color-rule)] rounded-sm px-2 py-1.5 mono text-[12px] outline-none focus:border-[color:var(--color-accent)]"
            >
              <option value="all">all languages</option>
              {facets.languages.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name} ({f.count})
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 sm:w-44">
            <span className="eyebrow flex items-center gap-1.5">
              <FunnelSimple weight="duotone" size={12} /> clone label
            </span>
            <select
              value={cloneLabel}
              onChange={(e) => setCloneLabel(e.target.value)}
              className="bg-[var(--color-paper-2)] border border-[var(--color-rule)] rounded-sm px-2 py-1.5 mono text-[12px] outline-none focus:border-[color:var(--color-accent)]"
            >
              <option value="all">all labels</option>
              {facets.cloneLabels.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name} ({f.count})
                </option>
              ))}
            </select>
          </label>

          <label className="flex-1 flex flex-col gap-1 min-w-[200px]">
            <span className="eyebrow flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <FunnelSimple weight="duotone" size={12} /> min similarity
              </span>
              <span className="mono text-[11px] text-[var(--color-ink-3)] normal-case tracking-normal">
                {(minScore * 100).toFixed(0)}%
              </span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={minScore}
              onChange={(e) => setMinScore(Number.parseFloat(e.target.value))}
              aria-label="Minimum similarity score"
              className="w-full accent-[var(--color-accent)] cursor-pointer"
            />
          </label>

          {filtersActive && (
            <button
              onClick={clearFilters}
              className="self-start sm:self-end mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1.5 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:border-[color:var(--color-accent)]"
            >
              clear filters
            </button>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 mono text-[11px] text-[var(--color-ink-3)]">
          <span>
            {total === 0
              ? "0 results"
              : `showing ${pageStart}\u2013${pageEnd} of ${total}`}
          </span>
          <span className="hidden sm:inline text-[var(--color-ink-4)]">
            page size {PAGE_SIZE}
          </span>
        </div>
      </section>

      {tagFacets.length > 0 && (
        <section className="flex flex-wrap items-center gap-1.5 mb-5">
          <span className="eyebrow mr-1">tags on page</span>
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
          {tagFacets.map(([t, n]) => (
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
      {status === "ready" && items.length === 0 && (
        <Empty
          title={filtersActive ? "No comparisons match your filters." : "No saved comparisons yet."}
          hint={
            filtersActive
              ? "Try a wider score range, a different language, or clear the active tag."
              : "Run a comparison and tap Share to save it here."
          }
          mono={filtersActive ? undefined : "open /compare to start"}
        />
      )}
      {status === "ready" && items.length > 0 && (
        <div className="ruled rounded-md overflow-hidden">
          {items.map((it, i) => {
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
                    <Link
                      href={`/compare?from=${encodeURIComponent(it.id)}`}
                      className="inline-flex items-center gap-1 mono text-[11px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[color:var(--color-accent)] text-[var(--color-accent-ink)] bg-[var(--color-accent-soft)] hover:opacity-90"
                      title="Open in compare and re-run"
                    >
                      <ClockClockwise weight="duotone" size={13} /> re-run
                    </Link>
                    <a
                      href={`/api/share/${it.id}`}
                      download={`codeclone-${it.id}.json`}                      className="inline-flex items-center gap-1 mono text-[11px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
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

      {status === "ready" && total > 0 && (
        <nav
          aria-label="History pagination"
          className="mt-4 flex items-center justify-between gap-2"
        >
          <button
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={!hasPrev}
            className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:border-[color:var(--color-accent)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-[var(--color-rule)]"
          >
            <CaretLeft weight="duotone" size={13} /> previous
          </button>
          <span className="mono text-[11px] text-[var(--color-ink-3)]">
            page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
          </span>
          <button
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={!hasNext}
            className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:border-[color:var(--color-accent)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-[var(--color-rule)]"
          >
            next <CaretRight weight="duotone" size={13} />
          </button>
        </nav>
      )}

      <p className="mt-6 mono text-[11px] text-[var(--color-ink-4)] flex items-center gap-1.5">
        <ClockClockwise weight="duotone" size={12} />
        Shares are stored on disk at {`{`}CODECLONE_SHARES_DIR{`}`}. Anyone with the link can view a shared comparison.
      </p>
    </div>
  );
}
