"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  FolderSimple,
  Plus,
  ArrowRight,
  X,
  FloppyDisk,
  MagnifyingGlass,
  CaretLeft,
  CaretRight,
  ArrowsDownUp,
} from "@phosphor-icons/react/dist/ssr";
import { H1 } from "../../components/Headings";
import { Empty, ErrorBlock, LoadingRow } from "../../components/States";
import { fmtTs } from "../../lib/format";

interface CollectionSummary {
  id: string;
  title: string;
  description?: string;
  count: number;
  createdAt: number;
  updatedAt: number;
}

type SortKey = "updated" | "created" | "title" | "count";
type SortDir = "asc" | "desc";
type Status = "loading" | "ready" | "error";

const PAGE_SIZE = 20;

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "updated", label: "last updated" },
  { value: "created", label: "created" },
  { value: "title", label: "title" },
  { value: "count", label: "item count" },
];

export default function CollectionsPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<CollectionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");
  const [dir, setDir] = useState<SortDir>("desc");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);

  // Debounce search input by 250ms.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to first page whenever filters or sort change.
  useEffect(() => {
    setOffset(0);
  }, [debounced, sort, dir]);

  const refresh = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      if (debounced) params.set("q", debounced);
      params.set("sort", sort);
      params.set("dir", dir);
      const res = await fetch(`/api/collections?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(Array.isArray(data.items) ? data.items : []);
      setTotal(typeof data.total === "number" ? data.total : 0);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
      setStatus("error");
    }
  }, [offset, debounced, sort, dir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description: desc || undefined }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setTitle("");
      setDesc("");
      setCreating(false);
      setOffset(0);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to create");
    } finally {
      setSaving(false);
    }
  }

  const pageStart = items.length === 0 ? 0 : offset + 1;
  const pageEnd = offset + items.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const filtersActive = debounced.length > 0;

  const clearFilters = useCallback(() => {
    setSearch("");
    setDebounced("");
    setSort("updated");
    setDir("desc");
    setOffset(0);
  }, []);

  const sortLabel = useMemo(
    () => SORT_OPTIONS.find((o) => o.value === sort)?.label ?? sort,
    [sort],
  );

  return (
    <main className="mx-auto max-w-[1100px] px-5 sm:px-7 py-8 sm:py-10">
      <H1 eyebrow="organize">collections</H1>
      <p className="text-[14px] text-[var(--color-ink-3)] mb-6 max-w-[620px]">
        Group shareable comparison results into one URL you can hand to a
        teammate. Public read by id, no sign-in required to view.
      </p>

      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 mb-4">
        <label className="relative flex-1 min-w-0">
          <MagnifyingGlass
            weight="duotone"
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-ink-3)] pointer-events-none"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title or description"
            aria-label="Search collections"
            className="w-full pl-8 pr-8 h-9 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[13.5px] outline-none focus:border-[var(--color-ink-3)]"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-ink-3)] hover:text-[var(--color-ink-1)]"
            >
              <X weight="duotone" size={14} />
            </button>
          )}
        </label>

        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5 mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">
            <ArrowsDownUp weight="duotone" size={12} />
            sort
          </label>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort collections by"
            className="h-9 px-2 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[13px] outline-none focus:border-[var(--color-ink-3)]"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setDir((d) => (d === "asc" ? "desc" : "asc"))}
            aria-label={`Sort direction ${dir === "asc" ? "ascending" : "descending"}`}
            title={dir === "asc" ? "ascending" : "descending"}
            className="inline-flex items-center justify-center w-9 h-9 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[13px] mono"
          >
            {dir === "asc" ? "↑" : "↓"}
          </button>
          {!creating && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 px-2.5 h-9 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[13px] whitespace-nowrap"
            >
              <Plus weight="duotone" size={14} />
              new
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between mb-3 text-[11.5px] mono text-[var(--color-ink-3)] flex-wrap gap-2">
        <div>
          {status === "ready"
            ? total === 0
              ? filtersActive
                ? "no matches"
                : "0 total"
              : `showing ${pageStart}\u2013${pageEnd} of ${total}`
            : status === "loading"
              ? "loading"
              : "error"}
          <span className="ml-2 text-[var(--color-ink-4)]">
            sorted by {sortLabel} ({dir})
          </span>
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="ml-2 underline hover:text-[var(--color-ink-1)]"
            >
              clear filters
            </button>
          )}
        </div>
        <div>page size {PAGE_SIZE}</div>
      </div>

      {creating && (
        <form
          onSubmit={submit}
          className="ruled rounded-md p-4 mb-4 bg-[var(--color-paper-2)]"
        >
          <label className="block mb-3">
            <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] block mb-1">
              title
            </span>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Sprint 14 duplicates"
              maxLength={120}
              className="w-full px-2.5 h-9 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[14px] outline-none focus:border-[var(--color-ink-3)]"
            />
          </label>
          <label className="block mb-3">
            <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] block mb-1">
              description (optional)
            </span>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              maxLength={500}
              rows={2}
              className="w-full px-2.5 py-2 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[13.5px] outline-none focus:border-[var(--color-ink-3)] resize-y"
            />
          </label>
          <div className="flex items-center gap-2 justify-end">
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setTitle("");
                setDesc("");
              }}
              className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded border border-[var(--color-rule)] text-[13px]"
            >
              <X weight="duotone" size={14} />
              cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || saving}
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded bg-[var(--color-ink-1)] text-[var(--color-paper)] text-[13px] disabled:opacity-50"
            >
              <FloppyDisk weight="duotone" size={14} />
              {saving ? "saving" : "create"}
            </button>
          </div>
        </form>
      )}

      {status === "loading" && <LoadingRow rows={4} />}
      {status === "error" && error && <ErrorBlock message={error} />}
      {status === "ready" && items.length === 0 && (
        <Empty
          title={
            filtersActive
              ? "No collections match your search"
              : "No collections yet"
          }
          hint={
            filtersActive
              ? "Try a different keyword or clear filters."
              : "Create one above, then add shareable comparisons from history or any /r/<id> page."
          }
        />
      )}
      {status === "ready" && items.length > 0 && (
        <div className="ruled rounded-md overflow-hidden">
          {items.map((c, i) => (
            <Link
              key={c.id}
              href={`/collections/${c.id}`}
              className={`block px-4 py-3 hover:bg-[var(--color-paper-2)] ${
                i > 0 ? "border-t border-[var(--color-rule)]" : ""
              }`}
            >
              <div className="flex items-center gap-3">
                <FolderSimple
                  weight="duotone"
                  size={18}
                  className="text-[var(--color-ink-3)] shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-[14px] font-medium truncate">
                      {c.title}
                    </div>
                    <span className="mono text-[10.5px] text-[var(--color-ink-3)] shrink-0">
                      {c.count} item{c.count === 1 ? "" : "s"}
                    </span>
                  </div>
                  {c.description && (
                    <div className="text-[12.5px] text-[var(--color-ink-3)] truncate mt-0.5">
                      {c.description}
                    </div>
                  )}
                  <div className="mono text-[10.5px] text-[var(--color-ink-4)] mt-0.5">
                    updated {fmtTs(c.updatedAt)}
                  </div>
                </div>
                <ArrowRight
                  weight="duotone"
                  size={14}
                  className="text-[var(--color-ink-4)] shrink-0"
                />
              </div>
            </Link>
          ))}
        </div>
      )}

      {status === "ready" && total > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-4 text-[12px] mono">
          <button
            type="button"
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0}
            className="inline-flex items-center gap-1 px-2.5 h-8 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <CaretLeft weight="duotone" size={12} />
            prev
          </button>
          <div className="text-[var(--color-ink-3)]">
            page {currentPage} of {totalPages}
          </div>
          <button
            type="button"
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={pageEnd >= total}
            className="inline-flex items-center gap-1 px-2.5 h-8 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            next
            <CaretRight weight="duotone" size={12} />
          </button>
        </div>
      )}
    </main>
  );
}
