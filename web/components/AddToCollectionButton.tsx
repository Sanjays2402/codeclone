"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  FolderSimple,
  Plus,
  Check,
  CaretDown,
} from "@phosphor-icons/react/dist/ssr";

interface CollectionSummary {
  id: string;
  title: string;
  count: number;
  updatedAt: number;
}

export function AddToCollectionButton({ shareId }: { shareId: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<CollectionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/collections", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      setItems(Array.isArray(j.items) ? j.items : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function addTo(collectionId: string) {
    setError(null);
    try {
      const res = await fetch(`/api/collections/${collectionId}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const c = items.find((x) => x.id === collectionId);
      setDone(c?.title ?? "collection");
      setTimeout(() => {
        setDone(null);
        setOpen(false);
      }, 1100);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    }
  }

  async function createAndAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setError(null);
    try {
      const res = await fetch("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle, shareIds: [shareId] }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setNewTitle("");
      setCreating(false);
      setDone(newTitle);
      setTimeout(() => {
        setDone(null);
        setOpen(false);
      }, 1100);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)]"
      >
        <FolderSimple weight="duotone" size={13} />
        add to collection
        <CaretDown weight="duotone" size={11} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-[280px] z-30 ruled rounded-md bg-[var(--color-paper)] shadow-lg">
          <div className="px-3 py-2 border-b border-[var(--color-rule)] mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">
            your collections
          </div>
          <div className="max-h-[240px] overflow-y-auto">
            {loading && (
              <div className="px-3 py-3 text-[12.5px] text-[var(--color-ink-3)]">
                loading
              </div>
            )}
            {!loading && error && (
              <div className="px-3 py-3 text-[12.5px] text-[var(--color-neg)]">
                {error}
              </div>
            )}
            {!loading && !error && items.length === 0 && (
              <div className="px-3 py-3 text-[12.5px] text-[var(--color-ink-3)]">
                No collections yet.
              </div>
            )}
            {!loading &&
              !error &&
              items.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => addTo(c.id)}
                  className="w-full text-left px-3 py-2 hover:bg-[var(--color-paper-2)] flex items-center gap-2 text-[13px] border-t border-[var(--color-rule)] first:border-t-0"
                >
                  <FolderSimple
                    weight="duotone"
                    size={14}
                    className="text-[var(--color-ink-3)] shrink-0"
                  />
                  <span className="flex-1 truncate">{c.title}</span>
                  <span className="mono text-[10.5px] text-[var(--color-ink-4)]">
                    {c.count}
                  </span>
                  {done === c.title && (
                    <Check
                      weight="duotone"
                      size={13}
                      className="text-[var(--color-pos)]"
                    />
                  )}
                </button>
              ))}
          </div>
          <div className="border-t border-[var(--color-rule)] p-2">
            {!creating ? (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="w-full inline-flex items-center justify-center gap-1.5 px-2 h-8 rounded border border-dashed border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[12.5px]"
              >
                <Plus weight="duotone" size={13} />
                new collection
              </button>
            ) : (
              <form onSubmit={createAndAdd} className="flex items-center gap-1.5">
                <input
                  autoFocus
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="title"
                  maxLength={120}
                  className="flex-1 px-2 h-8 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[13px] outline-none focus:border-[var(--color-ink-3)]"
                />
                <button
                  type="submit"
                  disabled={!newTitle.trim()}
                  className="px-2 h-8 rounded bg-[var(--color-ink-1)] text-[var(--color-paper)] text-[12px] disabled:opacity-50"
                >
                  add
                </button>
              </form>
            )}
          </div>
          <div className="px-3 py-2 border-t border-[var(--color-rule)] text-[11.5px] text-[var(--color-ink-3)]">
            <Link href="/collections" className="hover:underline">
              manage all →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
