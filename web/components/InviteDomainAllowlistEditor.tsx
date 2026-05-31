"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Trash, Plus, Warning } from "@phosphor-icons/react/dist/ssr";

interface AllowlistResponse {
  domains: string[];
  canEdit: boolean;
}

interface Props {
  workspaceId: string;
}

/**
 * Workspace invite-domain allowlist editor.
 *
 * When this list is non-empty, only email addresses whose domain matches
 * an entry can be added to the workspace, by any path: manual invite,
 * invite acceptance, domain auto-join, SCIM provisioning, or SSO
 * just-in-time provisioning. Empty list disables enforcement. Owner
 * (or member with manage rights) only. Each change is audited.
 */
export function InviteDomainAllowlistEditor({ workspaceId }: Props) {
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
      const r = await fetch(`/api/workspaces/${workspaceId}/invite-domain-allowlist`, { cache: "no-store" });
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

  const save = useCallback(async (domains: string[]) => {
    if (!data?.canEdit) return;
    setSaving(true);
    setError(null);
    setRejected([]);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/invite-domain-allowlist`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domains }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { domains: string[]; rejected: string[] };
      setData((d) => (d ? { ...d, domains: j.domains } : d));
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
    void save([...data.domains, v]);
    setDraft("");
  }, [draft, data, save]);

  const removeEntry = useCallback((d: string) => {
    if (!data) return;
    void save(data.domains.filter((e) => e !== d));
  }, [data, save]);

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] flex items-center gap-1.5">
          <ShieldCheck weight="duotone" size={14} /> invite domain allowlist
        </div>
        {savedFlash && (
          <span className="mono text-[10.5px] text-[var(--color-ink-4)]">saved</span>
        )}
      </div>

      <div className="ruled rounded-md p-4">
        <p className="text-[12.5px] text-[var(--color-ink-3)] mb-3 leading-relaxed">
          Restrict which email domains can join this workspace. Applies to
          manual invites, invite acceptance, SSO sign-in, and SCIM
          provisioning. Existing members are never removed by a change.
          Leave empty to permit any domain.
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
                no domains. any email may be invited.
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
              <div className="flex flex-col sm:flex-row gap-2">
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
            ) : (
              <div className="mono text-[11px] text-[var(--color-ink-4)]">
                only workspace owners can edit the invite domain allowlist.
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
