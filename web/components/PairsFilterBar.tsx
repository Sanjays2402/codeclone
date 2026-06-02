"use client";

import { useEffect, useRef } from "react";

// Filter bar for /pairs. Pulled into a client component so we can wire the
// global "/" keyboard shortcut that focuses the search box from anywhere on
// the page, matching the convention used by GitHub, Linear, and Slack (and
// the same shortcut already live on /history, /snippets, and /collections).
export default function PairsFilterBar({
  defaultQ,
  defaultLang,
}: {
  defaultQ?: string;
  defaultLang?: string;
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
    <form className="mb-4 flex items-center gap-2" action="/pairs">
      <div className="relative">
        <input
          ref={searchInputRef}
          name="q"
          defaultValue={defaultQ ?? ""}
          placeholder="filter id, repo, path"
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
      <input
        name="lang"
        defaultValue={defaultLang ?? ""}
        placeholder="lang"
        className="mono text-[12.5px] px-2.5 py-1.5 bg-[var(--color-paper)] border border-[var(--color-rule)] rounded-sm w-24 focus:border-[var(--color-accent)] outline-none"
      />
      <button className="mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1.5 border border-[var(--color-rule-strong)] rounded-sm hover:bg-[var(--color-paper-2)]">
        apply
      </button>
    </form>
  );
}
