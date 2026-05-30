"use client";
import { useEffect, useMemo, useRef } from "react";
import { clsx } from "clsx";
import type { DiffLine, DiffResult } from "../lib/diff";
import { alignPair, statusGlyph } from "../lib/diff";

interface Props {
  left: string;
  right: string;
  leftLabel?: string;
  rightLabel?: string;
  maxHeight?: number;
  compact?: boolean;
}

function statusClasses(s: DiffLine["status"]): string {
  switch (s) {
    case "same":  return "bg-[var(--color-paper-2)]";
    case "near":  return "bg-[color:color-mix(in_oklab,var(--color-accent-soft)_55%,transparent)]";
    case "diff":  return "";
    case "empty": return "";
  }
}
function gutterClasses(s: DiffLine["status"]): string {
  switch (s) {
    case "same":  return "text-[var(--color-pos)]";
    case "near":  return "text-[var(--color-accent)]";
    case "diff":  return "text-[var(--color-ink-4)]";
    case "empty": return "text-[var(--color-ink-4)]";
  }
}

function Side({
  lines, label, scrollRef, onScroll,
}: {
  lines: DiffLine[];
  label?: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: (top: number) => void;
}) {
  return (
    <div className="flex-1 min-w-0 border border-[var(--color-rule)] rounded-md bg-[var(--color-paper)] overflow-hidden">
      {label && (
        <div className="px-3 h-8 flex items-center border-b border-[var(--color-rule)] bg-[var(--color-paper-2)] mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-3)] truncate">
          {label}
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={e => onScroll((e.target as HTMLDivElement).scrollTop)}
        className="overflow-auto"
        style={{ maxHeight: "100%" }}
      >
        <pre className="mono text-[12px] leading-[1.55] m-0">
          {lines.map((line, idx) => (
            <div
              key={idx}
              className={clsx(
                "flex items-start min-h-[1.55em]",
                statusClasses(line.status),
              )}
            >
              <span className="gutter inline-block">{line.n}</span>
              <span className={clsx("w-5 shrink-0 text-center mono", gutterClasses(line.status))}>
                {statusGlyph(line.status)}
              </span>
              <span className="pl-2 pr-3 whitespace-pre-wrap break-words flex-1">
                {line.tokens.map((t, i) => (
                  <span key={i} className={t.matched ? "diff-match-token" : undefined}>{t.text}</span>
                ))}
              </span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

export function DiffViewer({ left, right, leftLabel, rightLabel, maxHeight = 460, compact }: Props) {
  const result: DiffResult = useMemo(() => alignPair(left, right), [left, right]);
  const lref = useRef<HTMLDivElement | null>(null);
  const rref = useRef<HTMLDivElement | null>(null);
  const lockRef = useRef<"l" | "r" | null>(null);

  useEffect(() => {
    // reset
    if (lref.current) lref.current.scrollTop = 0;
    if (rref.current) rref.current.scrollTop = 0;
  }, [left, right]);

  function onLeft(top: number) {
    if (lockRef.current === "r") { lockRef.current = null; return; }
    lockRef.current = "l";
    if (rref.current) rref.current.scrollTop = top;
  }
  function onRight(top: number) {
    if (lockRef.current === "l") { lockRef.current = null; return; }
    lockRef.current = "r";
    if (lref.current) lref.current.scrollTop = top;
  }

  return (
    <div className="flex gap-2" style={{ height: maxHeight }}>
      <Side lines={result.left}  label={leftLabel}  scrollRef={lref} onScroll={onLeft} />
      <Side lines={result.right} label={rightLabel} scrollRef={rref} onScroll={onRight} />
    </div>
  );
}

export function DiffStats({ left, right }: { left: string; right: string }) {
  const r = useMemo(() => alignPair(left, right), [left, right]);
  const pct = r.totalTokens === 0 ? 0 : r.matchedTokens / r.totalTokens;
  return (
    <div className="mono text-[11px] text-[var(--color-ink-3)]">
      {r.matchedTokens} of {r.totalTokens} identifiers aligned · {(pct * 100).toFixed(1)}%
    </div>
  );
}
