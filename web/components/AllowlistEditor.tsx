"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Trash, Plus, Warning } from "@phosphor-icons/react/dist/ssr";

interface AllowlistResponse {
  entries: string[];
  canEdit: boolean;
}

interface Props {
  workspaceId: string;
}

/**
 * Workspace IP allowlist editor.
 *
 * Lets a workspace owner restrict API + dashboard access to a list of
 * IPv4 / IPv6 CIDR ranges. Empty list disables enforcement. Members
 * without manage rights see a read-only view so they understand why a
 * request may be blocked. All edits flow through PUT /api/workspaces/:id/allowlist
 * which records before/after diffs in the audit log.
 */
export function AllowlistEditor({ workspaceId }: Props) {
  const [data, setData] = useState<AllowlistResponse | null>(null);
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
      const r = await fetch(`/api/workspaces/${workspaceId}/allowlist`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as AllowlistResponse;
      setData(j);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (entries: string[]) => {
    if (!data?.canEdit) return;
    setSaving(true);
    setError(null);
    setRejected([]);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/allowlist`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { entries: string[]; rejected: string[] };
      setData((d) => (d ? { ...d, entries: j.entries } : d));
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
    const v = draft.trim();
    if (!v || !data) return;
    if (data.entries.includes(v)) { setDraft(""); return; }
    void save([...data.entries, v]);
    setDraft("");
  }, [draft, data, save]);

  const removeEntry = useCallback((cidr: string) => {
    if (!data) return;
    void save(data.entries.filter((e) => e !== cidr));
  }, [data, save]);

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] flex items-center gap-1.5">
          <ShieldCheck weight="duotone" size={14} /> ip allowlist
        </div>
        {savedFlash && (
          <span className="mono text-[10.5px] text-[var(--color-ink-4)]">saved</span>
        )}
      </div>

      <div className="ruled rounded-md p-4">
        <p className="text-[12.5px] text-[var(--color-ink-3)] mb-3 leading-relaxed">
          Restrict API access for keys bound to this workspace, plus dashboard
          access for members, to specific IPv4 or IPv6 CIDR ranges. Leave empty
          for no restriction. Loopback is always permitted.
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
            {data.entries.length === 0 ? (
              <div className="mono text-[11px] text-[var(--color-ink-4)] mb-3">
                no rules. all IPs allowed.
              </div>
            ) : (
              <ul className="mb-3 divide-y divide-[var(--color-rule)] border border-[var(--color-rule)] rounded">
                {data.entries.map((cidr) => (
                  <li key={cidr} className="flex items-center gap-2 px-3 py-2">
                    <code className="mono text-[12px] flex-1 truncate">{cidr}</code>
                    {data.canEdit && (
                      <button
                        onClick={() => removeEntry(cidr)}
                        disabled={saving}
                        type="button"
                        aria-label={`Remove ${cidr}`}
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
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  inputMode="text"
                  placeholder="e.g. 203.0.113.0/24 or 2001:db8::/32"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEntry(); } }}
                  disabled={saving}
                  className="flex-1 px-3 h-9 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[13px] mono"
                />
                <button
                  type="button"
                  onClick={addEntry}
                  disabled={saving || !draft.trim()}
                  className="inline-flex items-center justify-center gap-1.5 px-3 h-9 rounded border border-[var(--color-rule)] text-[13px] disabled:opacity-50 hover:bg-[var(--color-paper-2)]"
                >
                  <Plus weight="duotone" size={14} /> add CIDR
                </button>
              </div>
            ) : (
              <div className="mono text-[11px] text-[var(--color-ink-4)]">
                only workspace owners can edit the allowlist.
              </div>
            )}

            {rejected.length > 0 && (
              <div className="mt-3 text-[12px] text-amber-700 flex items-start gap-1.5">
                <Warning weight="duotone" size={14} className="mt-[2px]" />
                <span>Rejected (invalid CIDR): <code className="mono">{rejected.join(", ")}</code></span>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
