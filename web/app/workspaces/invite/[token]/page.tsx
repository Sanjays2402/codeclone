"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { UsersThree, ArrowRight, Warning, CheckCircle } from "@phosphor-icons/react/dist/ssr";
import { H1 } from "../../../../components/Headings";

interface Preview {
  workspace: { id: string; name: string };
  invite: { email: string; role: "editor" | "viewer"; expiresAt: number };
  viewer: { id: string; email: string } | null;
  emailMatches: boolean | null;
}

export default function InviteAcceptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [state, setState] = useState<"loading" | "ready" | "invalid" | "accepted" | "error">("loading");
  const [data, setData] = useState<Preview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/workspaces/invites/${token}`, { cache: "no-store" });
        if (!alive) return;
        if (r.status === 404) { setState("invalid"); return; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        setData(j);
        setState("ready");
      } catch (e) {
        if (!alive) return;
        setMessage(e instanceof Error ? e.message : "failed");
        setState("error");
      }
    })();
    return () => { alive = false; };
  }, [token]);

  async function accept() {
    if (!data) return;
    setAccepting(true);
    setMessage(null);
    try {
      const r = await fetch(`/api/workspaces/invites/${token}`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setState("accepted");
      setTimeout(() => { window.location.href = `/workspaces/${j.workspaceId}`; }, 600);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "failed");
    } finally {
      setAccepting(false);
    }
  }

  if (state === "loading") {
    return <div className="mono text-[11px] text-[var(--color-ink-3)]">loading invite…</div>;
  }
  if (state === "invalid") {
    return (
      <div className="max-w-[520px]">
        <H1 eyebrow="invite">link not valid</H1>
        <p className="text-[14px] text-[var(--color-ink-3)] mt-2">
          This invite has expired, was already used, or never existed. Ask the workspace owner for a fresh one.
        </p>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="max-w-[520px]">
        <H1 eyebrow="invite">something went wrong</H1>
        <p className="text-[14px] text-red-500 mt-2">{message}</p>
      </div>
    );
  }
  if (!data) return null;

  const needsSignIn = !data.viewer;
  const wrongEmail = data.viewer && !data.emailMatches;

  return (
    <div className="max-w-[520px]">
      <H1 eyebrow="invite">join {data.workspace.name}</H1>
      <p className="text-[14px] text-[var(--color-ink-3)] mt-2 mb-6">
        You were invited to join as <span className="text-[var(--color-ink-2)]">{data.invite.role}</span>.
        Workspace members can run comparisons and see shared history.
      </p>

      <div className="ruled rounded-md p-4 mb-4">
        <div className="flex items-center gap-3">
          <UsersThree weight="duotone" size={20} className="text-[var(--color-ink-3)]" />
          <div className="flex-1">
            <div className="text-[15px] font-medium">{data.workspace.name}</div>
            <div className="mono text-[11px] text-[var(--color-ink-4)] mt-0.5">
              invited as {data.invite.email}
            </div>
          </div>
        </div>
      </div>

      {needsSignIn && (
        <Link href={`/signin?redirect=${encodeURIComponent(`/workspaces/invite/${token}`)}`}
          className="inline-flex items-center gap-1.5 px-3 h-9 rounded bg-[var(--color-ink-1)] text-[var(--color-paper)] text-[13px]">
          sign in to accept <ArrowRight weight="duotone" size={14} />
        </Link>
      )}

      {wrongEmail && (
        <div className="ruled rounded-md p-3 mb-3 flex items-start gap-2 bg-[var(--color-paper-2)]">
          <Warning weight="duotone" size={16} className="text-[var(--color-ink-3)] shrink-0 mt-0.5" />
          <div className="text-[13px] text-[var(--color-ink-2)]">
            This invite is for <span className="mono">{data.invite.email}</span> but you are signed in
            as <span className="mono">{data.viewer!.email}</span>. Sign out and back in with the
            invited address.
          </div>
        </div>
      )}

      {data.viewer && data.emailMatches && state !== "accepted" && (
        <button onClick={accept} disabled={accepting} type="button"
          className="inline-flex items-center gap-1.5 px-3 h-9 rounded bg-[var(--color-ink-1)] text-[var(--color-paper)] text-[13px] disabled:opacity-50">
          {accepting ? "joining…" : <>accept invite <ArrowRight weight="duotone" size={14} /></>}
        </button>
      )}

      {state === "accepted" && (
        <div className="flex items-center gap-2 text-[13px] text-[var(--color-ink-2)]">
          <CheckCircle weight="duotone" size={16} /> joined. redirecting…
        </div>
      )}

      {message && state !== "accepted" && (
        <div className="mt-3 text-[12px] text-red-500">{message}</div>
      )}
    </div>
  );
}
