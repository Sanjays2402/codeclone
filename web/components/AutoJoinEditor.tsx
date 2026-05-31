"use client";

import { useCallback, useEffect, useState } from "react";
import { UserCirclePlus, Trash, Plus, Warning } from "@phosphor-icons/react/dist/ssr";

interface AutoJoinResponse {
  domains: string[];
  role: "editor" | "viewer";
  canEdit: boolean;
}

interface Props {
  workspaceId: string;
}

/**
 * Workspace domain auto-join editor.
 *
 * When a user signs in (magic link or SSO) with an email whose domain
 * matches one of the entries here, they are automatically added to the
 * workspace as a member with the configured default role. Empty list
 * disables auto-join. Owner-only edits. Persists via
 * PUT /api/workspaces/:id/auto-join, which writes before/after diffs to
 * the audit log. Each auto-join event is also audited at sign-in time.
 */
export function AutoJoinEditor({ workspaceId }: Props) {
  const [data, setData] = useState<AutoJoinResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const [savedFlash, setSavedFlash] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/auto-join`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as AutoJoinResponse;
      setData(j);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (domains: string[], role: "editor" | "viewer") => {
    if (!data?.canEdit) return;
    setSaving(true);
    setError(null);
    setRejected([]);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/auto-join`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domains, role }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { domains: string[]; role: "editor" | "viewer"; rejected: string[] };
      setData((d) => (d ? { ...d, domains: j.domains, role: j.role } : d));
      setRejected(j.rejected || []);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [data?.canEdit, workspaceId]);

  const addEntry = useCallback(() => {
    const v = draft.trim().toLowerCase().replace(/^@/, "");
    if (!v || !data) return;
    if (data.domains.includes(v)) { setDraft(""); return; }
    void save([...data.domains, v], data.role);
    setDraft("");
  }, [draft, data, save]);

  const removeEntry = useCallback((d: string) => {
    if (!data) return;
    void save(data.domains.filter((e) => e !== d), data.role);
  }, [data, save]);

  const changeRole = useCallback((role: "editor" | "viewer") => {
    if (!data) return;
    void save(data.domains, role);
  }, [data, save]);

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] flex items-center gap-1.5">
          <UserCirclePlus weight="duotone" size={14} /> domain auto-join
        </div>
        {savedFlash && (
          <span className="mono text-[10.5px] text-[var(--color-ink-4)]">saved</span>
        )}
      </div>

      <div className="ruled rounded-md p-4">
        <p className="text-[12.5px] text-[var(--color-ink-3)] mb-3 leading-relaxed">
          Users who sign in with an email at one of these domains join this
          workspace automatically with the role below. Leave empty to require
          an explicit invite for every member.
        </p>

        {status === "loading" && (
          <div className="mono text-[11px] text-[var(--color-ink-4)]">loading...</div>
        )}

        {status === "error" && (
          <div className="text-[12.5px] text-red-600 mb-2 flex items-center gap-1.5">
            <Warning weight="duotone" size={14} /> {error}
          </div>
        )}

        {status === "ready" && data && (
          <>
            {data.domains.length === 0 ? (
              <div className="mono text-[11px] text-[var(--color-ink-4)] mb-3">
                no domains. auto-join disabled.
              </div>
            ) : (
              <ul className="mb-3 divide-y divide-[var(--color-rule)] border border-[var(--color-rule)] rounded">
                {data.domains.map((d) => (
                  <li key={d} className="flex items-center gap-2 px-3 py-2">
                    <code className="mono text-[12px] flex-1 truncate">@{d}</code>
                    {data.canEdit && (
                      <button
                        onClick={() => removeEntry(d)}
                        disabled={saving}
                        type="button"
                        aria-label={`Remove ${d}`}
                        className="inline-flex items-center gap-1 px-2 h-7 rounded border border-[var(--color-rule)] text-[12px] text-[var(--color-ink-3)] hover:bg-[var(--color-paper-2)] disabled:opacity-50"
                      >
                        <Trash weight="duotone" size={12} /> remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {data.canEdit ? (
              <>
                <div className="flex flex-col sm:flex-row gap-2 mb-3">
                  <input
                    type="text"
                    inputMode="text"
                    placeholder="e.g. acme.com"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEntry(); } }}
                    disabled={saving}
                    aria-label="Domain to add"
                    className="flex-1 px-3 h-9 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[13px] mono"
                  />
                  <button
                    type="button"
                    onClick={addEntry}
                    disabled={saving || !draft.trim()}
                    className="inline-flex items-center justify-center gap-1.5 px-3 h-9 rounded border border-[var(--color-rule)] text-[13px] disabled:opacity-50 hover:bg-[var(--color-paper-2)]"
                  >
                    <Plus weight="duotone" size={14} /> add domain
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor="autojoin-role" className="mono text-[11px] text-[var(--color-ink-3)]">
                    default role
                  </label>
                  <select
                    id="autojoin-role"
                    value={data.role}
                    onChange={(e) => changeRole(e.target.value === "editor" ? "editor" : "viewer")}
                    disabled={saving}
                    className="px-2 h-8 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[12.5px]"
                  >
                    <option value="viewer">viewer</option>
                    <option value="editor">editor</option>
                  </select>
                </div>
              </>
            ) : (
              <div className="mono text-[11px] text-[var(--color-ink-4)]">
                only workspace owners can edit auto-join domains.
              </div>
            )}

            {rejected.length > 0 && (
              <div className="mt-3 text-[12px] text-amber-700 flex items-start gap-1.5">
                <Warning weight="duotone" size={14} className="mt-[2px]" />
                <span>Rejected (invalid domain): <code className="mono">{rejected.join(", ")}</code></span>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
