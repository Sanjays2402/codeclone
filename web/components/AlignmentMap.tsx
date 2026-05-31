"use client";

/**
 * Line-level alignment heatmap.
 *
 * Two stacked tracks, A on top and B on bottom, each cell representing one
 * non-blank line. Connector lines link an A-cell to its best B-cell. Cell
 * intensity tracks the match score. Exact and moved matches get a tone.
 *
 * Pure SVG, no client deps. Tooltips on hover, click filters the side list.
 */
import { useMemo, useState } from "react";
import type { LineAlignment, LineMatch } from "../lib/similarity";
import { ArrowsLeftRight, CheckCircle } from "@phosphor-icons/react/dist/ssr";

interface Props {
  alignment: LineAlignment;
  a: string;
  b: string;
}

const TRACK_PAD = 16;
const CELL_GAP = 2;
const CELL_MIN = 6;
const TRACK_H = 18;
const BAND_H = 84; // vertical space for connectors

function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }

function lineText(src: string, n: number, max = 120): string {
  const lines = src.split(/\r?\n/);
  const t = (lines[n - 1] ?? "").replace(/\s+$/, "");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export function AlignmentMap({ alignment, a, b }: Props) {
  const [hovered, setHovered] = useState<LineMatch | null>(null);
  const [selected, setSelected] = useState<LineMatch | null>(null);

  // Derived map: which A-line index has a match.
  const matchByA = useMemo(() => {
    const m = new Map<number, LineMatch>();
    for (const x of alignment.matches) m.set(x.a, x);
    return m;
  }, [alignment.matches]);

  const matchByB = useMemo(() => {
    const m = new Map<number, LineMatch>();
    for (const x of alignment.matches) {
      const prev = m.get(x.b);
      if (!prev || x.score > prev.score) m.set(x.b, x);
    }
    return m;
  }, [alignment.matches]);

  if (alignment.aLines === 0 || alignment.bLines === 0) {
    return (
      <div className="text-[12.5px] text-[var(--color-ink-3)]">
        No non-blank lines to align.
      </div>
    );
  }

  // Layout: compute cell width to fit container width, but cap.
  const VIEW_W = 920;
  const inner = VIEW_W - TRACK_PAD * 2;
  const cellsA = alignment.aLines;
  const cellsB = alignment.bLines;
  const cellsMax = Math.max(cellsA, cellsB);
  const cellW = Math.max(CELL_MIN, Math.floor((inner - CELL_GAP * (cellsMax - 1)) / cellsMax));
  const widthA = cellsA * cellW + CELL_GAP * (cellsA - 1);
  const widthB = cellsB * cellW + CELL_GAP * (cellsB - 1);
  const offsetA = TRACK_PAD + (inner - widthA) / 2;
  const offsetB = TRACK_PAD + (inner - widthB) / 2;
  const trackAY = 4;
  const trackBY = trackAY + TRACK_H + BAND_H;
  const SVG_H = trackBY + TRACK_H + 4;

  const xOfA = (i: number): number => offsetA + (i - 1) * (cellW + CELL_GAP);
  const xOfB = (i: number): number => offsetB + (i - 1) * (cellW + CELL_GAP);

  function cellFill(score: number, exact: boolean, moved: boolean): string {
    if (moved) return "var(--color-accent)";
    if (exact) return "var(--color-pos, #10b981)";
    if (score >= 0.5) return "var(--color-pos, #10b981)";
    if (score >= 0.2) return "var(--color-accent-soft, #fde68a)";
    return "var(--color-paper-3, #e7e7e7)";
  }

  function cellOpacity(score: number): number {
    return clamp(0.35 + score * 0.65, 0.35, 1);
  }

  const active = hovered ?? selected;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
        <span className="inline-flex items-center gap-1.5">
          <CheckCircle weight="duotone" size={13} />
          {alignment.exactPairs} exact
        </span>
        <span className="inline-flex items-center gap-1.5">
          <ArrowsLeftRight weight="duotone" size={13} />
          {alignment.movedPairs} moved
        </span>
        <span>coverage A {(alignment.coverageA * 100).toFixed(0)}%</span>
        <span>coverage B {(alignment.coverageB * 100).toFixed(0)}%</span>
        <span>
          {alignment.aLines} / {alignment.bLines} lines
        </span>
      </div>

      <div className="ruled rounded-md bg-[var(--color-paper)] p-3 overflow-x-auto">
        <svg
          viewBox={`0 0 ${VIEW_W} ${SVG_H}`}
          width="100%"
          height={SVG_H}
          role="img"
          aria-label="Line alignment heatmap between snippet A and snippet B"
          style={{ display: "block" }}
        >
          {/* Track labels */}
          <text x={4} y={trackAY + TRACK_H / 2 + 3} className="mono"
            fontSize="9" fill="var(--color-ink-3)" textAnchor="start">A</text>
          <text x={4} y={trackBY + TRACK_H / 2 + 3} className="mono"
            fontSize="9" fill="var(--color-ink-3)" textAnchor="start">B</text>

          {/* Connectors first so cells render above them. */}
          {alignment.matches.map((m) => {
            const x1 = xOfA(m.a) + cellW / 2;
            const x2 = xOfB(m.b) + cellW / 2;
            const y1 = trackAY + TRACK_H;
            const y2 = trackBY;
            const isActive = active && active.a === m.a;
            const stroke = m.moved
              ? "var(--color-accent)"
              : m.exact
              ? "var(--color-pos, #10b981)"
              : "var(--color-ink-4, #b5b5b5)";
            const op = clamp(0.15 + m.score * 0.55, 0.15, 0.85);
            return (
              <path
                key={`c-${m.a}-${m.b}`}
                d={`M ${x1} ${y1} C ${x1} ${y1 + 40}, ${x2} ${y2 - 40}, ${x2} ${y2}`}
                fill="none"
                stroke={stroke}
                strokeWidth={isActive ? 1.5 : 0.8}
                strokeOpacity={isActive ? 0.95 : op}
              />
            );
          })}

          {/* A track cells */}
          {Array.from({ length: cellsA }, (_, i) => i + 1).map((ln) => {
            const m = matchByA.get(ln);
            const score = m?.score ?? 0;
            const fill = m ? cellFill(score, m.exact, m.moved) : "var(--color-paper-3, #e7e7e7)";
            const op = m ? cellOpacity(score) : 0.4;
            const isActive = active && active.a === ln;
            return (
              <rect
                key={`a-${ln}`}
                x={xOfA(ln)}
                y={trackAY}
                width={cellW}
                height={TRACK_H}
                fill={fill}
                fillOpacity={op}
                stroke={isActive ? "var(--color-ink)" : "var(--color-rule, #e0e0e0)"}
                strokeWidth={isActive ? 1.2 : 0.5}
                style={{ cursor: m ? "pointer" : "default" }}
                onMouseEnter={() => m && setHovered(m)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => m && setSelected(selected?.a === m.a ? null : m)}
              >
                <title>
                  {m
                    ? `A line ${ln} → B line ${m.b} · score ${m.score.toFixed(3)}${m.exact ? " · exact" : ""}${m.moved ? " · moved" : ""}`
                    : `A line ${ln} · no match`}
                </title>
              </rect>
            );
          })}

          {/* B track cells */}
          {Array.from({ length: cellsB }, (_, i) => i + 1).map((ln) => {
            const m = matchByB.get(ln);
            const score = m?.score ?? 0;
            const fill = m ? cellFill(score, m.exact, m.moved) : "var(--color-paper-3, #e7e7e7)";
            const op = m ? cellOpacity(score) : 0.4;
            const isActive = active && active.b === ln;
            return (
              <rect
                key={`b-${ln}`}
                x={xOfB(ln)}
                y={trackBY}
                width={cellW}
                height={TRACK_H}
                fill={fill}
                fillOpacity={op}
                stroke={isActive ? "var(--color-ink)" : "var(--color-rule, #e0e0e0)"}
                strokeWidth={isActive ? 1.2 : 0.5}
              >
                <title>
                  {m
                    ? `B line ${ln} ← A line ${m.a} · score ${m.score.toFixed(3)}`
                    : `B line ${ln} · no incoming match`}
                </title>
              </rect>
            );
          })}
        </svg>
      </div>

      {/* Detail row: shows whatever is hovered or selected. */}
      <div className="ruled rounded-md p-3 bg-[var(--color-paper)] min-h-[64px] flex flex-col gap-1.5">
        {active ? (
          <>
            <div className="flex items-baseline gap-3 flex-wrap">
              <span className="mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
                A line {active.a} → B line {active.b}
              </span>
              <span className="mono text-[12px] tnum text-[var(--color-ink-2)]">score {active.score.toFixed(3)}</span>
              {active.exact && (
                <span className="mono text-[10.5px] uppercase tracking-[0.14em] px-1.5 py-px rounded-sm border border-[color:var(--color-pos,#10b981)] text-[var(--color-pos,#10b981)] bg-[var(--color-pos-soft,#dcfce7)]">
                  exact
                </span>
              )}
              {active.moved && (
                <span className="mono text-[10.5px] uppercase tracking-[0.14em] px-1.5 py-px rounded-sm border border-[color:var(--color-accent)] text-[var(--color-accent-ink)] bg-[var(--color-accent-soft)]">
                  moved
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <pre className="font-mono text-[12px] leading-[1.5] px-2 py-1.5 rounded-sm bg-[var(--color-paper-2)] border border-[var(--color-rule)] overflow-x-auto"><span className="text-[var(--color-ink-4)] select-none">{String(active.a).padStart(3, " ")}  </span>{lineText(a, active.a)}</pre>
              <pre className="font-mono text-[12px] leading-[1.5] px-2 py-1.5 rounded-sm bg-[var(--color-paper-2)] border border-[var(--color-rule)] overflow-x-auto"><span className="text-[var(--color-ink-4)] select-none">{String(active.b).padStart(3, " ")}  </span>{lineText(b, active.b)}</pre>
            </div>
          </>
        ) : (
          <div className="text-[12.5px] text-[var(--color-ink-3)]">
            Hover or click an A-line cell to inspect its best matching line in B.
          </div>
        )}
      </div>
    </div>
  );
}
