"use client";

import { useCallback, useEffect, useState } from "react";
import { Globe, Trash, Plus, Warning } from "@phosphor-icons/react/dist/ssr";

interface AllowlistResponse {
  entries: string[];
  canEdit: boolean;
}

interface Props {
  workspaceId: string;
}

/**
 * Workspace webhook destination domain allowlist editor.
 *
 * Restricts which hostnames any webhook in this workspace may target,
 * both at create time and at delivery time. Useful for keeping
 * production data flowing only to vetted partner systems. Accepts exact
 * hosts (`hooks.example.com`) or wildcard suffixes (`*.example.com`).
 * Empty list disables enforcement. The SSRF rules (no loopback /
 * private / link-local) always apply on top.
 */
export function WebhookDomainAllowlistEditor({ workspaceId }: Props) {
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
      const r = await fetch(`/api/workspaces/${workspaceId}/webhook-domains`, { cache: "no-store" });
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
      const r = await fetch(`/api/workspaces/${workspaceId}/webhook-domains`, {
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
    const v = draft.trim().toLowerCase();
    if (!v || !data) return;
    if (data.entries.includes(v)) { setDraft(""); return; }
    void save([...data.entries, v]);
    setDraft("");
  }, [draft, data, save]);

  const removeEntry = useCallback((host: string) => {
    if (!data) return;
    void save(data.entries.filter((e) => e !== host));
  }, [data, save]);

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] flex items-center gap-1.5">
          <Globe weight="duotone" size={14} /> webhook domain allowlist
        </div>
        {savedFlash && (
          <span className="mono text-[10.5px] text-[var(--color-ink-4)]">saved</span>
        )}
      </div>

      <div className="ruled rounded-md p-4">
        <p className="text-[12.5px] text-[var(--color-ink-3)] mb-3 leading-relaxed">
          Restrict the hostnames any webhook in this workspace may target. Use an
          exact host like <code className="mono">hooks.partner.com</code> or a
          wildcard suffix like <code className="mono">*.partner.com</code>. Empty
          list means no restriction. Enforced at create time and on every
          delivery, so tightening the list immediately stops in-flight
          deliveries to a now-disallowed host.
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
                no rules. any public host allowed.
              </div>
            ) : (
              <ul className="mb-3 divide-y divide-[var(--color-rule)] border border-[var(--color-rule)] rounded">
                {data.entries.map((host) => (
                  <li key={host} className="flex items-center gap-2 px-3 py-2">
                    <code className="mono text-[12px] flex-1 truncate">{host}</code>
                    {data.canEdit && (
                      <button
                        onClick={() => removeEntry(host)}
                        disabled={saving}
                        type="button"
                        aria-label={`Remove ${host}`}
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
                  inputMode="url"
                  placeholder="e.g. hooks.partner.com or *.partner.com"
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
                  <Plus weight="duotone" size={14} /> add domain
                </button>
              </div>
            ) : (
              <div className="mono text-[11px] text-[var(--color-ink-4)]">
                only workspace owners can edit this allowlist.
              </div>
            )}

            {rejected.length > 0 && (
              <div className="mt-3 text-[12px] text-amber-700 flex items-start gap-1.5">
                <Warning weight="duotone" size={14} className="mt-[2px]" />
                <span>Rejected (invalid host): <code className="mono">{rejected.join(", ")}</code></span>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
