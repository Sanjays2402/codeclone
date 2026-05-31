"use client";
import { useCallback, useState } from "react";
import { Copy, Check } from "@phosphor-icons/react/dist/ssr";

export function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      // Prefer the modern API; fall back to a hidden textarea for non-https origins.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Swallow; the input is still selectable manually.
    }
  }, [url]);
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label="copy link"
      className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border border-[var(--color-rule)] bg-[var(--color-paper)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
    >
      {copied ? <Check weight="duotone" size={13} /> : <Copy weight="duotone" size={13} />}
      {copied ? "copied" : "copy link"}
    </button>
  );
}
