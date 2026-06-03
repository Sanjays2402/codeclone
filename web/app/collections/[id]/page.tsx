"use client";

import { useCallback, useEffect, useState, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FolderSimple,
  Plus,
  Trash,
  ArrowSquareOut,
  PencilSimple,
  FloppyDisk,
  X as XIcon,
  Link as LinkIcon,
  DownloadSimple,
} from "@phosphor-icons/react/dist/ssr";
import { H1 } from "../../../components/Headings";
import { Empty, ErrorBlock, LoadingRow } from "../../../components/States";
import { CopyLinkButton } from "../../../components/CopyLinkButton";
import { fmtTs } from "../../../lib/format";

interface ExpandedItem {
  id: string;
  title?: string;
  language: string;
  cloneLabel: string;
  shingleJaccard: number;
  createdAt: number;
  bytes: { a: number; b: number };
  missing?: boolean;
}

interface CollectionFull {
  id: string;
  title: string;
  description?: string;
  shareIds: string[];
  createdAt: number;
  updatedAt: number;
  items: ExpandedItem[];
}

type Status = "loading" | "ready" | "notfound" | "error";

export default function ManageCollectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CollectionFull | null>(null);
  const [adding, setAdding] = useState(false);
  const [newShareId, setNewShareId] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [publicUrl, setPublicUrl] = useState("");

  const refresh = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch(`/api/collections/${id}`, { cache: "no-store" });
      if (res.status === 404) {
        setStatus("notfound");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      setData(j);
      setEditTitle(j.title ?? "");
      setEditDesc(j.description ?? "");
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
      setStatus("error");
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setPublicUrl(`${window.location.origin}/c/${id}`);
    }
  }, [id]);

  function extractShareId(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      const u = new URL(trimmed);
      const m = u.pathname.match(/\/r\/([A-Za-z0-9_-]+)/);
      if (m) return m[1];
    } catch {
      // not a URL
    }
    if (/^[A-Za-z0-9_-]{8,32}$/.test(trimmed)) return trimmed;
    return null;
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    const sid = extractShareId(newShareId);
    if (!sid || busy) {
      setError("Enter a /r/<id> URL or a share id.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/collections/${id}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareId: sid }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setNewShareId("");
      setAdding(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to add");
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(sid: string) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/collections/${id}/items?shareId=${encodeURIComponent(sid)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to remove");
    } finally {
      setBusy(false);
    }
  }

  async function saveMeta(e: React.FormEvent) {
    e.preventDefault();
    if (!editTitle.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/collections/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTitle,
          description: editDesc || null,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setEditing(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to update");
    } finally {
      setBusy(false);
    }
  }

  async function deleteCollection() {
    if (!confirm("Delete this collection? The shared comparisons stay.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/collections/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.push("/collections");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to delete");
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-[1100px] px-7 py-10">
      <div className="mb-4">
        <Link
          href="/collections"
          className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] hover:text-[var(--color-ink-1)]"
        >
          ← collections
        </Link>
      </div>

      {status === "loading" && <LoadingRow rows={4} />}
      {status === "notfound" && (
        <Empty
          title="Collection not found"
          hint="It may have been deleted, or the link is wrong."
        />
      )}
      {status === "error" && error && <ErrorBlock message={error} />}

      {status === "ready" && data && (
        <>
          {!editing ? (
            <div className="flex items-start justify-between gap-4 mb-6">
              <div className="min-w-0">
                <H1 eyebrow="collection">{data.title}</H1>
                {data.description && (
                  <p className="text-[14px] text-[var(--color-ink-3)] -mt-3 mb-3 max-w-[620px]">
                    {data.description}
                  </p>
                )}
                <div className="mono text-[11px] text-[var(--color-ink-4)]">
                  {data.items.length} item{data.items.length === 1 ? "" : "s"} •
                  updated {fmtTs(data.updatedAt)}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Link
                  href={`/c/${id}`}
                  target="_blank"
                  className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[13px]"
                >
                  <ArrowSquareOut weight="duotone" size={14} />
                  public view
                </Link>
                {publicUrl && <CopyLinkButton url={publicUrl} />}
                {data.items.length > 0 && (
                  <a
                    href={`/api/collections/${id}?format=csv`}
                    download={`codeclone-collection-${id}-items.csv`}
                    className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[13px]"
                    title="Download these items as CSV"
                  >
                    <DownloadSimple weight="duotone" size={14} />
                    CSV
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[13px]"
                >
                  <PencilSimple weight="duotone" size={14} />
                  edit
                </button>
              </div>
            </div>
          ) : (
            <form
              onSubmit={saveMeta}
              className="ruled rounded-md p-4 mb-6 bg-[var(--color-paper-2)]"
            >
              <label className="block mb-3">
                <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] block mb-1">
                  title
                </span>
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  maxLength={120}
                  className="w-full px-2.5 h-9 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[14px] outline-none focus:border-[var(--color-ink-3)]"
                />
              </label>
              <label className="block mb-3">
                <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] block mb-1">
                  description
                </span>
                <textarea
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  maxLength={500}
                  rows={2}
                  className="w-full px-2.5 py-2 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[13.5px] outline-none focus:border-[var(--color-ink-3)] resize-y"
                />
              </label>
              <div className="flex items-center gap-2 justify-between">
                <button
                  type="button"
                  onClick={deleteCollection}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded border border-[var(--color-neg-bar)] text-[var(--color-neg)] text-[13px] disabled:opacity-50"
                >
                  <Trash weight="duotone" size={14} />
                  delete collection
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded border border-[var(--color-rule)] text-[13px]"
                  >
                    <XIcon weight="duotone" size={14} />
                    cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!editTitle.trim() || busy}
                    className="inline-flex items-center gap-1.5 px-3 h-8 rounded bg-[var(--color-ink-1)] text-[var(--color-paper)] text-[13px] disabled:opacity-50"
                  >
                    <FloppyDisk weight="duotone" size={14} />
                    save
                  </button>
                </div>
              </div>
            </form>
          )}

          <div className="flex items-center justify-between mb-3">
            <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">
              items
            </div>
            {!adding && (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[13px]"
              >
                <Plus weight="duotone" size={14} />
                add share
              </button>
            )}
          </div>

          {adding && (
            <form
              onSubmit={addItem}
              className="ruled rounded-md p-3 mb-4 flex items-center gap-2"
            >
              <LinkIcon
                weight="duotone"
                size={16}
                className="text-[var(--color-ink-3)]"
              />
              <input
                autoFocus
                value={newShareId}
                onChange={(e) => setNewShareId(e.target.value)}
                placeholder="/r/<id> URL or share id"
                className="flex-1 px-2 h-9 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[13.5px] outline-none focus:border-[var(--color-ink-3)]"
              />
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setNewShareId("");
                  setError(null);
                }}
                className="px-2.5 h-9 rounded border border-[var(--color-rule)] text-[13px]"
              >
                cancel
              </button>
              <button
                type="submit"
                disabled={busy || !newShareId.trim()}
                className="px-3 h-9 rounded bg-[var(--color-ink-1)] text-[var(--color-paper)] text-[13px] disabled:opacity-50"
              >
                add
              </button>
            </form>
          )}

          {error && <div className="mb-3"><ErrorBlock message={error} /></div>}

          {data.items.length === 0 ? (
            <Empty
              title="No items yet"
              hint="Paste a /r/<id> URL above to add a saved comparison."
            />
          ) : (
            <div className="ruled rounded-md overflow-hidden">
              {data.items.map((item, i) => (
                <div
                  key={item.id}
                  className={`px-4 py-3 flex items-center gap-3 ${
                    i > 0 ? "border-t border-[var(--color-rule)]" : ""
                  }`}
                >
                  <FolderSimple
                    weight="duotone"
                    size={16}
                    className="text-[var(--color-ink-3)] shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="text-[13.5px] truncate">
                        {item.missing
                          ? "(deleted share)"
                          : item.title || `share ${item.id}`}
                      </div>
                      {!item.missing && (
                        <span className="mono text-[10.5px] uppercase tracking-[0.14em] px-1.5 py-px rounded border border-[var(--color-rule)] text-[var(--color-ink-3)]">
                          {item.language}
                        </span>
                      )}
                      {!item.missing && (
                        <span className="mono text-[10.5px] text-[var(--color-ink-3)]">
                          {(item.shingleJaccard * 100).toFixed(0)}% • {item.cloneLabel}
                        </span>
                      )}
                    </div>
                    <div className="mono text-[10.5px] text-[var(--color-ink-4)] mt-0.5 truncate">
                      {item.id}
                      {!item.missing && ` • ${fmtTs(item.createdAt)}`}
                    </div>
                  </div>
                  {!item.missing && (
                    <Link
                      href={`/r/${item.id}`}
                      target="_blank"
                      className="inline-flex items-center gap-1 px-2 h-7 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[12px]"
                    >
                      <ArrowSquareOut weight="duotone" size={12} />
                      open
                    </Link>
                  )}
                  <button
                    type="button"
                    onClick={() => removeItem(item.id)}
                    disabled={busy}
                    aria-label="remove from collection"
                    className="inline-flex items-center justify-center w-7 h-7 rounded border border-[var(--color-rule)] hover:border-[var(--color-neg-bar)] hover:text-[var(--color-neg)] disabled:opacity-50"
                  >
                    <Trash weight="duotone" size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
