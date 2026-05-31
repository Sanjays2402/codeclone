"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  FolderSimple,
  Plus,
  ArrowRight,
  X,
  FloppyDisk,
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

type Status = "loading" | "ready" | "error";

export default function CollectionsPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<CollectionSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/collections", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(Array.isArray(data.items) ? data.items : []);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
      setStatus("error");
    }
  }, []);

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
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to create");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto max-w-[1100px] px-7 py-10">
      <H1 eyebrow="organize">collections</H1>
      <p className="text-[14px] text-[var(--color-ink-3)] mb-6 max-w-[620px]">
        Group shareable comparison results into one URL you can hand to a
        teammate. Public read by id, no sign-in required to view.
      </p>

      <div className="flex items-center justify-between mb-4">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">
          {status === "ready" ? `${items.length} total` : "loading"}
        </div>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[13px]"
          >
            <Plus weight="duotone" size={14} />
            new collection
          </button>
        )}
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
          title="No collections yet"
          hint="Create one above, then add shareable comparisons from history or any /r/<id> page."
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
    </main>
  );
}
