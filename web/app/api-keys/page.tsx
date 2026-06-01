"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Key,
  Copy,
  Check,
  Trash,
  Plus,
  Warning,
  Terminal,
  Eye,
  ArrowsClockwise,
  Gauge,
  ShieldCheck,
  Globe,
  CaretDown,
  CaretRight,
} from "@phosphor-icons/react/dist/ssr";
import { H1, H2 } from "../../components/Headings";
import { Empty, ErrorBlock, LoadingRow } from "../../components/States";
import { fmtInt, fmtTs } from "../../lib/format";

interface ApiKeySummary {
  id: string;
  label: string;
  prefix: string;
  createdAt: number;
  lastUsedAt?: number;
  usageCount: number;
  revoked?: boolean;
  expiresAt?: number;
  expired?: boolean;
  scopes?: string[];
  rateLimit?: { rpm: number };
  ipAllowlist?: string[];
}

const ALL_SCOPES = [
  { id: "compare:write", label: "compare", desc: "POST /v1/compare" },
  { id: "batch:write", label: "batch", desc: "POST /v1/batch" },
  { id: "shares:read", label: "shares", desc: "GET /v1/shares" },
  { id: "shares:write", label: "shares delete", desc: "DELETE /v1/shares/:id" },
  { id: "usage:read", label: "usage", desc: "GET /v1/usage" },
  { id: "audit:read", label: "audit", desc: "GET /v1/audit (SIEM stream)" },
  { id: "webhooks:read", label: "webhooks", desc: "GET /v1/webhooks" },
  { id: "webhooks:write", label: "webhooks manage", desc: "POST + DELETE /v1/webhooks" },
] as const;

type Status = "loading" | "ready" | "error" | "signedout";

const CURL_EXAMPLE = (token: string) =>
  `curl -X POST http://localhost:3000/v1/compare \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "a": "def add(a,b):\\n    return a+b\\n",
    "b": "def sum(x,y):\\n    return x+y\\n",
    "language": "python"
  }'`;

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard blocked; users can select manually
    }
  }, [text]);
  return (
    <button
      type="button"
      onClick={onCopy}
      className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)]"
    >
      {copied ? <Check size={12} weight="bold" /> : <Copy size={12} weight="duotone" />}
      {copied ? "Copied" : label}
    </button>
  );
}

export default function ApiKeysPage() {
  const [items, setItems] = useState<ApiKeySummary[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<string>("");
  const [scopes, setScopes] = useState<string[]>(["compare:write", "batch:write"]);
  const [rpm, setRpm] = useState<string>("");
  const [ipAllowlist, setIpAllowlist] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [reveal, setReveal] = useState<{ id: string; plaintext: string } | null>(null);
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/api-keys", { cache: "no-store" });
      if (res.status === 401) {
        setStatus("signedout");
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error?.message ?? j.error ?? `Request failed (${res.status}).`);
      }
      const j = (await res.json()) as { items: ApiKeySummary[] };
      setItems(j.items ?? []);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onCreate = useCallback(async () => {
    setCreating(true);
    setError("");
    try {
      const expRaw = expiresInDays.trim();
      const expNum = expRaw ? Number(expRaw) : undefined;
      if (expRaw && (!Number.isFinite(expNum) || (expNum as number) <= 0 || (expNum as number) > 365)) {
        throw new Error("Expiry must be 1 to 365 days, or blank for never.");
      }
      const cidrs = ipAllowlist
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: label.trim() || "Untitled key",
          ...(expNum ? { expiresInDays: expNum } : {}),
          scopes,
          ...(rpm.trim() ? { rpm: Number(rpm.trim()) } : {}),
          ...(cidrs.length > 0 ? { ipAllowlist: cidrs } : {}),
        }),
      });
      if (res.status === 401) {
        setStatus("signedout");
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error?.message ?? j.error ?? `Request failed (${res.status}).`);
      }
      const j = (await res.json()) as {
        key: ApiKeySummary;
        plaintext: string;
      };
      setReveal({ id: j.key.id, plaintext: j.plaintext });
      setLabel("");
      setExpiresInDays("");
      setRpm("");
      setIpAllowlist("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [label, expiresInDays, scopes, rpm, ipAllowlist, refresh]);

  const onRevoke = useCallback(
    async (id: string) => {
      if (!confirm("Revoke this key? Existing clients using it will start getting 401.")) return;
      setBusy(id);
      try {
        const res = await fetch(`/api/api-keys/${id}`, { method: "PATCH" });
        if (!res.ok) throw new Error(`Revoke failed (${res.status}).`);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy("");
      }
    },
    [refresh],
  );

  const onRotate = useCallback(
    async (id: string) => {
      if (
        !confirm(
          "Rotate this key? The current secret stops working immediately and the new one will be shown once.",
        )
      )
        return;
      setBusy(id);
      setError("");
      try {
        const res = await fetch(`/api/api-keys/${id}/rotate`, { method: "POST" });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error?.message ?? `Rotate failed (${res.status}).`);
        }
        const j = (await res.json()) as { key: ApiKeySummary; plaintext: string };
        setReveal({ id: j.key.id, plaintext: j.plaintext });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy("");
      }
    },
    [refresh],
  );

  const onSetRpm = useCallback(
    async (id: string, current: number | undefined) => {
      const ans = window.prompt(
        "Requests per minute for this key (blank to use the default 60, or 1-100000):",
        current ? String(current) : "",
      );
      if (ans === null) return;
      const trimmed = ans.trim();
      let payload: { rpm: number | null };
      if (trimmed === "") {
        payload = { rpm: null };
      } else {
        const n = Number(trimmed);
        if (!Number.isFinite(n) || n < 1 || n > 100000) {
          setError("Rate limit must be an integer between 1 and 100000.");
          return;
        }
        payload = { rpm: Math.floor(n) };
      }
      setBusy(id);
      setError("");
      try {
        const res = await fetch(`/api/api-keys/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error?.message ?? `Update failed (${res.status}).`);
        }
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy("");
      }
    },
    [refresh],
  );

  const onSetAllowlist = useCallback(
    async (id: string, current: string[] | undefined) => {
      const ans = window.prompt(
        "Source IP allowlist for this key (CIDRs, comma- or space-separated). Leave blank to clear and accept any source IP.",
        Array.isArray(current) && current.length > 0 ? current.join(", ") : "",
      );
      if (ans === null) return;
      const cidrs = ans
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const payload: { ipAllowlist: string[] | null } = {
        ipAllowlist: cidrs.length === 0 ? null : cidrs,
      };
      setBusy(id);
      setError("");
      try {
        const res = await fetch(`/api/api-keys/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error?.message ?? `Update failed (${res.status}).`);
        }
        const j = (await res.json()) as { rejectedCidrs?: string[] };
        if (Array.isArray(j.rejectedCidrs) && j.rejectedCidrs.length > 0) {
          setError(`Skipped invalid CIDR entries: ${j.rejectedCidrs.join(", ")}`);
        }
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy("");
      }
    },
    [refresh],
  );

  const onDelete = useCallback(
    async (id: string) => {
      if (!confirm("Delete this key record permanently?")) return;
      setBusy(id);
      try {
        const res = await fetch(`/api/api-keys/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`Delete failed (${res.status}).`);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy("");
      }
    },
    [refresh],
  );

  return (
    <div>
      <H1 eyebrow="api keys">
        Programmatic access to the codeclone API.
      </H1>

      {reveal && (
        <div className="ruled rounded-md p-5 mb-6 bg-[var(--color-accent-soft)] border-[color:var(--color-accent)]">
          <div className="flex items-start gap-3 mb-3">
            <Warning size={18} weight="duotone" className="text-[var(--color-accent-ink)] shrink-0 mt-0.5" />
            <div>
              <div className="text-[13.5px] font-medium text-[var(--color-accent-ink)]">
                Copy this key now. It will not be shown again.
              </div>
              <div className="text-[12.5px] text-[var(--color-ink-2)] mt-0.5">
                Only the SHA-256 hash is stored on the server. Update any client or webhook that holds the previous secret.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 bg-[var(--color-paper)] border border-[var(--color-rule)] rounded-sm px-3 py-2">
            <code className="mono text-[12.5px] flex-1 break-all select-all">
              {reveal.plaintext}
            </code>
            <CopyButton text={reveal.plaintext} label="Copy key" />
          </div>
          <button
            type="button"
            onClick={() => setReveal(null)}
            className="mt-3 mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="ruled rounded-md p-4 mb-8">
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <Key size={16} weight="duotone" className="text-[var(--color-ink-3)] hidden sm:block" />
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label this key (e.g. production, local-dev, CI)"
            maxLength={60}
            className="flex-1 bg-transparent outline-none text-[13.5px] px-2 py-1.5 border border-[var(--color-rule)] rounded-sm focus:border-[var(--color-accent)]"
            onKeyDown={(e) => {
              if (e.key === "Enter") void onCreate();
            }}
          />
          <input
            type="number"
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
            placeholder="Expires (days, blank = never)"
            min={1}
            max={365}
            className="sm:w-44 bg-transparent outline-none text-[13.5px] px-2 py-1.5 border border-[var(--color-rule)] rounded-sm focus:border-[var(--color-accent)]"
            onKeyDown={(e) => {
              if (e.key === "Enter") void onCreate();
            }}
          />
          <input
            type="number"
            value={rpm}
            onChange={(e) => setRpm(e.target.value)}
            placeholder="Rate limit (rpm, blank = 60)"
            min={1}
            max={100000}
            className="sm:w-48 bg-transparent outline-none text-[13.5px] px-2 py-1.5 border border-[var(--color-rule)] rounded-sm focus:border-[var(--color-accent)]"
            onKeyDown={(e) => {
              if (e.key === "Enter") void onCreate();
            }}
          />
          <button
            type="button"
            onClick={onCreate}
            disabled={creating}
            className="inline-flex items-center justify-center gap-1.5 mono text-[11.5px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[var(--color-accent)] bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50"
          >
            <Plus size={12} weight="bold" />
            {creating ? "Creating" : "Create key"}
          </button>
        </div>
        <div className="mt-3 flex items-start gap-2">
          <ShieldCheck size={14} weight="duotone" className="text-[var(--color-ink-3)] mt-2 hidden sm:block" />
          <input
            type="text"
            value={ipAllowlist}
            onChange={(e) => setIpAllowlist(e.target.value)}
            placeholder="Source IP allowlist (CIDRs, comma-separated, blank = any). Example: 203.0.113.0/24, 2001:db8::/32"
            className="flex-1 bg-transparent outline-none text-[12.5px] px-2 py-1.5 border border-[var(--color-rule)] rounded-sm focus:border-[var(--color-accent)] mono"
            onKeyDown={(e) => {
              if (e.key === "Enter") void onCreate();
            }}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] mr-1">scopes</span>
          {ALL_SCOPES.map((s) => {
            const checked = scopes.includes(s.id);
            const disabled = checked && scopes.length === 1;
            return (
              <label
                key={s.id}
                title={s.desc + (disabled ? " (at least one scope required)" : "")}
                className={`inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border cursor-pointer select-none ${
                  checked
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-ink)]"
                    : "border-[var(--color-rule)] text-[var(--color-ink-3)] hover:bg-[var(--color-paper-2)]"
                } ${disabled ? "opacity-70 cursor-not-allowed" : ""}`}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={checked}
                  disabled={disabled}
                  onChange={(e) => {
                    setScopes((cur) => {
                      if (e.target.checked) {
                        return cur.includes(s.id) ? cur : [...cur, s.id];
                      }
                      const next = cur.filter((x) => x !== s.id);
                      return next.length === 0 ? cur : next;
                    });
                  }}
                />
                {checked ? <Check size={11} weight="bold" /> : <Plus size={11} weight="bold" />}
                {s.label}
              </label>
            );
          })}
          <span className="mono text-[10.5px] text-[var(--color-ink-3)] hidden sm:inline">
            limit a key to just what your integration needs
          </span>
        </div>
      </div>

      <H2 eyebrow="keys">Your keys</H2>
      {error && <div className="mb-4"><ErrorBlock message={error} /></div>}

      {status === "signedout" && (
        <Empty
          title="Sign in to manage API keys."
          hint="API keys are scoped to your account so usage and revocation stay isolated. Visit /signin to create one."
        />
      )}
      {status === "loading" && <LoadingRow rows={3} />}
      {status === "ready" && items.length === 0 && (
        <Empty
          title="No API keys yet."
          hint="Create one above. Use it with /v1/compare to script comparisons from anywhere."
        />
      )}
      {status === "ready" && items.length > 0 && (
        <div className="ruled rounded-md overflow-hidden">
          <div className="grid grid-cols-[1fr_10rem_7rem_7rem_16rem] gap-3 px-4 h-9 items-center bg-[var(--color-paper-2)] border-b border-[var(--color-rule)] mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
            <div>label</div>
            <div>prefix</div>
            <div className="text-right">calls</div>
            <div>last used</div>
            <div className="text-right">actions</div>
          </div>
          {items.map((k) => (
            <div key={k.id} className="border-b border-[var(--color-rule)] last:border-b-0">
            <div
              className="grid grid-cols-[1fr_10rem_7rem_7rem_16rem] gap-3 px-4 min-h-11 items-center py-2 text-[12.5px]"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Key size={13} weight="duotone" className="text-[var(--color-ink-3)] shrink-0" />
                <span className="truncate">{k.label}</span>
                {k.revoked && (
                  <span className="mono text-[9.5px] uppercase tracking-[0.14em] px-1.5 py-px rounded-sm border border-[var(--color-rule)] text-[var(--color-neg)] bg-[var(--color-neg-soft)]">
                    revoked
                  </span>
                )}
                {k.expired && !k.revoked && (
                  <span className="mono text-[9.5px] uppercase tracking-[0.14em] px-1.5 py-px rounded-sm border border-[var(--color-rule)] text-[var(--color-neg)] bg-[var(--color-neg-soft)]">
                    expired
                  </span>
                )}
                {!k.expired && !k.revoked && k.expiresAt && (
                  <span
                    title={`Expires ${fmtTs(k.expiresAt)}`}
                    className="mono text-[9.5px] uppercase tracking-[0.14em] px-1.5 py-px rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-3)] bg-[var(--color-paper-2)]"
                  >
                    exp {fmtTs(k.expiresAt)}
                  </span>
                )}
              </div>
              <div className="mono text-[11.5px] text-[var(--color-ink-2)] truncate">
                {k.prefix}…
                {Array.isArray(k.scopes) && (
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {k.scopes.length === 0 ? (
                      <span className="mono text-[9.5px] uppercase tracking-[0.14em] px-1.5 py-px rounded-sm border border-[var(--color-rule)] text-[var(--color-neg)] bg-[var(--color-neg-soft)]">
                        no scopes
                      </span>
                    ) : (
                      k.scopes.map((s) => (
                        <span
                          key={s}
                          className="mono text-[9.5px] uppercase tracking-[0.14em] px-1.5 py-px rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-3)] bg-[var(--color-paper-2)]"
                        >
                          {s.replace(":write", "")}
                        </span>
                      ))
                    )}
                  </div>
                )}
                {!Array.isArray(k.scopes) && (
                  <span
                    title="Legacy key issued before scoped permissions; treated as full access."
                    className="ml-1 mono text-[9.5px] uppercase tracking-[0.14em] px-1.5 py-px rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-3)] bg-[var(--color-paper-2)]"
                  >
                    full
                  </span>
                )}
              </div>
              <div className="mono tnum text-right text-[var(--color-ink-2)]">
                {fmtInt(k.usageCount)}
              </div>
              <div className="mono text-[11px] text-[var(--color-ink-3)]">
                {fmtTs(k.lastUsedAt)}
              </div>
              <div className="flex items-center justify-end gap-1.5">
                {!k.revoked && !k.expired && (
                  <button
                    type="button"
                    onClick={() => void onSetRpm(k.id, k.rateLimit?.rpm)}
                    disabled={busy === k.id}
                    title={
                      k.rateLimit
                        ? `Per-minute rate limit: ${k.rateLimit.rpm}. Click to change.`
                        : "No custom limit. Defaults to 60 rpm. Click to set."
                    }
                    className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.14em] px-1.5 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)]"
                  >
                    <Gauge size={11} weight="duotone" />
                    {k.rateLimit ? `${k.rateLimit.rpm}/m` : "60/m"}
                  </button>
                )}
                {!k.revoked && !k.expired && (
                  <button
                    type="button"
                    onClick={() => void onSetAllowlist(k.id, k.ipAllowlist)}
                    disabled={busy === k.id}
                    title={
                      Array.isArray(k.ipAllowlist) && k.ipAllowlist.length > 0
                        ? `Locked to source IPs: ${k.ipAllowlist.join(", ")}. Click to change.`
                        : "No source IP restriction. Click to lock this key to specific CIDRs."
                    }
                    className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.14em] px-1.5 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)]"
                  >
                    <ShieldCheck size={11} weight="duotone" />
                    {Array.isArray(k.ipAllowlist) && k.ipAllowlist.length > 0
                      ? `${k.ipAllowlist.length} cidr`
                      : "any ip"}
                  </button>
                )}
                {!k.revoked && !k.expired && (
                  <button
                    type="button"
                    onClick={() => void onRotate(k.id)}
                    disabled={busy === k.id}
                    title="Rotate (issue a new secret, keep id and usage history)"
                    className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.14em] px-1.5 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)]"
                  >
                    <ArrowsClockwise size={11} weight="duotone" />
                    Rotate
                  </button>
                )}
                {!k.revoked && (
                  <button
                    type="button"
                    onClick={() => void onRevoke(k.id)}
                    disabled={busy === k.id}
                    title="Revoke (key stops working but record stays)"
                    className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.14em] px-1.5 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)]"
                  >
                    <Eye size={11} weight="duotone" />
                    Revoke
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void onDelete(k.id)}
                  disabled={busy === k.id}
                  title="Delete record"
                  className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.14em] px-1.5 py-1 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-neg-soft)] text-[var(--color-ink-3)] hover:text-[var(--color-neg)]"
                >
                  <Trash size={11} weight="duotone" />
                </button>
              </div>
            </div>
            <RecentIpsRow keyId={k.id} usageCount={k.usageCount} />
            </div>
          ))}
        </div>
      )}

      <H2 eyebrow="quickstart" right={<CopyButton text={CURL_EXAMPLE(reveal?.plaintext ?? "YOUR_API_KEY")} />}>
        Compare two snippets from the command line
      </H2>
      <div className="ruled rounded-md overflow-hidden">
        <div className="flex items-center gap-2 px-4 h-9 bg-[var(--color-paper-2)] border-b border-[var(--color-rule)]">
          <Terminal size={13} weight="duotone" className="text-[var(--color-ink-3)]" />
          <span className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
            POST /v1/compare
          </span>
        </div>
        <pre className="mono text-[12px] leading-[1.55] p-4 overflow-x-auto whitespace-pre text-[var(--color-ink-2)]">
{CURL_EXAMPLE(reveal?.plaintext ?? "YOUR_API_KEY")}
        </pre>
      </div>
      <p className="mt-3 text-[12.5px] text-[var(--color-ink-3)]">
        Response includes similarity scores, line alignment, and a clone-type label (Type-1 through Type-4). Each authorized call increments the key&apos;s usage counter.
      </p>
    </div>
  );
}

interface RecentIp {
  ip: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
}

/**
 * Disclosure row underneath each API key showing the most recent distinct
 * source IPs that used the key. Fetches the detail record on expand so
 * the list endpoint stays cheap. Helps owners spot leaked keys being
 * exercised from unexpected networks.
 */
function RecentIpsRow({ keyId, usageCount }: { keyId: string; usageCount: number }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [ips, setIps] = useState<RecentIp[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/api-keys/${encodeURIComponent(keyId)}`, {
        credentials: "same-origin",
      });
      if (!res.ok) {
        setError(`Could not load source IPs (${res.status}).`);
        setIps([]);
        return;
      }
      const data = (await res.json()) as { recentIps?: RecentIp[] };
      setIps(Array.isArray(data.recentIps) ? data.recentIps : []);
    } catch {
      setError("Could not load source IPs.");
      setIps([]);
    } finally {
      setLoading(false);
    }
  }, [keyId]);

  const onToggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next && ips === null && !loading) void load();
      return next;
    });
  }, [ips, loading, load]);

  return (
    <div className="px-4 pb-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`recent-ips-${keyId}`}
        className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-3)] hover:text-[var(--color-ink-2)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] rounded-sm"
      >
        {open ? <CaretDown size={10} weight="bold" /> : <CaretRight size={10} weight="bold" />}
        <Globe size={11} weight="duotone" />
        recent source ips
      </button>
      {open && (
        <div id={`recent-ips-${keyId}`} className="mt-2 ml-4">
          {loading && (
            <div className="mono text-[11px] text-[var(--color-ink-3)]">Loading…</div>
          )}
          {!loading && error && (
            <div className="mono text-[11px] text-[var(--color-neg)]">{error}</div>
          )}
          {!loading && !error && ips && ips.length === 0 && (
            <div className="mono text-[11px] text-[var(--color-ink-3)]">
              {usageCount > 0
                ? "No source IPs recorded for older calls. New calls will appear here."
                : "No calls yet. Source IPs appear here after the key is used."}
            </div>
          )}
          {!loading && !error && ips && ips.length > 0 && (
            <ul className="flex flex-col gap-1">
              {ips.map((entry) => (
                <li
                  key={entry.ip}
                  className="flex items-center gap-3 mono text-[11px] text-[var(--color-ink-2)]"
                >
                  <span className="min-w-[11rem] truncate">{entry.ip}</span>
                  <span className="tnum text-[var(--color-ink-3)]">
                    {fmtInt(entry.count)} call{entry.count === 1 ? "" : "s"}
                  </span>
                  <span className="text-[var(--color-ink-3)]">
                    last {fmtTs(entry.lastSeenAt)}
                  </span>
                  <span className="text-[var(--color-ink-3)] hidden sm:inline">
                    first {fmtTs(entry.firstSeenAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
