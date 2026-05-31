"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, FloppyDisk, Warning, Trash } from "@phosphor-icons/react/dist/ssr";

type Mode = "off" | "warn" | "redact" | "block";

interface PolicyResponse {
  policy: {
    mode: Mode;
    updatedAt: number | null;
    updatedBy: string | null;
  };
  canEdit: boolean;
  modes: readonly Mode[];
  rules: Array<{ id: string; label: string }>;
}

interface Props {
  workspaceId: string;
}

const MODE_BLURB: Record<Mode, string> = {
  off: "no scanning. snippets pass through untouched.",
  warn: "scan and report findings on the response, do not alter the snippet.",
  redact: "replace each match with [REDACTED:<rule>] before similarity scoring.",
  block: "reject the request with HTTP 422 and never persist the snippet.",
};

/**
 * Workspace secret-scan DLP policy editor.
 *
 * Owners pick the strictness with which inbound code snippets are
 * scrubbed for credentials before similarity work runs. Enforcement is
 * wired into /api/compare, /v1/compare, and /v1/batch so a tightened
 * policy takes effect on the next request without any client change.
 */
export function SecretScanPolicyEditor({ workspaceId }: Props) {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("off");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/secret-scan-policy`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as PolicyResponse;
      setData(j);
      setMode(j.policy.mode);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    if (!data?.canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/secret-scan-policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error?.message || j?.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { policy: PolicyResponse["policy"] };
      setData((d) => (d ? { ...d, policy: j.policy } : d));
      setMode(j.policy.mode);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [data?.canEdit, mode, workspaceId]);

  const clear = useCallback(async () => {
    if (!data?.canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/secret-scan-policy`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { policy: PolicyResponse["policy"] };
      setData((d) => (d ? { ...d, policy: j.policy } : d));
      setMode("off");
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [data?.canEdit, workspaceId]);

  const dirty = data ? mode !== data.policy.mode : false;

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] flex items-center gap-1.5">
          <ShieldCheck weight="duotone" size={14} /> secret scan (dlp)
        </div>
        {savedFlash && (
          <span className="mono text-[10.5px] text-[var(--color-ink-4)]">saved</span>
        )}
      </div>

      <div className="ruled rounded-md p-4">
        <p className="text-[12.5px] text-[var(--color-ink-3)] mb-3 leading-relaxed">
          Scan every snippet submitted to compare and batch for hardcoded
          credentials (AWS keys, GitHub tokens, Stripe keys, JWTs, PEM
          private keys, and more) before similarity work runs. Blocked
          requests return HTTP 422 with the matched rule ids; redacted
          ones are scored against a [REDACTED] marker so the similarity
          number reflects what would have been shared.
        </p>

        {status === "loading" && (
          <div className="mono text-[11px] text-[var(--color-ink-4)]" role="status">loading...</div>
        )}

        {status === "error" && (
          <div className="text-[12.5px] text-red-600 mb-2 flex items-center gap-1.5" role="alert">
            <Warning weight="duotone" size={14} /> {error}
          </div>
        )}

        {status === "ready" && data && (
          <>
            <fieldset className="mb-3" disabled={!data.canEdit || saving}>
              <legend className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] mb-2">
                mode
              </legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {data.modes.map((m) => (
                  <label
                    key={m}
                    className={`flex items-start gap-2 rounded border px-3 py-2 cursor-pointer text-[12.5px] ${
                      mode === m
                        ? "border-[var(--color-ink-3)] bg-[var(--color-paper-2)]"
                        : "border-[var(--color-rule)] hover:bg-[var(--color-paper-2)]"
                    }`}
                  >
                    <input
                      type="radio"
                      name="secret-scan-mode"
                      value={m}
                      checked={mode === m}
                      onChange={() => setMode(m)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="mono text-[11px] uppercase tracking-[0.12em]">{m}</span>
                      <span className="block text-[11.5px] text-[var(--color-ink-3)] leading-snug mt-0.5">
                        {MODE_BLURB[m]}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {data.policy.mode !== "off" && (
              <div className="mono text-[10.5px] text-[var(--color-ink-4)] mb-3">
                in force: <span className="text-[var(--color-ink-2)]">{data.policy.mode}</span>
              </div>
            )}

            <details className="mb-3">
              <summary className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] cursor-pointer">
                coverage ({data.rules.length} rules)
              </summary>
              <ul className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[11.5px] text-[var(--color-ink-3)]">
                {data.rules.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2">
                    <span>{r.label}</span>
                    <code className="mono text-[10.5px] text-[var(--color-ink-4)]">{r.id}</code>
                  </li>
                ))}
              </ul>
            </details>

            {data.canEdit ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || !dirty}
                  className="inline-flex items-center gap-1.5 px-3 h-9 rounded border border-[var(--color-rule)] text-[13px] disabled:opacity-50 hover:bg-[var(--color-paper-2)]"
                >
                  <FloppyDisk weight="duotone" size={14} /> save policy
                </button>
                <button
                  type="button"
                  onClick={clear}
                  disabled={saving || (mode === "off" && !data.policy.updatedAt)}
                  className="inline-flex items-center gap-1.5 px-3 h-9 rounded border border-[var(--color-rule)] text-[13px] text-[var(--color-ink-3)] disabled:opacity-50 hover:bg-[var(--color-paper-2)]"
                >
                  <Trash weight="duotone" size={14} /> remove policy
                </button>
              </div>
            ) : (
              <div className="mono text-[11px] text-[var(--color-ink-4)]">
                only workspace owners can edit the secret scan policy.
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
