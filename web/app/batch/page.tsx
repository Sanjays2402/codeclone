"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GridFour, Lightning, Plus, Trash, ArrowsLeftRight, FileCode, Sparkle,
} from "@phosphor-icons/react/dist/ssr";
import { DiffViewer } from "../../components/DiffViewer";
import { ErrorBlock } from "../../components/States";
import { BATCH_SAMPLES, type BatchSampleSet, type BatchSnippet } from "../../lib/batch-samples";
import { labelForScore, type CloneType, type SimilarityScores } from "../../lib/similarity";

interface BatchCell {
  i: number;
  j: number;
  scores: SimilarityScores;
  clone: { type: CloneType; confidence: number; rationale: string[] };
}

interface BatchResponse {
  language: string;
  n: number;
  snippets: { index: number; id: string; label: string; bytes: number; lines: number }[];
  matrix: number[][];
  cells: BatchCell[];
  latency_ms: number;
  method: string;
}

const CLONE_TONE: Record<CloneType, string> = {
  "type-1": "text-[var(--color-pos)] border-[color:var(--color-pos)] bg-[var(--color-pos-soft)]",
  "type-2": "text-[var(--color-pos)] border-[color:var(--color-pos)] bg-[var(--color-pos-soft)]",
  "type-3": "text-[var(--color-accent-ink)] border-[color:var(--color-accent)] bg-[var(--color-accent-soft)]",
  "type-4": "text-[var(--color-accent-ink)] border-[color:var(--color-accent)] bg-[var(--color-accent-soft)]",
  "none":   "text-[var(--color-ink-3)] border-[var(--color-rule)] bg-[var(--color-paper-2)]",
};

function heatColor(v: number): string {
  // 0 = paper-3, 1 = accent. Use a soft mix so the grid never goes black on you.
  const pct = Math.max(0, Math.min(1, v));
  // Use color-mix between paper-3 (background) and the brand accent.
  return `color-mix(in oklab, var(--color-accent) ${Math.round(pct * 100)}%, var(--color-paper-3))`;
}

function makeBlank(index: number): BatchSnippet {
  return { id: `s${index + 1}`, label: `snippet ${index + 1}`, code: "" };
}

function fromSample(set: BatchSampleSet): BatchSnippet[] {
  return set.snippets.map(s => ({ ...s }));
}

export default function BatchPage() {
  const [snippets, setSnippets] = useState<BatchSnippet[]>(() => fromSample(BATCH_SAMPLES[0]));
  const [language, setLanguage] = useState<string>(BATCH_SAMPLES[0].language);
  const [activeSet, setActiveSet] = useState<string | null>(BATCH_SAMPLES[0].id);
  const [result, setResult] = useState<BatchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ i: number; j: number } | null>(null);

  const canRun = useMemo(
    () => snippets.length >= 2 && snippets.every(s => s.code.trim().length > 0) && !loading,
    [snippets, loading],
  );

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSelected(null);
    try {
      const res = await fetch("/api/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snippets, language }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : `Request failed (${res.status}).`);
        setResult(null);
      } else {
        setResult(data as BatchResponse);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [snippets, language]);

  // Auto-run once on first mount so visitors immediately see the matrix.
  useEffect(() => {
    if (!result && !loading && !error) {
      void run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSample = (set: BatchSampleSet) => {
    setSnippets(fromSample(set));
    setLanguage(set.language);
    setActiveSet(set.id);
    setResult(null);
    setSelected(null);
    setError(null);
  };

  const updateSnippet = (idx: number, patch: Partial<BatchSnippet>) => {
    setSnippets(prev => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
    setActiveSet(null);
  };
  const addSnippet = () => {
    if (snippets.length >= 12) return;
    setSnippets(prev => [...prev, makeBlank(prev.length)]);
    setActiveSet(null);
  };
  const removeSnippet = (idx: number) => {
    if (snippets.length <= 2) return;
    setSnippets(prev => prev.filter((_, i) => i !== idx));
    setActiveSet(null);
  };

  const cellMap = useMemo(() => {
    const m = new Map<string, BatchCell>();
    if (result) for (const c of result.cells) m.set(`${c.i}:${c.j}`, c);
    return m;
  }, [result]);

  const selectedCell = useMemo(() => {
    if (!selected || !result) return null;
    const [a, b] = selected.i < selected.j ? [selected.i, selected.j] : [selected.j, selected.i];
    if (a === b) return null;
    const cell = cellMap.get(`${a}:${b}`);
    if (!cell) return null;
    return { cell, a, b };
  }, [selected, result, cellMap]);

  return (
    <div>
      <div className="mb-6">
        <div className="eyebrow mb-1.5">batch · codeclone</div>
        <h1 className="text-[28px] leading-[1.1] tracking-[-0.018em] font-medium">
          Find clone clusters across many snippets at once.
        </h1>
        <p className="mt-2 text-[13.5px] text-[var(--color-ink-2)] max-w-[68ch]">
          Paste up to twelve code snippets, run pairwise comparison, and read the resulting
          similarity matrix as a heatmap. Click any cell to expand a side-by-side diff and the
          clone-type verdict for that pair.
        </p>
      </div>

      <section className="ruled rounded-md p-4 mb-5 flex flex-col gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="eyebrow">sample sets</span>
          {BATCH_SAMPLES.map(set => {
            const active = activeSet === set.id;
            return (
              <button
                key={set.id}
                type="button"
                onClick={() => loadSample(set)}
                className={`mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border transition-colors ${
                  active
                    ? "border-[color:var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-ink)]"
                    : "border-[var(--color-rule)] text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
                }`}
              >
                {set.title}
              </button>
            );
          })}
          <div className="ml-auto flex items-center gap-2">
            <label className="eyebrow">language</label>
            <select
              value={language}
              onChange={e => setLanguage(e.target.value)}
              className="mono text-[11.5px] uppercase tracking-[0.12em] px-2 py-1 rounded-sm border border-[var(--color-rule)] bg-[var(--color-paper)]"
            >
              {["auto", "python", "typescript", "javascript", "go", "rust", "java"].map(l => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="text-[12px] text-[var(--color-ink-3)]">
          {activeSet
            ? BATCH_SAMPLES.find(s => s.id === activeSet)?.hint
            : "Custom snippet set. Edit any cell, then run."}
        </div>
      </section>

      <section className="grid gap-3 mb-5 sm:grid-cols-2">
        {snippets.map((s, idx) => (
          <div key={idx} className="ruled rounded-md bg-[var(--color-paper)] overflow-hidden flex flex-col">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-rule)] bg-[var(--color-paper-2)]">
              <FileCode weight="duotone" size={14} className="text-[var(--color-ink-3)] shrink-0" />
              <input
                value={s.label}
                onChange={e => updateSnippet(idx, { label: e.target.value })}
                className="mono text-[11.5px] flex-1 min-w-0 bg-transparent outline-none text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)]"
                placeholder={`snippet ${idx + 1}`}
                aria-label={`Snippet ${idx + 1} label`}
              />
              <span className="mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-4)] tnum">
                #{idx + 1}
              </span>
              <button
                type="button"
                onClick={() => removeSnippet(idx)}
                disabled={snippets.length <= 2}
                className="ml-1 p-1 rounded-sm text-[var(--color-ink-3)] hover:text-[var(--color-neg)] hover:bg-[var(--color-neg-soft)] disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label={`Remove snippet ${idx + 1}`}
              >
                <Trash weight="duotone" size={13} />
              </button>
            </div>
            <textarea
              value={s.code}
              onChange={e => updateSnippet(idx, { code: e.target.value })}
              spellCheck={false}
              className="mono text-[12px] leading-[1.55] p-3 min-h-[160px] bg-[var(--color-paper)] text-[var(--color-ink)] outline-none resize-y"
              placeholder="// paste code here"
              aria-label={`Snippet ${idx + 1} code`}
            />
          </div>
        ))}
      </section>

      <div className="flex items-center gap-3 mb-7 flex-wrap">
        <button
          type="button"
          onClick={addSnippet}
          disabled={snippets.length >= 12}
          className="inline-flex items-center gap-1.5 mono text-[11.5px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[var(--color-rule)] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus weight="duotone" size={13} /> add snippet
        </button>
        <button
          type="button"
          onClick={run}
          disabled={!canRun}
          className="inline-flex items-center gap-1.5 mono text-[11.5px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[color:var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-paper)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Lightning weight="duotone" size={13} /> {loading ? "running…" : "run matrix"}
        </button>
        <span className="mono text-[11px] text-[var(--color-ink-4)] tnum">
          {snippets.length} snippet{snippets.length === 1 ? "" : "s"} · up to 12
        </span>
      </div>

      {error && <div className="mb-6"><ErrorBlock message={error} /></div>}

      {result && (
        <>
          <div className="mt-2 mb-3 flex items-end justify-between gap-4">
            <div>
              <div className="eyebrow mb-1">similarity matrix</div>
              <h2 className="text-[17px] leading-tight tracking-tight font-medium">
                Pairwise shingle Jaccard across {result.n} snippets.
              </h2>
            </div>
            <div className="mono text-[11px] text-[var(--color-ink-4)] tnum text-right">
              {result.cells.length} pairs · {result.latency_ms.toFixed(2)} ms
              <div className="text-[10px] uppercase tracking-[0.14em] mt-1">{result.method}</div>
            </div>
          </div>

          <section className="ruled rounded-md p-4 bg-[var(--color-paper)] overflow-x-auto">
            <table className="border-separate" style={{ borderSpacing: 2 }}>
              <thead>
                <tr>
                  <th className="p-1" />
                  {result.snippets.map(s => (
                    <th
                      key={s.index}
                      className="mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-3)] p-1 text-left align-bottom"
                      style={{ minWidth: 56, height: 90 }}
                    >
                      <div
                        style={{
                          writingMode: "vertical-rl",
                          transform: "rotate(180deg)",
                          whiteSpace: "nowrap",
                          maxHeight: 84,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                        title={s.label}
                      >
                        {s.label}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.matrix.map((row, i) => (
                  <tr key={i}>
                    <th
                      className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-3)] pr-2 text-right"
                      style={{ maxWidth: 200, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                      title={result.snippets[i].label}
                    >
                      {result.snippets[i].label}
                    </th>
                    {row.map((v, j) => {
                      const isDiag = i === j;
                      const isSel = selected && ((selected.i === i && selected.j === j) || (selected.i === j && selected.j === i));
                      const ink = v > 0.55 ? "var(--color-paper)" : "var(--color-ink)";
                      return (
                        <td key={j} className="p-0">
                          <button
                            type="button"
                            disabled={isDiag}
                            onClick={() => setSelected({ i, j })}
                            className={`mono text-[11px] tnum w-14 h-9 rounded-sm flex items-center justify-center transition-shadow ${
                              isDiag ? "cursor-default opacity-50" : "hover:ring-2 hover:ring-[color:var(--color-accent)] cursor-pointer"
                            } ${isSel ? "ring-2 ring-[color:var(--color-ink)]" : ""}`}
                            style={{ backgroundColor: isDiag ? "var(--color-paper-3)" : heatColor(v), color: ink }}
                            aria-label={`Similarity between ${result.snippets[i].label} and ${result.snippets[j].label}: ${v.toFixed(2)}`}
                          >
                            {isDiag ? "—" : v.toFixed(2)}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-4 flex items-center gap-2 text-[11px] mono text-[var(--color-ink-3)]">
              <span className="uppercase tracking-[0.14em]">scale</span>
              <span>0.00</span>
              <span
                className="inline-block h-2 w-40 rounded-sm"
                style={{
                  background: "linear-gradient(to right, var(--color-paper-3), var(--color-accent))",
                }}
              />
              <span>1.00</span>
              <Sparkle weight="duotone" size={12} className="ml-2 text-[var(--color-ink-4)]" />
              <span>click any cell to inspect the pair</span>
            </div>
          </section>

          {selectedCell ? (
            <section className="mt-6 ruled rounded-md p-4 bg-[var(--color-paper)]">
              <div className="flex items-center gap-3 mb-3 flex-wrap">
                <ArrowsLeftRight weight="duotone" size={16} className="text-[var(--color-ink-3)]" />
                <div className="mono text-[12px] text-[var(--color-ink)]">
                  {result.snippets[selectedCell.a].label}
                  <span className="text-[var(--color-ink-4)] px-2">vs</span>
                  {result.snippets[selectedCell.b].label}
                </div>
                <span className={`mono text-[10.5px] uppercase tracking-[0.14em] inline-block px-1.5 py-px border rounded-sm ${CLONE_TONE[selectedCell.cell.clone.type]}`}>
                  {selectedCell.cell.clone.type} · conf {selectedCell.cell.clone.confidence.toFixed(2)}
                </span>
                <div className="ml-auto flex items-center gap-3 mono text-[11px] tnum text-[var(--color-ink-3)]">
                  <span>shingle <span className="text-[var(--color-ink)]">{selectedCell.cell.scores.shingleJaccard.toFixed(3)}</span></span>
                  <span>token <span className="text-[var(--color-ink)]">{selectedCell.cell.scores.tokenJaccard.toFixed(3)}</span></span>
                  <span>contain <span className="text-[var(--color-ink)]">{selectedCell.cell.scores.containment.toFixed(3)}</span></span>
                </div>
              </div>
              <div className="text-[12.5px] text-[var(--color-ink-2)] mb-3">
                {selectedCell.cell.clone.rationale.join(" ")}
              </div>
              <DiffViewer
                left={snippets[selectedCell.a].code}
                right={snippets[selectedCell.b].code}
                leftLabel={snippets[selectedCell.a].label}
                rightLabel={snippets[selectedCell.b].label}
                maxHeight={420}
              />
              <div className="mt-2 mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-4)]">
                verdict: {labelForScore(selectedCell.cell.scores.shingleJaccard).label}
              </div>
            </section>
          ) : (
            <section className="mt-6 ruled rounded-md py-8 px-5 text-center text-[12.5px] text-[var(--color-ink-3)]">
              <GridFour weight="duotone" size={22} className="mx-auto mb-2 text-[var(--color-ink-4)]" />
              Pick a cell above to inspect the pair, see the clone-type verdict, and read a side-by-side diff.
            </section>
          )}
        </>
      )}

      {!result && loading && (
        <div className="ruled rounded-md py-14 text-center mono text-[12px] text-[var(--color-ink-3)]">
          building matrix…
        </div>
      )}
    </div>
  );
}
