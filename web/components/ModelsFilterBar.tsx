"use client";

import { useEffect, useRef } from "react";

// Filter bar for /models. Pulled into a client component so we can wire the
// global "/" keyboard shortcut that focuses the name filter from anywhere on
// the page, matching the convention used by GitHub, Linear, and Slack (and
// the same shortcut already live on /history, /snippets, /collections,
// /pairs, and /audit). The page itself stays a server component so the
// adapter index and eval reports still render via SSR.
export default function ModelsFilterBar({
  defaultQ,
  defaultBackend,
  defaultMinPass,
  backends,
}: {
  defaultQ?: string;
  defaultBackend?: string;
  defaultMinPass?: number;
  backends: string[];
}) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Skipped while the user is already typing in another input/textarea/select
  // or a contenteditable surface, so we never hijack a literal slash they
  // meant to type. Ignores modifier combos so browser shortcuts like Cmd+/
  // keep working.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (t.isContentEditable) return;
      }
      const el = searchInputRef.current;
      if (!el) return;
      e.preventDefault();
      el.focus();
      el.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <form className="flex items-center gap-2" action="/models">
      <div className="relative">
        <input
          ref={searchInputRef}
          name="q"
          defaultValue={defaultQ ?? ""}
          placeholder="filter name or base"
          aria-keyshortcuts="/"
          className="mono text-[12.5px] px-2.5 py-1.5 pr-8 bg-[var(--color-paper)] border border-[var(--color-rule)] rounded-sm w-72 focus:border-[var(--color-accent)] outline-none"
        />
        <kbd
          aria-hidden="true"
          title="Press / to focus search"
          className="hidden sm:inline absolute right-1.5 top-1/2 -translate-y-1/2 mono text-[10px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-4)] bg-[var(--color-paper)]"
        >
          /
        </kbd>
      </div>
      <select
        name="backend"
        defaultValue={defaultBackend ?? ""}
        className="mono text-[12.5px] px-2.5 py-1.5 bg-[var(--color-paper)] border border-[var(--color-rule)] rounded-sm focus:border-[var(--color-accent)] outline-none"
      >
        <option value="">backend</option>
        {backends.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
      <input
        name="minPass"
        type="number"
        min={0}
        max={1}
        step={0.05}
        defaultValue={defaultMinPass !== undefined ? String(defaultMinPass) : ""}
        placeholder="min pass@1"
        aria-label="Minimum pass@1 (0 to 1)"
        title="Hide adapters whose pass@1 (or mini_pass_rate fallback) is below this threshold"
        className="mono text-[12.5px] px-2.5 py-1.5 bg-[var(--color-paper)] border border-[var(--color-rule)] rounded-sm w-28 focus:border-[var(--color-accent)] outline-none"
      />
      <button className="mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1.5 border border-[var(--color-rule-strong)] rounded-sm hover:bg-[var(--color-paper-2)]">
        apply
      </button>
    </form>
  );
}
