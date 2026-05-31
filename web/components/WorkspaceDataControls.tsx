"use client";

import { useState } from "react";
import {
  DownloadSimple,
  Trash,
  Warning,
  CheckCircle,
  ShieldWarning,
} from "@phosphor-icons/react/dist/ssr";

interface Props {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  isOwner: boolean;
}

/**
 * Workspace data controls: GDPR/DPA export + hard-delete.
 *
 * Owner-only. The export endpoint streams the full JSON bundle (members,
 * invites, audit, scoped API keys). The delete endpoint requires the
 * caller to type the workspace slug and to have completed an MFA
 * challenge in the current session.
 */
export function WorkspaceDataControls({
  workspaceId,
  workspaceSlug,
  workspaceName,
  isOwner,
}: Props) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<"idle" | "export" | "delete">("idle");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  if (!isOwner) {
    return (
      <section className="mb-6">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] mb-2">
          data controls
        </div>
        <div className="ruled rounded-md px-4 py-3 text-[13px] text-[var(--color-ink-3)] flex items-center gap-2">
          <ShieldWarning weight="duotone" size={16} />
          Workspace export and deletion are restricted to owners.
        </div>
      </section>
    );
  }

  async function onExport(format: "json" | "csv") {
    setBusy("export");
    setError(null);
    setInfo(null);
    try {
      const r = await fetch(
        `/api/workspaces/${workspaceId}/export?format=${format}`,
        { cache: "no-store" },
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.message || j.error || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      a.download =
        format === "csv"
          ? `codeclone-workspace-${workspaceSlug}-audit-${stamp}.csv`
          : `codeclone-workspace-${workspaceSlug}-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setInfo(`Exported workspace as ${format.toUpperCase()}.`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("idle");
    }
  }

  async function onDelete() {
    if (confirm !== workspaceSlug) {
      setError(`Type the workspace slug "${workspaceSlug}" to confirm.`);
      return;
    }
    if (!window.confirm(`Delete workspace "${workspaceName}" and all its data? This cannot be undone.`)) {
      return;
    }
    setBusy("delete");
    setError(null);
    setInfo(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/wipe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401 && j.error === "mfa_required") {
          setError("MFA step-up required. Verify your code in Security settings and try again.");
        } else {
          setError(j.message || j.error || `HTTP ${r.status}`);
        }
        return;
      }
      // Hard-deleted. Navigate the user back to the workspaces list.
      window.location.assign("/workspaces");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("idle");
    }
  }

  async function onDryRun() {
    setBusy("delete");
    setError(null);
    setInfo(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/wipe?dry_run=true`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: workspaceSlug, dry_run: true }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.message || j.error || `HTTP ${r.status}`);
        return;
      }
      const m = j.wouldRemove || {};
      setInfo(`Dry run: would remove ${m.members ?? 0} member entries plus all invites and scoped keys.`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("idle");
    }
  }

  return (
    <section className="mb-6">
      <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] mb-2">
        data controls
      </div>
      <div className="ruled rounded-md">
        <div className="px-4 py-3 border-b border-[var(--color-rule)]">
          <div className="text-[13.5px] font-medium mb-1">Export workspace data</div>
          <div className="text-[12.5px] text-[var(--color-ink-3)] mb-3">
            Download every record bound to this workspace: members, invites,
            scoped API keys, and the audit log. Useful for DPA reviews and
            data subject requests.
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => onExport("json")}
              disabled={busy !== "idle"}
              type="button"
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded border border-[var(--color-rule)] text-[13px] hover:bg-[var(--color-paper-2)] disabled:opacity-50"
            >
              <DownloadSimple weight="duotone" size={14} />
              {busy === "export" ? "Exporting" : "Download JSON"}
            </button>
            <button
              onClick={() => onExport("csv")}
              disabled={busy !== "idle"}
              type="button"
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded border border-[var(--color-rule)] text-[13px] hover:bg-[var(--color-paper-2)] disabled:opacity-50"
            >
              <DownloadSimple weight="duotone" size={14} />
              Audit CSV
            </button>
          </div>
        </div>
        <div className="px-4 py-3">
          <div className="text-[13.5px] font-medium mb-1 flex items-center gap-1.5">
            <Warning weight="duotone" size={14} className="text-amber-600" />
            Delete workspace
          </div>
          <div className="text-[12.5px] text-[var(--color-ink-3)] mb-3">
            Permanently removes the workspace, all invites, every API key
            scoped to it, and member references. Audit history is preserved
            and remains attributable. Requires MFA step-up.
          </div>
          <label className="block text-[12px] text-[var(--color-ink-3)] mb-1">
            Type the workspace slug <span className="mono text-[var(--color-ink-2)]">{workspaceSlug}</span> to confirm
          </label>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy !== "idle"}
            placeholder={workspaceSlug}
            aria-label="Workspace slug confirmation"
            className="mono w-full max-w-xs px-2.5 h-8 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[13px] mb-3"
          />
          <div className="flex flex-wrap gap-2">
            <button
              onClick={onDryRun}
              disabled={busy !== "idle"}
              type="button"
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded border border-[var(--color-rule)] text-[13px] text-[var(--color-ink-3)] hover:bg-[var(--color-paper-2)] disabled:opacity-50"
            >
              Preview (dry run)
            </button>
            <button
              onClick={onDelete}
              disabled={busy !== "idle" || confirm !== workspaceSlug}
              type="button"
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded border border-red-300 bg-red-50 text-red-700 text-[13px] hover:bg-red-100 disabled:opacity-50"
            >
              <Trash weight="duotone" size={14} />
              {busy === "delete" ? "Deleting" : "Delete workspace"}
            </button>
          </div>
        </div>
        {(error || info) && (
          <div className="px-4 py-2 border-t border-[var(--color-rule)] text-[12.5px] flex items-start gap-1.5">
            {error ? (
              <>
                <Warning weight="duotone" size={14} className="text-red-600 mt-0.5 shrink-0" />
                <span className="text-red-700">{error}</span>
              </>
            ) : (
              <>
                <CheckCircle weight="duotone" size={14} className="text-emerald-600 mt-0.5 shrink-0" />
                <span className="text-[var(--color-ink-2)]">{info}</span>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
