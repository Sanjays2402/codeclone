"use client";

import { useCallback, useEffect, useState, use } from "react";
import Link from "next/link";
import {
  UsersThree,
  EnvelopeSimple,
  Trash,
  Copy,
  CheckCircle,
  ArrowLeft,
  Crown,
  CrownSimple,
  PencilSimple,
  Eye,
  PaperPlaneTilt,
  SignOut,
} from "@phosphor-icons/react/dist/ssr";
import { H1 } from "../../../components/Headings";
import { ErrorBlock, LoadingRow } from "../../../components/States";
import { AllowlistEditor } from "../../../components/AllowlistEditor";
import { SessionPolicyEditor } from "../../../components/SessionPolicyEditor";
import { AutoJoinEditor } from "../../../components/AutoJoinEditor";
import { SsoEditor } from "../../../components/SsoEditor";
import { ScimEditor } from "../../../components/ScimEditor";
import { PlanEditor } from "../../../components/PlanEditor";
import { WorkspaceDataControls } from "../../../components/WorkspaceDataControls";
import { fmtTs } from "../../../lib/format";

type Role = "owner" | "editor" | "viewer";

interface Member {
  userId: string;
  email: string;
  role: Role;
  joinedAt: number;
}
interface Workspace {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  createdBy: string;
  members: Member[];
  myRole: Role | null;
}
interface Invite {
  id: string;
  email: string;
  role: "editor" | "viewer";
  createdAt: number;
  expiresAt: number;
  status: "pending" | "accepted" | "revoked" | "expired";
}

const roleIcon = (r: Role) =>
  r === "owner" ? <Crown weight="duotone" size={12} /> :
  r === "editor" ? <PencilSimple weight="duotone" size={12} /> :
  <Eye weight="duotone" size={12} />;

export default function WorkspaceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("viewer");
  const [inviting, setInviting] = useState(false);
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${id}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setWs(j.workspace);
      // Invites are visible to owner/editor only.
      if (j.workspace.myRole === "owner" || j.workspace.myRole === "editor") {
        const ri = await fetch(`/api/workspaces/${id}/invites`, { cache: "no-store" });
        if (ri.ok) {
          const ji = await ri.json();
          setInvites(ji.items || []);
        }
      } else {
        setInvites([]);
      }
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setStatus("error");
    }
  }, [id]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function submitInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim() || inviting) return;
    setInviting(true);
    setError(null);
    setLastUrl(null);
    setCopied(false);
    try {
      const r = await fetch(`/api/workspaces/${id}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setLastUrl(j.url);
      setInviteEmail("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "invite failed");
    } finally {
      setInviting(false);
    }
  }

  async function copyLink() {
    if (!lastUrl) return;
    try {
      await navigator.clipboard.writeText(lastUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }

  async function changeRole(userId: string, role: Role) {
    const r = await fetch(`/api/workspaces/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member: { userId, role } }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setError(j?.error || `HTTP ${r.status}`);
      return;
    }
    await refresh();
  }

  async function transferOwnership(toUserId: string, toEmail: string) {
    const confirmText = `Transfer ownership to ${toEmail}? You will be demoted to editor. This cannot be undone without their cooperation.`;
    if (!confirm(confirmText)) return;
    const r = await fetch(`/api/workspaces/${id}/transfer-ownership`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toUserId }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      if (r.status === 401 && j?.error === "mfa_required") {
        setError("MFA required. Verify your code in Settings then try again.");
        return;
      }
      setError(j?.error || `HTTP ${r.status}`);
      return;
    }
    await refresh();
  }

  async function removeMember(userId: string) {
    if (!confirm("Remove this member from the workspace?")) return;
    const r = await fetch(`/api/workspaces/${id}?userId=${encodeURIComponent(userId)}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setError(j?.error || `HTTP ${r.status}`);
      return;
    }
    await refresh();
  }

  async function leaveWorkspace() {
    if (!confirm("Leave this workspace?")) return;
    const r = await fetch(`/api/workspaces/${id}`, { method: "DELETE" });
    if (r.ok) window.location.href = "/workspaces";
    else {
      const j = await r.json().catch(() => ({}));
      setError(j?.error || `HTTP ${r.status}`);
    }
  }

  async function revokeInvite(inviteId: string) {
    const r = await fetch(`/api/workspaces/${id}/invites/${inviteId}`, { method: "DELETE" });
    if (r.ok) await refresh();
  }

  if (status === "loading") return <div><LoadingRow rows={4} /></div>;
  if (status === "error") return <ErrorBlock message={error || "failed"} />;
  if (!ws) return <ErrorBlock message="not found" />;

  const canManage = ws.myRole === "owner";
  const canInvite = ws.myRole === "owner" || ws.myRole === "editor";
  const pendingInvites = invites.filter(i => i.status === "pending");

  return (
    <div>
      <Link href="/workspaces" className="inline-flex items-center gap-1 mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] mb-4">
        <ArrowLeft weight="duotone" size={12} /> all workspaces
      </Link>
      <H1 eyebrow="workspace">{ws.name}</H1>
      <div className="mono text-[11px] text-[var(--color-ink-4)] mb-6">
        {ws.members.length} member{ws.members.length === 1 ? "" : "s"} · created {fmtTs(ws.createdAt)}
        {ws.myRole && <> · you are <span className="text-[var(--color-ink-2)]">{ws.myRole}</span></>}
      </div>

      {error && <div className="mb-4"><ErrorBlock message={error} /></div>}

      {canInvite && (
        <section className="ruled rounded-md p-4 mb-6 bg-[var(--color-paper-2)]">
          <div className="flex items-center gap-2 mb-3">
            <PaperPlaneTilt weight="duotone" size={16} className="text-[var(--color-ink-3)]" />
            <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">invite teammate</div>
          </div>
          <form onSubmit={submitInvite} className="flex flex-wrap items-end gap-2">
            <label className="flex-1 min-w-[220px]">
              <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] block mb-1">email</span>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@company.com"
                className="w-full px-2.5 h-9 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[14px] outline-none focus:border-[var(--color-ink-3)]"
              />
            </label>
            <label>
              <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] block mb-1">role</span>
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as "editor" | "viewer")}
                className="px-2.5 h-9 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] text-[14px] outline-none focus:border-[var(--color-ink-3)]"
              >
                <option value="viewer">viewer</option>
                <option value="editor">editor</option>
              </select>
            </label>
            <button type="submit" disabled={!inviteEmail.trim() || inviting}
              className="inline-flex items-center gap-1.5 px-3 h-9 rounded bg-[var(--color-ink-1)] text-[var(--color-paper)] text-[13px] disabled:opacity-50">
              <EnvelopeSimple weight="duotone" size={14} />
              {inviting ? "sending" : "send invite"}
            </button>
          </form>
          {lastUrl && (
            <div className="mt-3 p-2.5 rounded border border-[var(--color-rule)] bg-[var(--color-paper)]">
              <div className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] mb-1">invite link (share securely)</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 mono text-[11.5px] text-[var(--color-ink-2)] truncate">{lastUrl}</code>
                <button onClick={copyLink} type="button" className="inline-flex items-center gap-1 px-2 h-7 rounded border border-[var(--color-rule)] text-[12px]">
                  {copied ? <><CheckCircle weight="duotone" size={12} /> copied</> : <><Copy weight="duotone" size={12} /> copy</>}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="mb-6">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] mb-2">members</div>
        <div className="ruled rounded-md overflow-hidden">
          {ws.members.map((m, i) => (
            <div key={m.userId} className={`px-4 py-3 flex items-center gap-3 ${i > 0 ? "border-t border-[var(--color-rule)]" : ""}`}>
              <UsersThree weight="duotone" size={16} className="text-[var(--color-ink-3)] shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] truncate">{m.email}</div>
                <div className="mono text-[10.5px] text-[var(--color-ink-4)]">joined {fmtTs(m.joinedAt)}</div>
              </div>
              {canManage && m.role !== "owner" ? (
                <select
                  value={m.role}
                  onChange={(e) => changeRole(m.userId, e.target.value as Role)}
                  className="px-2 h-7 rounded border border-[var(--color-rule)] bg-[var(--color-paper)] mono text-[11px]"
                >
                  <option value="viewer">viewer</option>
                  <option value="editor">editor</option>
                  <option value="owner">owner</option>
                </select>
              ) : (
                <span className="mono text-[10px] uppercase tracking-[0.14em] inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-3)]">
                  {roleIcon(m.role)} {m.role}
                </span>
              )}
              {canManage && m.role !== "owner" && (
                <button onClick={() => transferOwnership(m.userId, m.email)} type="button"
                  className="p-1.5 rounded hover:bg-[var(--color-paper-2)] text-[var(--color-ink-3)]" aria-label="transfer ownership" title="Transfer ownership">
                  <CrownSimple weight="duotone" size={14} />
                </button>
              )}
              {canManage && m.role !== "owner" && (
                <button onClick={() => removeMember(m.userId)} type="button"
                  className="p-1.5 rounded hover:bg-[var(--color-paper-2)] text-[var(--color-ink-3)]" aria-label="remove member">
                  <Trash weight="duotone" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      {canInvite && pendingInvites.length > 0 && (
        <section className="mb-6">
          <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] mb-2">
            pending invites ({pendingInvites.length})
          </div>
          <div className="ruled rounded-md overflow-hidden">
            {pendingInvites.map((inv, i) => (
              <div key={inv.id} className={`px-4 py-3 flex items-center gap-3 ${i > 0 ? "border-t border-[var(--color-rule)]" : ""}`}>
                <EnvelopeSimple weight="duotone" size={16} className="text-[var(--color-ink-3)] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] truncate">{inv.email}</div>
                  <div className="mono text-[10.5px] text-[var(--color-ink-4)]">
                    {inv.role} · expires {fmtTs(inv.expiresAt)}
                  </div>
                </div>
                <button onClick={() => revokeInvite(inv.id)} type="button"
                  className="inline-flex items-center gap-1 px-2 h-7 rounded border border-[var(--color-rule)] text-[12px] text-[var(--color-ink-3)]">
                  <Trash weight="duotone" size={12} /> revoke
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {ws.myRole && (
        <PlanEditor workspaceId={ws.id} />
      )}

      {ws.myRole && (
        <AllowlistEditor workspaceId={ws.id} />
      )}

      {ws.myRole && (
        <SessionPolicyEditor workspaceId={ws.id} />
      )}

      {ws.myRole && (
        <SsoEditor workspaceId={ws.id} />
      )}

      {ws.myRole && (
        <ScimEditor workspaceId={ws.id} />
      )}

      {ws.myRole && (
        <AutoJoinEditor workspaceId={ws.id} />
      )}

      {ws.myRole && (
        <WorkspaceDataControls
          workspaceId={ws.id}
          workspaceSlug={ws.slug}
          workspaceName={ws.name}
          isOwner={ws.myRole === "owner"}
        />
      )}

      {ws.myRole && ws.myRole !== "owner" && (
        <button onClick={leaveWorkspace} type="button"
          className="inline-flex items-center gap-1.5 px-3 h-8 rounded border border-[var(--color-rule)] text-[13px] text-[var(--color-ink-3)] hover:bg-[var(--color-paper-2)]">
          <SignOut weight="duotone" size={14} /> leave workspace
        </button>
      )}
    </div>
  );
}
