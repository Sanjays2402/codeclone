"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  BookmarksSimple,
  Plus,
  Trash,
  PencilSimple,
  ArrowsLeftRight,
  MagnifyingGlass,
  Tag,
  FloppyDisk,
  X,
  Code,
} from "@phosphor-icons/react/dist/ssr";
import { H1 } from "../../components/Headings";
import { Empty, ErrorBlock, LoadingRow } from "../../components/States";
import { COMPARE_LANGUAGES } from "../../lib/compare-samples";
import { fmtTs } from "../../lib/format";

interface Snippet {
  id: string;
  title: string;
  language: string;
  body: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

type Status = "loading" | "ready" | "error" | "unauthorized";

const LANGS = COMPARE_LANGUAGES.filter((l) => l !== "auto");

function loadDraftKey(slot: "a" | "b") {
  return `cc.compare.${slot}`;
}

export default function SnippetsPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Snippet[]>([]);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      const res = await fetch(`/api/snippets?${params.toString()}`, {
        cache: "no-store",
      });
      if (res.status === 401) {
        setStatus("unauthorized");
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `failed (${res.status})`);
      }
      const json = (await res.json()) as { items: Snippet[] };
      setItems(json.items);
      setStatus("ready");
    } catch (err: unknown) {
      setError((err as Error).message);
      setStatus("error");
    }
  }, [q]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const remove = useCallback(
    async (id: string) => {
      if (!confirm("Delete this snippet?")) return;
      const res = await fetch(`/api/snippets/${id}`, { method: "DELETE" });
      if (res.ok) refresh();
    },
    [refresh],
  );

  const loadInto = useCallback((s: Snippet, slot: "a" | "b") => {
    try {
      localStorage.setItem(loadDraftKey(slot), s.body);
      localStorage.setItem("cc.compare.language", s.language);
    } catch {
      // ignore
    }
    window.location.href = `/compare?from=snippet&slot=${slot}`;
  }, []);

  const tags = useMemo(() => {
    const seen = new Set<string>();
    for (const s of items) for (const t of s.tags) seen.add(t);
    return Array.from(seen).sort();
  }, [items]);

  return (
    <main className="mx-auto max-w-[1280px] px-4 sm:px-7 py-8">
      <H1 eyebrow="library">snippets</H1>
      <p className="text-[14px] text-[var(--color-ink-3)] mt-2 max-w-[60ch]">
        Save reusable code blocks you compare against often. Load any snippet
        into the left or right pane of /compare in one click.
      </p>

      <div className="mt-6 flex flex-col sm:flex-row gap-3 sm:items-center">
        <div className="flex items-center gap-2 ruled rounded-md px-3 py-2 bg-[var(--color-paper)] flex-1 max-w-[420px]">
          <MagnifyingGlass size={14} weight="duotone" className="text-[var(--color-ink-4)]" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title, body, tag"
            className="bg-transparent outline-none flex-1 text-[13px] mono"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            setCreating(true);
            setEditing(null);
          }}
          className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-3 py-2 rounded-sm border border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-paper)] hover:opacity-90"
        >
          <Plus size={12} weight="bold" />
          New snippet
        </button>
      </div>

      {tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setQ(t)}
              className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.14em] px-1.5 py-px border border-[var(--color-rule)] rounded-sm text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            >
              <Tag size={10} weight="duotone" />
              {t}
            </button>
          ))}
        </div>
      )}

      <section className="mt-6">
        {status === "loading" && <LoadingRow rows={4} />}
        {status === "error" && <ErrorBlock message={error ?? "failed"} />}
        {status === "unauthorized" && (
          <div className="ruled rounded-md p-6 bg-[var(--color-paper)]">
            <p className="text-[14px]">
              Sign in to save snippets to your account.
            </p>
            <Link
              href="/signin?redirectTo=/snippets"
              className="inline-flex items-center mt-3 mono text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-paper)]"
            >
              Sign in
            </Link>
          </div>
        )}
        {status === "ready" && items.length === 0 && (
          <Empty
            title="No snippets yet"
            hint="Save a canonical implementation or a suspected source to reuse across comparisons."
          />
        )}
        {status === "ready" && items.length > 0 && (
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {items.map((s) => (
              <li
                key={s.id}
                className="ruled rounded-md p-4 bg-[var(--color-paper)] flex flex-col gap-3"
              >
                <header className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-[14px] font-medium truncate">{s.title}</h3>
                    <div className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] mt-0.5 flex items-center gap-2">
                      <span className="inline-flex items-center gap-1">
                        <Code size={10} weight="duotone" />
                        {s.language}
                      </span>
                      <span>·</span>
                      <span>{fmtTs(s.updatedAt)}</span>
                    </div>
                  </div>
                </header>
                <pre className="mono text-[11px] leading-snug bg-[var(--color-paper-2)] rounded-sm p-2 overflow-hidden max-h-24 text-[var(--color-ink-2)]">
                  {s.body.split("\n").slice(0, 6).join("\n")}
                </pre>
                {s.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {s.tags.map((t) => (
                      <span
                        key={t}
                        className="mono text-[10px] uppercase tracking-[0.14em] px-1.5 py-px border border-[var(--color-rule)] rounded-sm text-[var(--color-ink-3)]"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-1 mt-auto pt-1">
                  <button
                    type="button"
                    onClick={() => loadInto(s, "a")}
                    className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)]"
                    title="Load into left pane"
                  >
                    <ArrowsLeftRight size={11} weight="duotone" />
                    Left
                  </button>
                  <button
                    type="button"
                    onClick={() => loadInto(s, "b")}
                    className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)]"
                    title="Load into right pane"
                  >
                    <ArrowsLeftRight size={11} weight="duotone" />
                    Right
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(s);
                      setCreating(false);
                    }}
                    className="ml-auto inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-3)]"
                  >
                    <PencilSimple size={11} weight="duotone" />
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(s.id)}
                    className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[var(--color-neg)]"
                  >
                    <Trash size={11} weight="duotone" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(creating || editing) && (
        <SnippetEditor
          initial={editing ?? undefined}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            refresh();
          }}
        />
      )}
    </main>
  );
}

function SnippetEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial?: Snippet;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [language, setLanguage] = useState(initial?.language ?? "python");
  const [body, setBody] = useState(initial?.body ?? "");
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setErr(null);
    const payload = {
      title,
      language,
      body,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
    };
    try {
      const url = initial ? `/api/snippets/${initial.id}` : "/api/snippets";
      const method = initial ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `failed (${res.status})`);
      }
      onSaved();
    } catch (e: unknown) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-[var(--color-paper)] w-full max-w-[640px] rounded-t-md sm:rounded-md ruled p-5 max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <BookmarksSimple size={16} weight="duotone" />
            <h2 className="text-[15px] font-medium">
              {initial ? "Edit snippet" : "New snippet"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            aria-label="Close"
          >
            <X size={16} weight="bold" />
          </button>
        </header>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="eyebrow">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Canonical quicksort"
              className="ruled rounded-sm px-3 py-2 bg-[var(--color-paper)] text-[14px] outline-none focus:border-[var(--color-ink)]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow">Language</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="ruled rounded-sm px-3 py-2 bg-[var(--color-paper)] text-[14px] outline-none focus:border-[var(--color-ink)]"
            >
              {LANGS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow">Body</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              placeholder="Paste code here"
              className="ruled rounded-sm px-3 py-2 bg-[var(--color-paper)] mono text-[12px] outline-none focus:border-[var(--color-ink)]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="eyebrow">Tags (comma separated)</span>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="canonical, baseline"
              className="ruled rounded-sm px-3 py-2 bg-[var(--color-paper)] text-[13px] mono outline-none focus:border-[var(--color-ink)]"
            />
          </label>
          {err && <ErrorBlock message={err} />}
          <div className="flex items-center justify-end gap-2 mt-2">
            <button
              type="button"
              onClick={onClose}
              className="mono text-[11px] uppercase tracking-[0.14em] px-3 py-2 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={save}
              className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-3 py-2 rounded-sm border border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-paper)] hover:opacity-90 disabled:opacity-50"
            >
              <FloppyDisk size={12} weight="duotone" />
              {saving ? "Saving" : "Save snippet"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
