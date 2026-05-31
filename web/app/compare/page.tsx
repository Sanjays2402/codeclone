"use client";

import { useCallback, useMemo, useState } from "react";
import { ArrowsLeftRight, Lightning, Sparkle, Trash, GitDiff, Code } from "@phosphor-icons/react/dist/ssr";
import { DiffViewer } from "../../components/DiffViewer";
import { ErrorBlock } from "../../components/States";
import { COMPARE_LANGUAGES, COMPARE_SAMPLES } from "../../lib/compare-samples";
import { labelForScore, type SimilarityScores } from "../../lib/similarity";

interface CompareResponse {
  language: string;
  bytes: { a: number; b: number };
  scores: SimilarityScores;
  latency_ms: number;
  method: string;
}

const TONE_CLASS: Record<"pos" | "warn" | "neutral" | "neg", string> = {
  pos:     "text-[var(--color-pos)] border-[color:var(--color-pos)] bg-[var(--color-pos-soft)]",
  warn:    "text-[var(--color-accent-ink)] border-[color:var(--color-accent)] bg-[var(--color-accent-soft)]",
  neutral: "text-[var(--color-ink-2)] border-[var(--color-rule)] bg-[var(--color-paper-2)]",
  neg:     "text-[var(--color-neg)] border-[color:var(--color-neg-bar)] bg-[var(--color-neg-soft)]",
};

function ScoreCell({ label, value, primary = false }: { label: string; value: number; primary?: boolean }) {
  const { label: badge, tone } = labelForScore(value);
  return (
    <div className="ruled rounded-md p-4 bg-[var(--color-paper)] flex flex-col gap-1">
      <div className="eyebrow">{label}</div>
      <div className={`mono tnum tracking-tight ${primary ? "text-[44px] leading-none font-medium" : "text-[22px] leading-tight"}`}>
        {value.toFixed(3)}
      </div>
      <span className={`mono text-[10.5px] uppercase tracking-[0.14em] inline-block self-start mt-1 px-1.5 py-px border rounded-sm ${TONE_CLASS[tone]}`}>
        {badge}
      </span>
    </div>
  );
}

function ScoreBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="h-1.5 rounded-full bg-[var(--color-paper-3)] overflow-hidden">
      <div
        className="h-full bg-[var(--color-accent)] transition-[width] duration-300"
        style={{ width: `${pct}%` }}
        aria-hidden
      />
    </div>
  );
}

export default function ComparePage() {
  const [a, setA] = useState(COMPARE_SAMPLES[0].a);
  const [b, setB] = useState(COMPARE_SAMPLES[0].b);
  const [language, setLanguage] = useState(COMPARE_SAMPLES[0].language);
  const [activeSample, setActiveSample] = useState<string | null>(COMPARE_SAMPLES[0].id);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompareResponse | null>(null);

  const canCompare = a.trim().length > 0 && b.trim().length > 0 && !loading;

  const submit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/compare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a, b, language }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(typeof json.error === "string" ? json.error : `Request failed (${res.status})`);
        setResult(null);
      } else {
        setResult(json as CompareResponse);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [a, b, language]);

  const loadSample = useCallback((id: string) => {
    const s = COMPARE_SAMPLES.find(x => x.id === id);
    if (!s) return;
    setA(s.a); setB(s.b); setLanguage(s.language); setActiveSample(id); setResult(null); setError(null);
  }, []);

  const swap = useCallback(() => {
    setA(b); setB(a); setResult(null);
  }, [a, b]);

  const clear = useCallback(() => {
    setA(""); setB(""); setResult(null); setError(null); setActiveSample(null);
  }, []);

  const charCounts = useMemo(() => ({ a: a.length, b: b.length }), [a, b]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="eyebrow">try it · compare two snippets</div>
        <h1 className="text-[28px] sm:text-[32px] tracking-tight font-medium leading-[1.15]">
          Paste two pieces of code. Get a similarity score and a side-by-side diff.
        </h1>
        <p className="text-[14px] text-[var(--color-ink-2)] max-w-[68ch]">
          Uses the same whitespace normalization and 5-gram character shingling the offline
          dedupe pipeline uses, plus a token-level Jaccard. Runs entirely on this machine.
          No data leaves the dashboard.
        </p>
      </header>

      <section aria-labelledby="samples" className="flex flex-col gap-2">
        <div id="samples" className="eyebrow flex items-center gap-2">
          <Sparkle weight="duotone" size={13} /> start from a sample
        </div>
        <div className="flex flex-wrap gap-2">
          {COMPARE_SAMPLES.map(s => {
            const on = activeSample === s.id;
            return (
              <button
                key={s.id}
                onClick={() => loadSample(s.id)}
                className={`text-left ruled rounded-md px-3 py-2 transition-colors hover:bg-[var(--color-paper-2)] ${on ? "border-[color:var(--color-accent)] bg-[var(--color-accent-soft)]" : "bg-[var(--color-paper)]"}`}
              >
                <div className="text-[13px] font-medium tracking-tight">{s.title}</div>
                <div className="text-[11.5px] text-[var(--color-ink-3)]">{s.hint}</div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 mono text-[11.5px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
          <Code weight="duotone" size={13} /> language
          <select
            value={language}
            onChange={e => setLanguage(e.target.value)}
            className="ruled rounded-sm bg-[var(--color-paper)] px-2 py-1 mono text-[12px] normal-case tracking-normal text-[var(--color-ink)]"
          >
            {COMPARE_LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>

        <button
          type="button"
          onClick={swap}
          className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] ruled rounded-sm px-2.5 py-1 bg-[var(--color-paper)]"
        >
          <ArrowsLeftRight weight="duotone" size={13} /> swap
        </button>
        <button
          type="button"
          onClick={clear}
          className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] ruled rounded-sm px-2.5 py-1 bg-[var(--color-paper)]"
        >
          <Trash weight="duotone" size={13} /> clear
        </button>

        <div className="flex-1" />

        <button
          type="button"
          onClick={submit}
          disabled={!canCompare}
          className="inline-flex items-center gap-1.5 mono text-[11.5px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[color:var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-paper)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Lightning weight="duotone" size={13} />
          {loading ? "comparing…" : "compare"}
        </button>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Pane label="snippet A" value={a} onChange={setA} count={charCounts.a} />
        <Pane label="snippet B" value={b} onChange={setB} count={charCounts.b} />
      </section>

      {error && <ErrorBlock message={error} />}

      {result && (
        <section className="flex flex-col gap-4" aria-labelledby="results-h">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h2 id="results-h" className="text-[18px] font-medium tracking-tight">Result</h2>
            <span className="mono text-[11px] text-[var(--color-ink-3)]">
              {result.method} · {result.latency_ms.toFixed(2)} ms · {result.bytes.a}/{result.bytes.b} bytes · lang {result.language}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <ScoreCell label="shingle jaccard · 5-gram" value={result.scores.shingleJaccard} primary />
            <ScoreCell label="token jaccard" value={result.scores.tokenJaccard} />
            <ScoreCell label="containment · min-side" value={result.scores.containment} />
          </div>

          <div className="ruled rounded-md p-4 bg-[var(--color-paper)] flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="eyebrow">overall confidence · primary metric</div>
              <div className="mono tnum text-[12px] text-[var(--color-ink-2)]">
                {result.scores.shared.shingles} / {result.scores.size.aShingles + result.scores.size.bShingles - result.scores.shared.shingles} shingles
              </div>
            </div>
            <ScoreBar value={result.scores.shingleJaccard} />
          </div>

          <div className="ruled rounded-md p-4 bg-[var(--color-paper)] flex flex-col gap-2">
            <div className="eyebrow flex items-center gap-2"><GitDiff weight="duotone" size={13} /> shared identifiers · {result.scores.matchedTokens.length}</div>
            {result.scores.matchedTokens.length === 0 ? (
              <div className="text-[12.5px] text-[var(--color-ink-3)]">No meaningful tokens overlap.</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {result.scores.matchedTokens.map(t => (
                  <span key={t} className="mono text-[11.5px] px-1.5 py-0.5 rounded-sm bg-[var(--color-paper-2)] border border-[var(--color-rule)] text-[var(--color-ink-2)]">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <div className="eyebrow flex items-center gap-2"><GitDiff weight="duotone" size={13} /> side-by-side diff</div>
            <DiffViewer left={a} right={b} leftLabel="snippet A" rightLabel="snippet B" maxHeight={420} />
          </div>
        </section>
      )}
    </div>
  );
}

function Pane({
  label, value, onChange, count,
}: { label: string; value: string; onChange: (v: string) => void; count: number }) {
  return (
    <div className="ruled rounded-md overflow-hidden bg-[var(--color-paper)] flex flex-col">
      <div className="px-3 h-8 flex items-center justify-between border-b border-[var(--color-rule)] bg-[var(--color-paper-2)]">
        <span className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">{label}</span>
        <span className="mono text-[10.5px] tnum text-[var(--color-ink-4)]">{count.toLocaleString()} chars</span>
      </div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        spellCheck={false}
        placeholder="paste code here"
        className="font-mono text-[12.5px] leading-[1.55] p-3 min-h-[260px] resize-y outline-none bg-transparent text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)]"
        aria-label={label}
      />
    </div>
  );
}
