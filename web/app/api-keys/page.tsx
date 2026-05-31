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
}

type Status = "loading" | "ready" | "error";

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
  const [creating, setCreating] = useState(false);
  const [reveal, setReveal] = useState<{ id: string; plaintext: string } | null>(null);
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/api-keys", { cache: "no-store" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Request failed (${res.status}).`);
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
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() || "Untitled key" }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Request failed (${res.status}).`);
      }
      const j = (await res.json()) as {
        key: ApiKeySummary;
        plaintext: string;
      };
      setReveal({ id: j.key.id, plaintext: j.plaintext });
      setLabel("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [label, refresh]);

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
                Only the SHA-256 hash is stored on the server.
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
      </div>

      <H2 eyebrow="keys">Your keys</H2>
      {error && <div className="mb-4"><ErrorBlock message={error} /></div>}

      {status === "loading" && <LoadingRow rows={3} />}
      {status === "ready" && items.length === 0 && (
        <Empty
          title="No API keys yet."
          hint="Create one above. Use it with /v1/compare to script comparisons from anywhere."
        />
      )}
      {status === "ready" && items.length > 0 && (
        <div className="ruled rounded-md overflow-hidden">
          <div className="grid grid-cols-[1fr_10rem_7rem_7rem_8rem] gap-3 px-4 h-9 items-center bg-[var(--color-paper-2)] border-b border-[var(--color-rule)] mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
            <div>label</div>
            <div>prefix</div>
            <div className="text-right">calls</div>
            <div>last used</div>
            <div className="text-right">actions</div>
          </div>
          {items.map((k) => (
            <div
              key={k.id}
              className="grid grid-cols-[1fr_10rem_7rem_7rem_8rem] gap-3 px-4 h-11 items-center border-b border-[var(--color-rule)] last:border-b-0 text-[12.5px]"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Key size={13} weight="duotone" className="text-[var(--color-ink-3)] shrink-0" />
                <span className="truncate">{k.label}</span>
                {k.revoked && (
                  <span className="mono text-[9.5px] uppercase tracking-[0.14em] px-1.5 py-px rounded-sm border border-[var(--color-rule)] text-[var(--color-neg)] bg-[var(--color-neg-soft)]">
                    revoked
                  </span>
                )}
              </div>
              <div className="mono text-[11.5px] text-[var(--color-ink-2)] truncate">
                {k.prefix}…
              </div>
              <div className="mono tnum text-right text-[var(--color-ink-2)]">
                {fmtInt(k.usageCount)}
              </div>
              <div className="mono text-[11px] text-[var(--color-ink-3)]">
                {fmtTs(k.lastUsedAt)}
              </div>
              <div className="flex items-center justify-end gap-1.5">
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
