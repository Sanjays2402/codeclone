"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Lightning,
  Sparkle,
  GitDiff,
  CheckCircle,
  WarningCircle,
  Circle,
  ArrowRight,
  Clock,
  Code,
} from "@phosphor-icons/react/dist/ssr";
import { DiffViewer } from "../../components/DiffViewer";
import { ErrorBlock } from "../../components/States";
import { COMPARE_SAMPLES } from "../../lib/compare-samples";
import {
  labelForScore,
  type SimilarityScores,
  type LineAlignment,
  type CloneClassification,
  type CloneType,
} from "../../lib/similarity";

interface CompareResponse {
  language: string;
  bytes: { a: number; b: number };
  scores: SimilarityScores;
  alignment: LineAlignment;
  clone: CloneClassification;
  latency_ms: number;
  method: string;
}

const TONE_CLASS: Record<"pos" | "warn" | "neutral" | "neg", string> = {
  pos: "text-[var(--color-pos)] border-[color:var(--color-pos)] bg-[var(--color-pos-soft)]",
  warn: "text-[var(--color-accent-ink)] border-[color:var(--color-accent)] bg-[var(--color-accent-soft)]",
  neutral: "text-[var(--color-ink-2)] border-[var(--color-rule)] bg-[var(--color-paper-2)]",
  neg: "text-[var(--color-neg)] border-[color:var(--color-neg-bar)] bg-[var(--color-neg-soft)]",
};

const CLONE_TONE: Record<CloneType, "pos" | "warn" | "neutral" | "neg"> = {
  "type-1": "pos",
  "type-2": "pos",
  "type-3": "warn",
  "type-4": "neutral",
  none: "neg",
};

function VerdictIcon({ type }: { type: CloneType }) {
  if (type === "type-1" || type === "type-2") return <CheckCircle weight="duotone" size={18} />;
  if (type === "type-3") return <WarningCircle weight="duotone" size={18} />;
  if (type === "type-4") return <Sparkle weight="duotone" size={18} />;
  return <Circle weight="duotone" size={18} />;
}

function ScoreCell({ label, value, primary = false }: { label: string; value: number; primary?: boolean }) {
  const { label: badge, tone } = labelForScore(value);
  return (
    <div className="ruled rounded-md p-4 bg-[var(--color-paper)] flex flex-col gap-1">
      <div className="eyebrow">{label}</div>
      <div
        className={`mono tnum tracking-tight ${
          primary ? "text-[40px] leading-none font-medium" : "text-[20px] leading-tight"
        }`}
      >
        {value.toFixed(3)}
      </div>
      <span
        className={`mono text-[10.5px] uppercase tracking-[0.14em] inline-block self-start mt-1 px-1.5 py-px border rounded-sm ${TONE_CLASS[tone]}`}
      >
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
        className="h-full bg-[var(--color-accent)] transition-[width] duration-500"
        style={{ width: `${pct}%` }}
        aria-hidden
      />
    </div>
  );
}

function ResultSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <div className="ruled rounded-md p-5 bg-[var(--color-paper)] flex items-center gap-3">
        <span className="pulse-soft block h-5 w-40 bg-[var(--color-paper-3)] rounded-sm" />
        <span className="pulse-soft block h-3 w-24 bg-[var(--color-paper-3)] rounded-sm" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[0, 1, 2].map(i => (
          <div key={i} className="ruled rounded-md p-4 bg-[var(--color-paper)] flex flex-col gap-2">
            <span className="pulse-soft block h-3 w-24 bg-[var(--color-paper-3)] rounded-sm" />
            <span className="pulse-soft block h-8 w-20 bg-[var(--color-paper-3)] rounded-sm" />
            <span className="pulse-soft block h-3 w-16 bg-[var(--color-paper-3)] rounded-sm" />
          </div>
        ))}
      </div>
      <div className="ruled rounded-md p-4 bg-[var(--color-paper)]">
        <span className="pulse-soft block h-2 w-full bg-[var(--color-paper-3)] rounded-sm" />
      </div>
    </div>
  );
}

export default function DemoPage() {
  const [activeId, setActiveId] = useState<string>(COMPARE_SAMPLES[0].id);
  const [result, setResult] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef<Record<string, CompareResponse>>({});

  const sample = useMemo(
    () => COMPARE_SAMPLES.find(s => s.id === activeId) ?? COMPARE_SAMPLES[0],
    [activeId],
  );

  const run = useCallback(async (id: string) => {
    const s = COMPARE_SAMPLES.find(x => x.id === id);
    if (!s) return;
    if (cache.current[id]) {
      setResult(cache.current[id]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/compare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: s.a, b: s.b, language: s.language }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(typeof json.error === "string" ? json.error : `Request failed (${res.status})`);
        setResult(null);
      } else {
        const r = json as CompareResponse;
        cache.current[id] = r;
        setResult(r);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-run the first sample on mount.
  useEffect(() => {
    run(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickSample = useCallback(
    (id: string) => {
      setActiveId(id);
      setResult(null);
      run(id);
    },
    [run],
  );

  const verdictTone = result ? CLONE_TONE[result.clone.type] : "neutral";
  const verdictToneClass = TONE_CLASS[verdictTone];

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="eyebrow">demo · live similarity scoring</div>
        <h1 className="text-[28px] sm:text-[34px] tracking-tight font-medium leading-[1.1] max-w-[36ch]">
          See if two snippets of code are the same idea wearing different clothes.
        </h1>
        <p className="text-[14px] text-[var(--color-ink-2)] max-w-[72ch]">
          Pick a sample below. We run it against the live API on this machine and return a
          clone-type verdict, three similarity scores, the shared identifiers, and a side-by-side
          diff. No upload, no signup, nothing leaves the box.
        </p>
        <div className="flex flex-wrap gap-2 mt-1">
          <Link
            href="/compare"
            className="inline-flex items-center gap-1.5 mono text-[11.5px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[color:var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-paper)] hover:opacity-90"
          >
            <Lightning weight="duotone" size={13} /> bring your own code
            <ArrowRight weight="duotone" size={13} />
          </Link>
          <a
            href="https://github.com/Sanjays2402/codeclone"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1.5 rounded-sm ruled text-[var(--color-ink-2)] hover:text-[var(--color-ink)] bg-[var(--color-paper)]"
          >
            <Code weight="duotone" size={13} /> source
          </a>
        </div>
      </header>

      <section aria-labelledby="samples-h" className="flex flex-col gap-2">
        <div id="samples-h" className="eyebrow flex items-center gap-2">
          <Sparkle weight="duotone" size={13} /> three samples that span the score range
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {COMPARE_SAMPLES.map(s => {
            const on = activeId === s.id;
            const cached = cache.current[s.id];
            return (
              <button
                key={s.id}
                onClick={() => pickSample(s.id)}
                className={`text-left ruled rounded-md p-4 transition-colors hover:bg-[var(--color-paper-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] ${
                  on
                    ? "border-[color:var(--color-accent)] bg-[var(--color-accent-soft)]"
                    : "bg-[var(--color-paper)]"
                }`}
                aria-pressed={on}
              >
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <div className="text-[14px] font-medium tracking-tight">{s.title}</div>
                  <span className="mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-4)]">
                    {s.language}
                  </span>
                </div>
                <div className="text-[12.5px] text-[var(--color-ink-3)] leading-snug">{s.hint}</div>
                {cached && (
                  <div className="mt-2 mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
                    {cached.clone.label} · {cached.scores.shingleJaccard.toFixed(2)}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        {error && <ErrorBlock message={error} />}
        {!result && loading && <ResultSkeleton />}
        {result && (
          <>
            <div
              className={`ruled rounded-lg p-5 flex items-start gap-4 flex-wrap ${verdictToneClass}`}
            >
              <div className="flex items-center gap-2">
                <VerdictIcon type={result.clone.type} />
                <div className="flex flex-col">
                  <span className="mono text-[10px] uppercase tracking-[0.16em] opacity-80">
                    verdict
                  </span>
                  <span className="text-[18px] font-medium tracking-tight">
                    {result.clone.label}
                  </span>
                </div>
              </div>
              <div className="flex-1 min-w-[140px]" />
              <div className="flex items-center gap-4">
                <div className="flex flex-col items-end">
                  <span className="mono text-[10px] uppercase tracking-[0.16em] opacity-80">
                    confidence
                  </span>
                  <span className="mono tnum text-[16px]">
                    {(result.clone.confidence * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="flex flex-col items-end">
                  <span className="mono text-[10px] uppercase tracking-[0.16em] opacity-80 inline-flex items-center gap-1">
                    <Clock weight="duotone" size={11} /> latency
                  </span>
                  <span className="mono tnum text-[16px]">{result.latency_ms.toFixed(2)} ms</span>
                </div>
              </div>
            </div>

            {result.clone.rationale.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {result.clone.rationale.map((r, i) => (
                  <li
                    key={i}
                    className="text-[13px] text-[var(--color-ink-2)] leading-snug pl-3 border-l-2 border-[var(--color-rule)]"
                  >
                    {r}
                  </li>
                ))}
              </ul>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <ScoreCell
                label="shingle jaccard · 5-gram"
                value={result.scores.shingleJaccard}
                primary
              />
              <ScoreCell label="token jaccard" value={result.scores.tokenJaccard} />
              <ScoreCell label="containment · min-side" value={result.scores.containment} />
            </div>

            <div className="ruled rounded-md p-4 bg-[var(--color-paper)] flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="eyebrow">overall confidence · primary metric</div>
                <div className="mono tnum text-[12px] text-[var(--color-ink-2)]">
                  {result.scores.shared.shingles} /{" "}
                  {result.scores.size.aShingles +
                    result.scores.size.bShingles -
                    result.scores.shared.shingles}{" "}
                  shingles
                </div>
              </div>
              <ScoreBar value={result.scores.shingleJaccard} />
            </div>

            <div className="ruled rounded-md p-4 bg-[var(--color-paper)] flex flex-col gap-2">
              <div className="eyebrow flex items-center gap-2">
                <GitDiff weight="duotone" size={13} /> shared identifiers ·{" "}
                {result.scores.matchedTokens.length}
              </div>
              {result.scores.matchedTokens.length === 0 ? (
                <div className="text-[12.5px] text-[var(--color-ink-3)]">
                  No meaningful tokens overlap.
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {result.scores.matchedTokens.map(t => (
                    <span
                      key={t}
                      className="mono text-[11.5px] px-1.5 py-0.5 rounded-sm bg-[var(--color-paper-2)] border border-[var(--color-rule)] text-[var(--color-ink-2)]"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <div className="eyebrow flex items-center gap-2">
                <GitDiff weight="duotone" size={13} /> side-by-side · {sample.title}
              </div>
              <DiffViewer
                left={sample.a}
                right={sample.b}
                leftLabel={`A · ${sample.language}`}
                rightLabel={`B · ${sample.language}`}
                maxHeight={420}
              />
            </div>

            <div className="mono text-[11px] text-[var(--color-ink-4)]">
              {result.method} · {result.bytes.a}/{result.bytes.b} bytes · lang {result.language}
            </div>
          </>
        )}
      </section>

      <section className="ruled rounded-md p-5 bg-[var(--color-paper-2)] flex flex-col sm:flex-row items-start sm:items-center gap-4 justify-between">
        <div>
          <div className="text-[15px] font-medium tracking-tight mb-1">Want to test your own?</div>
          <div className="text-[13px] text-[var(--color-ink-2)]">
            Paste two snippets, pick a language, get the same scoring plus a line-alignment map.
          </div>
        </div>
        <Link
          href="/compare"
          className="inline-flex items-center gap-1.5 mono text-[11.5px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[color:var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-paper)] hover:opacity-90"
        >
          open compare <ArrowRight weight="duotone" size={13} />
        </Link>
      </section>
    </div>
  );
}
