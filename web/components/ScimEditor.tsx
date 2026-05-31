"use client";

import { useCallback, useEffect, useState } from "react";
import { UsersFour, Copy, ArrowsClockwise, Trash, Warning, CheckCircle } from "@phosphor-icons/react/dist/ssr";

interface ScimMeta {
  prefix: string;
  createdAt: number;
  lastUsedAt?: number;
  rotatedAt?: number;
}

interface ScimStatus {
  enabled: boolean;
  canEdit: boolean;
  token: ScimMeta | null;
  provisionedUserCount: number;
  endpoint: string;
}

/**
 * SCIM 2.0 provisioning editor.
 *
 * Workspace owners can issue a per-workspace bearer token that an IdP
 * (Okta, Azure AD, JumpCloud, ...) uses to push users into this
 * workspace via /scim/v2/<id>/Users. The plaintext token is shown
 * exactly once at issue and rotate; we never send it back on read.
 *
 * Members who are not owners see a read-only summary so they know how
 * provisioning is wired without being able to mint or revoke tokens.
 */
export function ScimEditor({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<ScimStatus | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/scim`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as ScimStatus;
      setData(j);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const act = useCallback(async (action: "issue" | "rotate" | "revoke") => {
    setBusy(true);
    setError(null);
    setSecret(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/scim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
      if (typeof (j as { token?: string }).token === "string") {
        setSecret((j as { token: string }).token);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setConfirmRotate(false);
      setConfirmRevoke(false);
    }
  }, [workspaceId, load]);

  const copy = useCallback(async (txt: string) => {
    try {
      await navigator.clipboard.writeText(txt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }, []);

  if (status === "loading") {
    return (
      <section className="ruled rounded-md p-4 mb-6 bg-[var(--color-paper-2)]">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] mb-2">scim provisioning</div>
        <div className="h-5 w-40 rounded bg-[var(--color-rule)] animate-pulse" />
      </section>
    );
  }
  if (status === "error" || !data) {
    return (
      <section className="ruled rounded-md p-4 mb-6 bg-[var(--color-paper-2)]">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] mb-2">scim provisioning</div>
        <div className="text-[13px] text-red-600 flex items-center gap-1.5">
          <Warning weight="duotone" size={14} /> {error ?? "failed to load"}
        </div>
      </section>
    );
  }

  const endpointAbs = typeof window !== "undefined" ? `${window.location.origin}${data.endpoint}` : data.endpoint;

  return (
    <section className="ruled rounded-md p-4 mb-6 bg-[var(--color-paper-2)]">
      <div className="flex items-center gap-2 mb-3">
        <UsersFour weight="duotone" size={16} className="text-[var(--color-ink-3)]" />
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">scim provisioning</div>
      </div>

      <p className="text-[13px] text-[var(--color-ink-2)] mb-3 max-w-prose">
        Push users from your identity provider (Okta, Azure AD, JumpCloud) using SCIM 2.0. Bearer token is bound to this workspace only and never replays elsewhere.
      </p>

      <div className="grid gap-3 text-[13px] mb-3">
        <Row label="endpoint">
          <code className="mono text-[12px] break-all">{endpointAbs}</code>
          <button onClick={() => copy(endpointAbs)} type="button"
            className="ml-2 inline-flex items-center gap-1 px-2 h-6 rounded border border-[var(--color-rule)] text-[11.5px] text-[var(--color-ink-3)]">
            <Copy weight="duotone" size={11} /> copy
          </button>
        </Row>
        <Row label="status">
          {data.enabled ? (
            <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle weight="duotone" size={13} /> enabled</span>
          ) : (
            <span className="text-[var(--color-ink-3)]">not configured</span>
          )}
        </Row>
        {data.token && (
          <>
            <Row label="token prefix">
              <code className="mono text-[12px]">{data.token.prefix}…</code>
            </Row>
            <Row label="created">
              <span className="mono text-[12px] text-[var(--color-ink-3)]">{fmt(data.token.createdAt)}</span>
            </Row>
            <Row label="last used">
              <span className="mono text-[12px] text-[var(--color-ink-3)]">{data.token.lastUsedAt ? fmt(data.token.lastUsedAt) : "never"}</span>
            </Row>
            <Row label="provisioned users">
              <span className="mono text-[12px]">{data.provisionedUserCount}</span>
            </Row>
          </>
        )}
      </div>

      {secret && (
        <div className="rounded-md border border-amber-500/40 bg-amber-50 dark:bg-amber-950/20 p-3 mb-3">
          <div className="mono text-[11px] uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300 mb-1">copy now, shown once</div>
          <div className="flex items-start gap-2">
            <code className="mono text-[12.5px] break-all flex-1">{secret}</code>
            <button onClick={() => copy(secret)} type="button"
              className="inline-flex items-center gap-1 px-2 h-7 rounded border border-amber-600/40 text-[12px] text-amber-800 dark:text-amber-200">
              <Copy weight="duotone" size={12} /> {copied ? "copied" : "copy"}
            </button>
          </div>
        </div>
      )}

      {data.canEdit && (
        <div className="flex flex-wrap gap-2">
          {!data.enabled && (
            <button onClick={() => act("issue")} disabled={busy} type="button"
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded border border-[var(--color-ink-1)] bg-[var(--color-ink-1)] text-[var(--color-paper-1)] text-[13px] disabled:opacity-50">
              {busy ? "issuing…" : "issue token"}
            </button>
          )}
          {data.enabled && !confirmRotate && (
            <button onClick={() => setConfirmRotate(true)} disabled={busy} type="button"
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded border border-[var(--color-rule)] text-[13px] text-[var(--color-ink-2)]">
              <ArrowsClockwise weight="duotone" size={13} /> rotate
            </button>
          )}
          {data.enabled && confirmRotate && (
            <>
              <span className="text-[12.5px] text-[var(--color-ink-3)] self-center">old token invalidates immediately</span>
              <button onClick={() => act("rotate")} disabled={busy} type="button"
                className="inline-flex items-center gap-1.5 px-3 h-8 rounded border border-amber-600 bg-amber-600 text-white text-[13px] disabled:opacity-50">
                confirm rotate
              </button>
              <button onClick={() => setConfirmRotate(false)} type="button"
                className="inline-flex items-center gap-1.5 px-3 h-8 rounded border border-[var(--color-rule)] text-[13px] text-[var(--color-ink-3)]">
                cancel
              </button>
            </>
          )}
          {data.enabled && !confirmRevoke && (
            <button onClick={() => setConfirmRevoke(true)} disabled={busy} type="button"
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded border border-[var(--color-rule)] text-[13px] text-red-600">
              <Trash weight="duotone" size={13} /> revoke
            </button>
          )}
          {data.enabled && confirmRevoke && (
            <>
              <span className="text-[12.5px] text-red-600 self-center">IdP syncs will fail until reissued</span>
              <button onClick={() => act("revoke")} disabled={busy} type="button"
                className="inline-flex items-center gap-1.5 px-3 h-8 rounded border border-red-600 bg-red-600 text-white text-[13px] disabled:opacity-50">
                confirm revoke
              </button>
              <button onClick={() => setConfirmRevoke(false)} type="button"
                className="inline-flex items-center gap-1.5 px-3 h-8 rounded border border-[var(--color-rule)] text-[13px] text-[var(--color-ink-3)]">
                cancel
              </button>
            </>
          )}
        </div>
      )}

      {!data.canEdit && (
        <div className="text-[12.5px] text-[var(--color-ink-3)]">Only the workspace owner can issue or revoke SCIM tokens.</div>
      )}

      {error && (
        <div className="mt-3 text-[12.5px] text-red-600 flex items-center gap-1.5">
          <Warning weight="duotone" size={13} /> {error}
        </div>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] w-32 shrink-0">{label}</div>
      <div className="min-w-0 flex items-center flex-wrap gap-1">{children}</div>
    </div>
  );
}

function fmt(ms: number): string {
  if (!ms) return "—";
  try { return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC"; }
  catch { return String(ms); }
}
