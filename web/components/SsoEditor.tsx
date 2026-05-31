"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Warning, Trash, CheckCircle, Copy } from "@phosphor-icons/react/dist/ssr";

interface SsoConfig {
  provider: "oidc";
  issuer: string;
  clientId: string;
  clientSecretSet: boolean;
  allowedDomain: string;
  enforced: boolean;
  updatedAt: number;
  updatedBy: string;
}

interface SsoResponse {
  sso: SsoConfig | null;
  canEdit: boolean;
  startUrl: string | null;
  callbackUrl: string;
}

interface Props { workspaceId: string }

/**
 * Workspace OIDC SSO editor.
 *
 * Owners wire one OIDC provider (issuer + clientId + clientSecret) and
 * pin an allowed email domain. When `enforced` is on, magic-link sign-in
 * is blocked for that domain and users are routed through the provider.
 * The callback URL is shown so admins can copy it into their IdP.
 *
 * Members without manage rights see a read-only view (no secret state
 * is ever exposed; only whether one is set).
 */
export function SsoEditor({ workspaceId }: Props) {
  const [data, setData] = useState<SsoResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [allowedDomain, setAllowedDomain] = useState("");
  const [enforced, setEnforced] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/sso`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const json: SsoResponse = await res.json();
      setData(json);
      if (json.sso) {
        setIssuer(json.sso.issuer);
        setClientId(json.sso.clientId);
        setAllowedDomain(json.sso.allowedDomain);
        setEnforced(json.sso.enforced);
        setClientSecret("");
      }
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setErr(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/sso`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ issuer, clientId, clientSecret: clientSecret || undefined, allowedDomain, enforced }),
      });
      const json = await res.json();
      if (!res.ok) { setErr(json?.error || "save_failed"); return; }
      await load();
    } catch { setErr("network_error"); }
    finally { setSaving(false); }
  }

  async function disable() {
    if (!confirm("Disable single sign-on for this workspace? Members will fall back to magic links.")) return;
    setSaving(true);
    try {
      await fetch(`/api/workspaces/${workspaceId}/sso`, { method: "DELETE" });
      await load();
    } finally { setSaving(false); }
  }

  async function copyCallback() {
    if (!data?.callbackUrl) return;
    try { await navigator.clipboard.writeText(data.callbackUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* ignore */ }
  }

  if (status === "loading") {
    return <div className="rounded-md border border-[var(--color-rule)] bg-[var(--color-paper-2)] p-4 text-[12.5px] text-[var(--color-ink-3)]">Loading SSO settings...</div>;
  }
  if (status === "error" || !data) {
    return (
      <div className="rounded-md border border-[var(--color-rule)] bg-[var(--color-paper-3)] p-4 flex items-start gap-2 text-[12.5px] text-[var(--color-ink-2)]">
        <Warning size={16} weight="duotone" className="mt-0.5 text-amber-600" />
        <span>Could not load SSO settings.</span>
      </div>
    );
  }

  const readOnly = !data.canEdit;

  return (
    <section className="rounded-md border border-[var(--color-rule)] bg-[var(--color-paper-2)] p-4 sm:p-5 space-y-4">
      <header className="flex items-start gap-3">
        <ShieldCheck size={20} weight="duotone" className="text-[var(--color-ink-2)] shrink-0 mt-0.5" />
        <div className="min-w-0">
          <h3 className="text-[14px] font-medium tracking-tight">Single sign-on (OIDC)</h3>
          <p className="text-[12.5px] text-[var(--color-ink-3)] leading-relaxed mt-0.5">
            Wire one OIDC provider (Google Workspace, Okta, Azure AD, Auth0). When enforced, magic-link sign-in is blocked for the configured email domain.
          </p>
        </div>
      </header>

      <div className="rounded-md border border-dashed border-[var(--color-rule)] p-3 bg-[var(--color-paper)]">
        <div className="mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-4)] mb-1.5">redirect uri</div>
        <div className="flex items-center gap-2">
          <code className="mono text-[11.5px] break-all text-[var(--color-ink-2)] flex-1">{data.callbackUrl}</code>
          <button type="button" onClick={copyCallback} className="shrink-0 inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]">
            {copied ? <><CheckCircle size={12} weight="duotone" /> copied</> : <><Copy size={12} weight="duotone" /> copy</>}
          </button>
        </div>
      </div>

      <form onSubmit={save} className="space-y-3">
        <Field label="Issuer URL" hint="e.g. https://accounts.google.com or https://login.microsoftonline.com/<tenant>/v2.0">
          <input type="url" required disabled={readOnly || saving} value={issuer} onChange={(e) => setIssuer(e.target.value)}
            placeholder="https://accounts.google.com"
            className="w-full h-10 px-3 rounded-md bg-[var(--color-paper)] border border-[var(--color-rule)] text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--color-ink)]/15" />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Client ID">
            <input type="text" required disabled={readOnly || saving} value={clientId} onChange={(e) => setClientId(e.target.value)}
              className="w-full h-10 px-3 rounded-md bg-[var(--color-paper)] border border-[var(--color-rule)] text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--color-ink)]/15" />
          </Field>
          <Field label="Allowed email domain" hint="Only users from this domain may sign in via SSO.">
            <input type="text" required disabled={readOnly || saving} value={allowedDomain} onChange={(e) => setAllowedDomain(e.target.value.toLowerCase())}
              placeholder="acme.com"
              className="w-full h-10 px-3 rounded-md bg-[var(--color-paper)] border border-[var(--color-rule)] text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--color-ink)]/15" />
          </Field>
        </div>
        <Field label={data.sso?.clientSecretSet ? "Client secret (leave blank to keep current)" : "Client secret"}>
          <input type="password" disabled={readOnly || saving} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)}
            required={!data.sso?.clientSecretSet}
            autoComplete="off"
            placeholder={data.sso?.clientSecretSet ? "•••••••• (unchanged)" : ""}
            className="w-full h-10 px-3 rounded-md bg-[var(--color-paper)] border border-[var(--color-rule)] text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--color-ink)]/15" />
        </Field>

        <label className="flex items-start gap-2.5 cursor-pointer select-none pt-1">
          <input type="checkbox" disabled={readOnly || saving} checked={enforced} onChange={(e) => setEnforced(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--color-ink)]" />
          <span className="text-[12.5px] text-[var(--color-ink-2)] leading-relaxed">
            Require SSO for <code className="mono text-[11.5px]">@{allowedDomain || "domain"}</code> users. Magic-link sign-in will be refused.
          </span>
        </label>

        {err ? (
          <div className="flex items-start gap-2 text-[12px] text-[var(--color-ink-2)] bg-[var(--color-paper-3)] border border-[var(--color-rule)] rounded-md p-2.5">
            <Warning size={14} weight="duotone" className="mt-0.5 shrink-0 text-amber-600" />
            <span className="mono">{err}</span>
          </div>
        ) : null}

        {!readOnly ? (
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="submit" disabled={saving}
              className="inline-flex items-center justify-center h-9 px-3.5 rounded-md bg-[var(--color-ink)] text-[var(--color-paper)] text-[12.5px] font-medium disabled:opacity-50">
              {saving ? "Saving..." : data.sso ? "Update SSO" : "Enable SSO"}
            </button>
            {data.sso ? (
              <button type="button" onClick={disable} disabled={saving}
                className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md border border-[var(--color-rule)] bg-[var(--color-paper)] text-[12.5px] text-[var(--color-ink-2)] hover:bg-[var(--color-paper-3)] disabled:opacity-50">
                <Trash size={13} weight="duotone" /> Disable
              </button>
            ) : null}
          </div>
        ) : (
          <p className="text-[11.5px] text-[var(--color-ink-4)] pt-1">Only the workspace owner can edit SSO settings.</p>
        )}
      </form>

      {data.sso && data.startUrl ? (
        <div className="rounded-md border border-[var(--color-rule)] p-3 bg-[var(--color-paper)] text-[12px] text-[var(--color-ink-3)]">
          Sign-in URL: <a className="mono text-[11.5px] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] underline-offset-4 hover:underline" href={data.startUrl}>{data.startUrl}</a>
        </div>
      ) : null}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-ink-4)]">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint ? <span className="block text-[11px] text-[var(--color-ink-4)] mt-1 leading-snug">{hint}</span> : null}
    </label>
  );
}
