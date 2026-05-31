"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Gear,
  DownloadSimple,
  Warning,
  FloppyDisk,
  Bell,
  Sliders,
} from "@phosphor-icons/react/dist/ssr";
import { H1, H2 } from "../../components/Headings";
import { ErrorBlock } from "../../components/States";

const LANGUAGES = [
  "auto", "python", "javascript", "typescript", "go",
  "rust", "java", "cpp", "c", "ruby",
] as const;
type Lang = typeof LANGUAGES[number];

interface Preferences {
  v: 1;
  defaultLanguage: Lang;
  cloneThreshold: number;
  retentionDays: number;
  notifyOnCompareCompleted: boolean;
  notifyOnWebhookFailure: boolean;
  updatedAt: number;
}

type Status = "loading" | "ready" | "error";

export default function SettingsPage() {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number>(0);
  const [wipeText, setWipeText] = useState("");
  const [wipeBusy, setWipeBusy] = useState(false);
  const [wipeMsg, setWipeMsg] = useState("");
  const [wipeErr, setWipeErr] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (!res.ok) throw new Error(`Request failed (${res.status}).`);
      setPrefs((await res.json()) as Preferences);
      setStatus("ready");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const patch = (next: Partial<Preferences>) => {
    if (!prefs) return;
    setPrefs({ ...prefs, ...next });
  };

  const save = async () => {
    if (!prefs) return;
    setSaving(true);
    setErr("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          defaultLanguage: prefs.defaultLanguage,
          cloneThreshold: prefs.cloneThreshold,
          retentionDays: prefs.retentionDays,
          notifyOnCompareCompleted: prefs.notifyOnCompareCompleted,
          notifyOnWebhookFailure: prefs.notifyOnWebhookFailure,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Request failed (${res.status}).`);
      }
      setPrefs((await res.json()) as Preferences);
      setSavedAt(Date.now());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const wipe = async () => {
    setWipeBusy(true);
    setWipeErr("");
    setWipeMsg("");
    try {
      const res = await fetch("/api/settings/wipe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: wipeText }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Request failed (${res.status}).`);
      setWipeMsg(
        `Removed ${j.shares} shares, ${j.apiKeys} api keys, ${j.webhooks} webhooks.`,
      );
      setWipeText("");
      await refresh();
    } catch (e) {
      setWipeErr(e instanceof Error ? e.message : String(e));
    } finally {
      setWipeBusy(false);
    }
  };

  return (
    <div>
      <H1 eyebrow="account">
        <span className="inline-flex items-center gap-2.5">
          <Gear weight="duotone" className="text-[var(--color-ink-3)]" size={26} />
          settings
        </span>
      </H1>

      {status === "loading" && (
        <div className="mono text-[12px] text-[var(--color-ink-3)]">loading preferences&hellip;</div>
      )}
      {status === "error" && <ErrorBlock message={err || "Failed to load."} />}

      {status === "ready" && prefs && (
        <>
          <H2 eyebrow="defaults">
            <span className="inline-flex items-center gap-2">
              <Sliders weight="duotone" size={16} /> compare defaults
            </span>
          </H2>
          <div className="ruled rounded-md p-5 grid grid-cols-1 sm:grid-cols-2 gap-5">
            <label className="block">
              <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] block mb-1.5">
                default language
              </span>
              <select
                value={prefs.defaultLanguage}
                onChange={(e) => patch({ defaultLanguage: e.target.value as Lang })}
                className="w-full h-9 px-2 mono text-[12.5px] bg-[var(--color-paper)] border border-[var(--color-rule)] rounded-sm focus:outline-none focus:border-[var(--color-ink-3)]"
              >
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] block mb-1.5">
                clone threshold ({prefs.cloneThreshold.toFixed(2)})
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={prefs.cloneThreshold}
                onChange={(e) => patch({ cloneThreshold: parseFloat(e.target.value) })}
                className="w-full"
                aria-label="clone threshold"
              />
              <div className="mono text-[10.5px] text-[var(--color-ink-4)] mt-1">
                jaccard at or above this value flags a pair as a clone.
              </div>
            </label>

            <label className="block">
              <span className="mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] block mb-1.5">
                retention (days, 0 = forever)
              </span>
              <input
                type="number"
                min={0}
                max={3650}
                value={prefs.retentionDays}
                onChange={(e) => patch({ retentionDays: parseInt(e.target.value || "0", 10) })}
                className="w-full h-9 px-2 mono text-[12.5px] bg-[var(--color-paper)] border border-[var(--color-rule)] rounded-sm focus:outline-none focus:border-[var(--color-ink-3)]"
              />
            </label>
          </div>

          <H2 eyebrow="notifications">
            <span className="inline-flex items-center gap-2">
              <Bell weight="duotone" size={16} /> alerts
            </span>
          </H2>
          <div className="ruled rounded-md p-5 space-y-3">
            <CheckboxRow
              checked={prefs.notifyOnCompareCompleted}
              onChange={(v) => patch({ notifyOnCompareCompleted: v })}
              title="In-app toast when a long compare finishes"
              hint="Triggers for compares that take longer than 2 seconds."
            />
            <CheckboxRow
              checked={prefs.notifyOnWebhookFailure}
              onChange={(v) => patch({ notifyOnWebhookFailure: v })}
              title="Surface webhook delivery failures"
              hint="Shows a banner on the webhooks page after a failed POST."
            />
          </div>

          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving}
              className="h-9 px-3 mono text-[12px] inline-flex items-center gap-2 border border-[var(--color-rule)] rounded-sm bg-[var(--color-paper-2)] hover:bg-[var(--color-paper-3)] disabled:opacity-50"
            >
              <FloppyDisk weight="duotone" size={14} />
              {saving ? "saving\u2026" : "save preferences"}
            </button>
            {savedAt > 0 && !saving && (
              <span className="mono text-[11px] text-[var(--color-ink-3)]">saved</span>
            )}
          </div>

          <H2 eyebrow="data">your data</H2>
          <div className="ruled rounded-md p-5">
            <p className="text-[13px] text-[var(--color-ink-2)] mb-3">
              Download every share, api key record, and webhook in one JSON file. Plaintext
              key material and webhook signing secrets are never stored, so they are not in
              the export.
            </p>
            <a
              href="/api/settings/export"
              className="h-9 px-3 mono text-[12px] inline-flex items-center gap-2 border border-[var(--color-rule)] rounded-sm bg-[var(--color-paper-2)] hover:bg-[var(--color-paper-3)]"
            >
              <DownloadSimple weight="duotone" size={14} />
              download export
            </a>
          </div>

          <H2 eyebrow="danger zone">
            <span className="inline-flex items-center gap-2 text-[var(--color-neg)]">
              <Warning weight="duotone" size={16} /> delete all data
            </span>
          </H2>
          <div className="ruled rounded-md p-5 bg-[var(--color-neg-soft)] border-[color:var(--color-neg-bar)]">
            <p className="text-[13px] text-[var(--color-ink-2)] mb-3">
              Permanently removes every share, api key, webhook, and the saved preferences
              on this server. This cannot be undone.
            </p>
            <p className="text-[12.5px] text-[var(--color-ink-3)] mb-2">
              Type <span className="mono text-[12px] text-[var(--color-ink)]">delete everything</span> to confirm.
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                value={wipeText}
                onChange={(e) => setWipeText(e.target.value)}
                placeholder="delete everything"
                className="flex-1 h-9 px-2 mono text-[12.5px] bg-[var(--color-paper)] border border-[var(--color-rule)] rounded-sm focus:outline-none focus:border-[var(--color-neg)]"
                aria-label="confirm deletion"
              />
              <button
                onClick={wipe}
                disabled={wipeBusy || wipeText.trim().toLowerCase() !== "delete everything"}
                className="h-9 px-3 mono text-[12px] inline-flex items-center gap-2 border border-[color:var(--color-neg-bar)] rounded-sm text-[var(--color-neg)] hover:bg-[var(--color-neg-soft)] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Warning weight="duotone" size={14} />
                {wipeBusy ? "wiping\u2026" : "delete all data"}
              </button>
            </div>
            {wipeMsg && (
              <div className="mt-3 mono text-[11.5px] text-[var(--color-pos)]">{wipeMsg}</div>
            )}
            {wipeErr && (
              <div className="mt-3 mono text-[11.5px] text-[var(--color-neg)]">{wipeErr}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function CheckboxRow({
  checked, onChange, title, hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  hint: string;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 accent-[var(--color-ink)]"
      />
      <span className="flex-1">
        <span className="text-[13px] text-[var(--color-ink)] block">{title}</span>
        <span className="text-[12px] text-[var(--color-ink-3)] block">{hint}</span>
      </span>
    </label>
  );
}
