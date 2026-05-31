"use client";

import { useCallback, useEffect, useState } from "react";
import { UsersThree, Trash, Warning, CheckCircle, Plus } from "@phosphor-icons/react/dist/ssr";

type Role = "owner" | "editor" | "viewer";

interface Mapping { group: string; role: Role }

interface SsoSnapshot {
  provider?: string;
  issuer?: string;
  groupClaim?: string;
  groupMappings?: Mapping[];
  groupsUpdatedAt?: number | null;
  groupsUpdatedBy?: string | null;
}

interface Response {
  sso: SsoSnapshot | null;
  canEdit: boolean;
  ssoConfigured: boolean;
  limits: {
    maxMappings: number;
    maxGroupNameLength: number;
    maxClaimNameLength: number;
  };
}

interface Props { workspaceId: string }

/**
 * Workspace SSO group-to-role mapping editor.
 *
 * Owner-only. Configure a single id_token claim name (e.g. "groups") and
 * a table of (IdP group -> codeclone role) rows. On every SSO sign-in
 * the callback re-syncs the member's role from the highest-ranked
 * matching mapping. Sole-owner protection is enforced server-side, and
 * each role flip is audited with a before/after diff.
 *
 * Read-only view for non-owners so the policy is still visible in the
 * workspace surface a reviewer can browse.
 */
export function SsoGroupMappingEditor({ workspaceId }: Props) {
  const [data, setData] = useState<Response | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [claim, setClaim] = useState("");
  const [rows, setRows] = useState<Mapping[]>([]);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/sso/groups`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const json: Response = await res.json();
      setData(json);
      setClaim(json.sso?.groupClaim ?? "");
      setRows((json.sso?.groupMappings ?? []).map((m) => ({ ...m })));
      setStatus("ready");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load_failed");
      setStatus("error");
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    setErr(null);
    setSaved(false);
    try {
      const clean = rows
        .map((r) => ({ group: r.group.trim(), role: r.role }))
        .filter((r) => r.group.length > 0);
      const res = await fetch(`/api/workspaces/${workspaceId}/sso/groups`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupClaim: claim.trim(), groupMappings: clean }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || String(res.status));
      }
      setSaved(true);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save_failed");
    } finally {
      setSaving(false);
    }
  }, [workspaceId, claim, rows, load]);

  const clear = useCallback(async () => {
    if (!confirm("Clear the SSO group policy? Roles stop syncing from your IdP.")) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/sso/groups`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || String(res.status));
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "clear_failed");
    } finally {
      setSaving(false);
    }
  }, [workspaceId, load]);

  if (status === "loading") {
    return (
      <section className="rounded-md border border-neutral-200 dark:border-neutral-800 p-4">
        <div className="h-5 w-48 bg-neutral-100 dark:bg-neutral-900 rounded animate-pulse" />
        <div className="mt-3 h-16 bg-neutral-50 dark:bg-neutral-950 rounded animate-pulse" />
      </section>
    );
  }
  if (status === "error" || !data) {
    return (
      <section className="rounded-md border border-red-200 dark:border-red-900 p-4 text-sm text-red-700 dark:text-red-300">
        <div className="flex items-center gap-2">
          <Warning weight="duotone" size={16} />
          Could not load SSO group policy ({err ?? "unknown"}).
        </div>
      </section>
    );
  }

  const canEdit = data.canEdit;
  const ssoConfigured = data.ssoConfigured;
  const maxMappings = data.limits.maxMappings;
  const maxClaim = data.limits.maxClaimNameLength;
  const maxGroup = data.limits.maxGroupNameLength;

  return (
    <section className="rounded-md border border-neutral-200 dark:border-neutral-800 p-4">
      <header className="flex items-start gap-2">
        <UsersThree weight="duotone" size={18} className="mt-0.5 text-neutral-500" />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium">SSO group to role mapping</h3>
          <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
            Pick the id_token claim that carries the user&apos;s groups (e.g. <code>groups</code>),
            then map each IdP group to a workspace role. On every SSO sign-in we update the
            member&apos;s role from the highest-ranked matching mapping. Sole-owner demotions are
            rejected and audited.
          </p>
        </div>
      </header>

      {!ssoConfigured && (
        <div className="mt-3 rounded border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          Configure OIDC SSO above before adding a group policy.
        </div>
      )}

      <div className="mt-4 space-y-3">
        <label className="block text-xs">
          <span className="text-neutral-700 dark:text-neutral-300">Group claim name</span>
          <input
            type="text"
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
            disabled={!canEdit || !ssoConfigured}
            maxLength={maxClaim}
            placeholder="groups"
            className="mt-1 w-full sm:w-64 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm disabled:opacity-60"
          />
        </label>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-neutral-500">
                <th className="py-1 pr-2 font-normal">IdP group</th>
                <th className="py-1 pr-2 font-normal w-32">Role</th>
                {canEdit && <th className="py-1 w-8" />}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={canEdit ? 3 : 2} className="py-3 text-xs text-neutral-500">
                    No mappings yet. Add one to start syncing roles from your IdP.
                  </td>
                </tr>
              )}
              {rows.map((row, idx) => (
                <tr key={idx} className="border-t border-neutral-100 dark:border-neutral-900">
                  <td className="py-1 pr-2">
                    <input
                      type="text"
                      value={row.group}
                      onChange={(e) => {
                        const next = rows.slice();
                        next[idx] = { ...next[idx], group: e.target.value };
                        setRows(next);
                      }}
                      disabled={!canEdit || !ssoConfigured}
                      maxLength={maxGroup}
                      placeholder="okta-admins"
                      className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm disabled:opacity-60"
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <select
                      value={row.role}
                      onChange={(e) => {
                        const next = rows.slice();
                        next[idx] = { ...next[idx], role: e.target.value as Role };
                        setRows(next);
                      }}
                      disabled={!canEdit || !ssoConfigured}
                      className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm disabled:opacity-60"
                    >
                      <option value="owner">owner</option>
                      <option value="editor">editor</option>
                      <option value="viewer">viewer</option>
                    </select>
                  </td>
                  {canEdit && (
                    <td className="py-1 text-right">
                      <button
                        type="button"
                        aria-label="Remove mapping"
                        onClick={() => setRows(rows.filter((_, i) => i !== idx))}
                        className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-900 text-neutral-500"
                      >
                        <Trash weight="duotone" size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                if (rows.length >= maxMappings) return;
                setRows([...rows, { group: "", role: "viewer" }]);
              }}
              disabled={!ssoConfigured || rows.length >= maxMappings}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-900 disabled:opacity-50"
            >
              <Plus weight="duotone" size={14} /> Add mapping
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || !ssoConfigured}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving" : "Save policy"}
            </button>
            {(data.sso?.groupClaim || (data.sso?.groupMappings?.length ?? 0) > 0) && (
              <button
                type="button"
                onClick={clear}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
              >
                <Trash weight="duotone" size={14} /> Clear policy
              </button>
            )}
            <span className="text-xs text-neutral-500 self-center">
              {rows.length} / {maxMappings} mappings
            </span>
          </div>
        )}

        {err && (
          <div className="text-xs text-red-700 dark:text-red-300 flex items-center gap-1.5">
            <Warning weight="duotone" size={14} /> {err}
          </div>
        )}
        {saved && !err && (
          <div className="text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
            <CheckCircle weight="duotone" size={14} /> Saved.
          </div>
        )}
      </div>
    </section>
  );
}
