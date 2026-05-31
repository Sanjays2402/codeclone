"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  UsersThree,
  Plus,
  ArrowRight,
  X,
  FloppyDisk,
  Crown,
  PencilSimple,
  Eye,
} from "@phosphor-icons/react/dist/ssr";
import { H1 } from "../../components/Headings";
import { Empty, ErrorBlock, LoadingRow } from "../../components/States";
import { fmtTs } from "../../lib/format";

interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  memberCount: number;
  myRole: "owner" | "editor" | "viewer" | null;
}

type Status = "loading" | "ready" | "error" | "unauth";

const RoleIcon = ({ role }: { role: WorkspaceSummary["myRole"] }) => {
  if (role === "owner") return <Crown weight="duotone" size={12} />;
  if (role === "editor") return <PencilSimple weight="duotone" size={12} />;
  return <Eye weight="duotone" size={12} />;
};

export default function WorkspacesPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<WorkspaceSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/workspaces", { cache: "no-store" });
      if (res.status === 401) { setStatus("unauth"); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(Array.isArray(data.items) ? data.items : []);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
      setStatus("error");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      setName("");
      setCreating(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to create");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <H1 eyebrow="team">workspaces</H1>
      <p className="text-[14px] text-[var(--color-ink-3)] mb-6 max-w-[620px]">
        Group teammates into a shared workspace. Owners invite, editors run comparisons,
        viewers read. Roles are per workspace.
      </p>

      <div className="flex items-center justify-between mb-4">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">
          {status === "ready" ? `${items.length} total` : status === "unauth" ? "sign in to view" : "loading"}
        </div>
        {status !== "unauth" && !creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[13px]"
          >
            <Plus weight="duotone" size={14} />
            new workspace
          </button>
        )}
      </div>

      {status === "unauth" && (
        <div className="ruled rounded-md p-6 text-center">
          <UsersThree weight="duotone" size={28} className="mx-auto text-[var(--color-ink-3)] mb-2" />
          <div className="text-[14px] mb-3">Sign in to create or join a workspace.</div>
          <Link href="/signin?redirect=/workspaces" className="inline-flex items-center gap-1.5 px-3 h-8 rounded bg-[var(--color-ink-1)] text-[var(--color-paper)] text-[13px]">
            sign in <ArrowRight weight="duotone" size={14} />
          </Link>
        </div>
      )}

      {creating && (
        <form onSubmit={submit} className="ruled rounded-md p-4 mb-4 bg-[var(--color-paper-2)]">
          <label className="block mb-3">
            <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] block mb-1">
              name
            </span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Backend platform"
              maxLength={64}
              className="w-full px-2.5 h-9 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[14px] outline-none focus:border-[var(--color-ink-3)]"
            />
          </label>
          {error && <div className="text-[12px] text-red-500 mb-2">{error}</div>}
          <div className="flex items-center gap-2 justify-end">
            <button type="button" onClick={() => { setCreating(false); setName(""); setError(null); }}
              className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded border border-[var(--color-rule)] text-[13px]">
              <X weight="duotone" size={14} /> cancel
            </button>
            <button type="submit" disabled={!name.trim() || saving}
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded bg-[var(--color-ink-1)] text-[var(--color-paper)] text-[13px] disabled:opacity-50">
              <FloppyDisk weight="duotone" size={14} />
              {saving ? "saving" : "create"}
            </button>
          </div>
        </form>
      )}

      {status === "loading" && <LoadingRow rows={3} />}
      {status === "error" && error && <ErrorBlock message={error} />}
      {status === "ready" && items.length === 0 && (
        <Empty
          title="No workspaces yet"
          hint="Create one to invite teammates and share comparisons under a common roof."
        />
      )}
      {status === "ready" && items.length > 0 && (
        <div className="ruled rounded-md overflow-hidden">
          {items.map((w, i) => (
            <Link key={w.id} href={`/workspaces/${w.id}`}
              className={`block px-4 py-3 hover:bg-[var(--color-paper-2)] ${i > 0 ? "border-t border-[var(--color-rule)]" : ""}`}>
              <div className="flex items-center gap-3">
                <UsersThree weight="duotone" size={18} className="text-[var(--color-ink-3)] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-[14px] font-medium truncate">{w.name}</div>
                    {w.myRole && (
                      <span className="mono text-[10px] uppercase tracking-[0.14em] inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-3)]">
                        <RoleIcon role={w.myRole} />
                        {w.myRole}
                      </span>
                    )}
                  </div>
                  <div className="mono text-[10.5px] text-[var(--color-ink-4)] mt-0.5">
                    {w.memberCount} member{w.memberCount === 1 ? "" : "s"} · created {fmtTs(w.createdAt)}
                  </div>
                </div>
                <ArrowRight weight="duotone" size={14} className="text-[var(--color-ink-4)] shrink-0" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
