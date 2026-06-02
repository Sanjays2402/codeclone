"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowsLeftRight, Lightning, Sparkle, Trash, GitDiff, Code, ShieldCheck, Share as ShareIcon, Check, Copy, ClockClockwise, X as XIcon, DownloadSimple } from "@phosphor-icons/react/dist/ssr";
import { DiffViewer } from "../../components/DiffViewer";
import { AlignmentMap } from "../../components/AlignmentMap";
import { ErrorBlock } from "../../components/States";
import { toast } from "../../components/Toaster";
import { COMPARE_LANGUAGES, COMPARE_SAMPLES } from "../../lib/compare-samples";
import { labelForScore, type SimilarityScores, type LineAlignment, type CloneClassification, type CloneType } from "../../lib/similarity";

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
  return (
    <Suspense fallback={null}>
      <ComparePageInner />
    </Suspense>
  );
}

interface RerunInfo {
  id: string;
  title?: string;
}

function ComparePageInner() {
  const searchParams = useSearchParams();
  const fromId = searchParams.get("from");
  const [a, setA] = useState(COMPARE_SAMPLES[0].a);
  const [b, setB] = useState(COMPARE_SAMPLES[0].b);
  const [language, setLanguage] = useState(COMPARE_SAMPLES[0].language);
  const [activeSample, setActiveSample] = useState<string | null>(COMPARE_SAMPLES[0].id);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompareResponse | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [rerun, setRerun] = useState<RerunInfo | null>(null);
  const [rerunLoading, setRerunLoading] = useState<boolean>(Boolean(fromId));
  const [rerunError, setRerunError] = useState<string | null>(null);
  const autoRunRef = useRef<string | null>(null);

  const canCompare = a.trim().length > 0 && b.trim().length > 0 && !loading;

  const submit = useCallback(async () => {
    setLoading(true);
    setError(null);
    const startedAt = performance.now();
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
        setShareUrl(null);
        setShareError(null);
        // Long-run completion toast. Toaster gates on user pref.
        const wallMs = performance.now() - startedAt;
        if (wallMs >= 2000) {
          const seconds = (wallMs / 1000).toFixed(1);
          const label = (json as CompareResponse)?.clone?.label;
          toast.success(`Comparison finished in ${seconds}s`, {
            description: label ? `Verdict: ${label}.` : undefined,
            ttlMs: 6000,
          });
        }
        // Fire-and-forget: tell the onboarding tracker the user has
        // successfully run their first compare. Errors are ignored on
        // purpose so a slow disk write never blocks the UI.
        void fetch("/api/onboarding", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "compared" }),
        }).catch(() => {});
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
    setShareUrl(null); setShareError(null);
  }, []);

  const share = useCallback(async () => {
    setSharing(true);
    setShareError(null);
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a, b, language }),
      });
      const json = await res.json();
      if (!res.ok) {
        setShareError(typeof json.error === "string" ? json.error : `Request failed (${res.status})`);
      } else {
        const abs = typeof window !== "undefined"
          ? `${window.location.origin}${json.url}`
          : json.url;
        setShareUrl(abs);
      }
    } catch (e) {
      setShareError(e instanceof Error ? e.message : String(e));
    } finally {
      setSharing(false);
    }
  }, [a, b, language]);

  // Download the current comparison (inputs + scores + alignment + clone label)
  // as a JSON file. Runs entirely in the browser so it works for users who
  // don't want to mint a public /r/<id> share link or who need to attach the
  // raw result to an internal ticket or code-review thread.
  const downloadJson = useCallback(() => {
    if (!result) return;
    const payload = {
      schema: "codeclone.compare.result/v1",
      exported_at: new Date().toISOString(),
      inputs: { a, b, language },
      result,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    link.download = `codeclone-compare-${stamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [a, b, language, result]);

  const copyShare = useCallback(async () => {
    if (!shareUrl) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {}
  }, [shareUrl]);

  // Re-run support: when /compare?from=<shareId> is opened, fetch the saved
  // share, prefill both editors and the language picker, and auto-run a fresh
  // comparison so the user lands directly on the result.
  useEffect(() => {
    if (!fromId) return;
    let cancelled = false;
    setRerunLoading(true);
    setRerunError(null);
    (async () => {
      try {
        const res = await fetch(`/api/share/${encodeURIComponent(fromId)}`, {
          cache: "no-store",
        });
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setRerunError(
            typeof json?.error === "string"
              ? json.error
              : `Could not load saved comparison (${res.status}).`,
          );
          setRerunLoading(false);
          return;
        }
        const rec = json as {
          id: string;
          title?: string;
          language?: string;
          a?: string;
          b?: string;
        };
        if (typeof rec.a === "string") setA(rec.a);
        if (typeof rec.b === "string") setB(rec.b);
        if (typeof rec.language === "string") setLanguage(rec.language);
        setActiveSample(null);
        setRerun({ id: rec.id, title: rec.title });
      } catch (e) {
        if (!cancelled) {
          setRerunError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setRerunLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fromId]);

  // After prefill, fire one auto-run per share id.
  useEffect(() => {
    if (!rerun) return;
    if (autoRunRef.current === rerun.id) return;
    if (!a.trim() || !b.trim()) return;
    autoRunRef.current = rerun.id;
    void submit();
    // submit is intentionally omitted: we only re-fire when the rerun target
    // changes, not on every keystroke that re-creates submit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerun, a, b]);

  const dismissRerun = useCallback(() => {
    setRerun(null);
    setRerunError(null);
  }, []);

  const charCounts = useMemo(() => ({ a: a.length, b: b.length }), [a, b]);

  // Keyboard shortcut: Cmd/Ctrl+Enter triggers compare from anywhere on the page,
  // including while focused inside either textarea. This is the main action on
  // the only "try it" page, so taking the user's hand off the mouse to run a
  // comparison is a real friction win, especially when iterating on snippet B.
  const canCompareRef = useRef(canCompare);
  canCompareRef.current = canCompare;
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Enter") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (!canCompareRef.current) return;
      e.preventDefault();
      void submitRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Show the platform-appropriate modifier hint on the compare button.
  const [shortcutHint, setShortcutHint] = useState<string>("Ctrl+Enter");
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const ua = navigator.userAgent || "";
    const plat = (navigator as Navigator & { platform?: string }).platform || "";
    const isMac = /Mac|iPhone|iPad|iPod/.test(plat) || /Mac OS X/.test(ua);
    setShortcutHint(isMac ? "\u2318+Enter" : "Ctrl+Enter");
  }, []);

  return (
    <div className="flex flex-col gap-6">
      {(rerunLoading || rerun || rerunError) && (
        <div
          role="status"
          aria-live="polite"
          className={`ruled rounded-md px-3 py-2 flex items-center gap-2 text-[12.5px] ${
            rerunError
              ? "border-[color:var(--color-neg-bar)] bg-[var(--color-neg-soft)] text-[var(--color-neg)]"
              : "bg-[var(--color-paper-2)] text-[var(--color-ink-2)]"
          }`}
        >
          <ClockClockwise weight="duotone" size={14} />
          <span className="truncate">
            {rerunError
              ? `Re-run failed: ${rerunError}`
              : rerunLoading
                ? "Loading saved comparison…"
                : `Re-running saved comparison: ${rerun?.title ?? "Untitled"} (/r/${rerun?.id})`}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={dismissRerun}
            className="text-[var(--color-ink-4)] hover:text-[var(--color-ink-2)]"
            aria-label="Dismiss re-run banner"
          >
            <XIcon weight="bold" size={12} />
          </button>
        </div>
      )}

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
          title={`Run comparison (${shortcutHint})`}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          className="inline-flex items-center gap-1.5 mono text-[11.5px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[color:var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-paper)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Lightning weight="duotone" size={13} />
          {loading ? "comparing…" : "compare"}
          <span aria-hidden className="hidden sm:inline mono text-[10px] normal-case tracking-normal opacity-70 ml-1">
            {shortcutHint}
          </span>
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
            <div className="flex-1" />
            <button
              type="button"
              onClick={downloadJson}
              title="Download this comparison as JSON"
              className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border border-[var(--color-rule)] bg-[var(--color-paper)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
            >
              <DownloadSimple weight="duotone" size={13} />
              download json
            </button>
            <button
              type="button"
              onClick={share}
              disabled={sharing}
              className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border border-[var(--color-rule)] bg-[var(--color-paper)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] disabled:opacity-40"
            >
              <ShareIcon weight="duotone" size={13} />
              {sharing ? "creating link…" : shareUrl ? "create new link" : "share result"}
            </button>
          </div>

          {shareError && (
            <div className="ruled rounded-md p-3 bg-[var(--color-neg-soft)] border-[color:var(--color-neg-bar)] mono text-[12px] text-[var(--color-neg)]">
              share failed: {shareError}
            </div>
          )}
          {shareUrl && (
            <div className="ruled rounded-md p-3 bg-[var(--color-paper)] flex items-center gap-2 flex-wrap">
              <span className="eyebrow shrink-0">public link</span>
              <input
                readOnly
                value={shareUrl}
                onFocus={e => e.currentTarget.select()}
                className="flex-1 min-w-[200px] mono text-[12px] bg-[var(--color-paper-2)] border border-[var(--color-rule)] rounded-sm px-2 py-1 text-[var(--color-ink)] outline-none"
                aria-label="shareable link"
              />
              <button
                type="button"
                onClick={copyShare}
                className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border border-[var(--color-rule)] bg-[var(--color-paper)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
              >
                {copied ? <Check weight="duotone" size={13} /> : <Copy weight="duotone" size={13} />}
                {copied ? "copied" : "copy"}
              </button>
              <a
                href={shareUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border border-[color:var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-paper)] hover:opacity-90"
              >
                open
              </a>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <ScoreCell label="shingle jaccard · 5-gram" value={result.scores.shingleJaccard} primary />
            <ScoreCell label="token jaccard" value={result.scores.tokenJaccard} />
            <ScoreCell label="containment · min-side" value={result.scores.containment} />
          </div>

          <CloneVerdict clone={result.clone} />

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
            <div className="eyebrow flex items-center gap-2"><GitDiff weight="duotone" size={13} /> line alignment · best-match map</div>
            <AlignmentMap alignment={result.alignment} a={a} b={b} />
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

function CloneVerdict({ clone }: { clone: CloneClassification }) {
  const tone: Record<CloneType, "pos" | "warn" | "neutral" | "neg"> = {
    "type-1": "pos",
    "type-2": "pos",
    "type-3": "warn",
    "type-4": "neutral",
    "none":   "neg",
  };
  const t = tone[clone.type];
  const toneClass = TONE_CLASS[t];
  const pct = Math.max(0, Math.min(1, clone.confidence)) * 100;
  return (
    <div className="ruled rounded-md p-4 bg-[var(--color-paper)] flex flex-col gap-3">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <ShieldCheck weight="duotone" size={18} className="text-[var(--color-accent-ink)] shrink-0" />
          <div className="eyebrow">clone classification · bellon/roy taxonomy</div>
        </div>
        <div className="flex-1" />
        <span className={`mono text-[11px] uppercase tracking-[0.14em] inline-block px-1.5 py-px border rounded-sm ${toneClass}`}>
          {clone.label}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <div className="eyebrow mb-1">confidence</div>
          <div className="mono tnum text-[22px] leading-tight">{clone.confidence.toFixed(2)}</div>
          <div className="h-1.5 mt-2 rounded-full bg-[var(--color-paper-3)] overflow-hidden">
            <div className="h-full bg-[var(--color-accent)]" style={{ width: `${pct}%` }} aria-hidden />
          </div>
        </div>
        <div>
          <div className="eyebrow mb-1">structural jaccard · 4-gram</div>
          <div className="mono tnum text-[22px] leading-tight">{clone.structuralSim.toFixed(3)}</div>
          <div className="mono text-[10.5px] text-[var(--color-ink-3)] mt-1">identifiers anonymized</div>
        </div>
        <div>
          <div className="eyebrow mb-1">raw token jaccard</div>
          <div className="mono tnum text-[22px] leading-tight">{clone.rawTokenSim.toFixed(3)}</div>
          <div className="mono text-[10.5px] text-[var(--color-ink-3)] mt-1">surface tokens, no anonymization</div>
        </div>
      </div>
      {clone.rationale.length > 0 && (
        <ul className="flex flex-col gap-1 list-disc pl-5 text-[13px] text-[var(--color-ink-2)]">
          {clone.rationale.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
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
