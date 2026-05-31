import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import {
  ShieldCheck,
  GitDiff,
  ArrowSquareOut,
  LinkSimple,
} from "@phosphor-icons/react/dist/ssr";
import { loadShare, shareSummary } from "../../../lib/share";
import { DiffViewer } from "../../../components/DiffViewer";
import { AlignmentMap } from "../../../components/AlignmentMap";
import { CopyLinkButton } from "../../../components/CopyLinkButton";
import { AddToCollectionButton } from "../../../components/AddToCollectionButton";
import { labelForScore } from "../../../lib/similarity";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const rec = await loadShare(id);
  if (!rec) {
    return {
      title: "codeclone · shared result not found",
      robots: { index: false, follow: false },
    };
  }
  const s = shareSummary(rec);
  const pct = (s.shingleJaccard * 100).toFixed(1);
  const title = `codeclone · ${s.cloneLabel} · ${pct}% similar`;
  const description = `Shingle Jaccard ${pct}% on ${rec.result.bytes.a}/${rec.result.bytes.b} bytes (${s.language}). Side-by-side diff and clone classification.`;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
      url: `/r/${id}`,
    },
    twitter: { card: "summary_large_image", title, description },
    robots: { index: false, follow: false },
  };
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

function formatTs(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export default async function SharedResultPage({ params }: PageProps) {
  const { id } = await params;
  const rec = await loadShare(id);
  if (!rec) notFound();
  const { a, b, language, result, createdAt } = rec;
  const cloneTone: Record<string, "pos" | "warn" | "neutral" | "neg"> = {
    "type-1": "pos",
    "type-2": "pos",
    "type-3": "warn",
    "type-4": "neutral",
    "none":   "neg",
  };
  const ct = cloneTone[result.clone.type] ?? "neutral";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2 text-[var(--color-ink-3)]">
            <LinkSimple weight="duotone" size={14} />
            <span className="eyebrow">shared result · read only</span>
            <span className="mono text-[11px] text-[var(--color-ink-4)]">/r/{id}</span>
          </div>
          <div className="flex items-center gap-2">
            <CopyLinkButton url={`/r/${id}`} />
            <AddToCollectionButton shareId={id} />
            <Link
              href="/compare"
              className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-2.5 py-1 rounded-sm border border-[color:var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-paper)] hover:opacity-90"
            >
              <ArrowSquareOut weight="duotone" size={13} /> open in compare
            </Link>
          </div>
        </div>
        <h1 className="text-[24px] sm:text-[28px] tracking-tight font-medium leading-[1.2]">
          {result.clone.label} · {(result.scores.shingleJaccard * 100).toFixed(1)}% similar
        </h1>
        <div className="mono text-[11.5px] text-[var(--color-ink-3)]">
          {result.method} · {result.latency_ms.toFixed(2)} ms · {result.bytes.a}/{result.bytes.b} bytes · lang {language} · saved {formatTs(createdAt)}
        </div>
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <ScoreCell label="shingle jaccard · 5-gram" value={result.scores.shingleJaccard} primary />
        <ScoreCell label="token jaccard" value={result.scores.tokenJaccard} />
        <ScoreCell label="containment · min-side" value={result.scores.containment} />
      </section>

      <section className="ruled rounded-md p-4 bg-[var(--color-paper)] flex flex-col gap-3">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldCheck weight="duotone" size={18} className="text-[var(--color-accent-ink)] shrink-0" />
            <div className="eyebrow">clone classification · bellon/roy taxonomy</div>
          </div>
          <div className="flex-1" />
          <span className={`mono text-[11px] uppercase tracking-[0.14em] inline-block px-1.5 py-px border rounded-sm ${TONE_CLASS[ct]}`}>
            {result.clone.label}
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <div className="eyebrow mb-1">confidence</div>
            <div className="mono tnum text-[22px] leading-tight">{result.clone.confidence.toFixed(2)}</div>
          </div>
          <div>
            <div className="eyebrow mb-1">structural jaccard · 4-gram</div>
            <div className="mono tnum text-[22px] leading-tight">{result.clone.structuralSim.toFixed(3)}</div>
          </div>
          <div>
            <div className="eyebrow mb-1">raw token jaccard</div>
            <div className="mono tnum text-[22px] leading-tight">{result.clone.rawTokenSim.toFixed(3)}</div>
          </div>
        </div>
        {result.clone.rationale.length > 0 && (
          <ul className="flex flex-col gap-1 list-disc pl-5 text-[13px] text-[var(--color-ink-2)]">
            {result.clone.rationale.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div className="eyebrow flex items-center gap-2"><GitDiff weight="duotone" size={13} /> line alignment</div>
        <AlignmentMap alignment={result.alignment} a={a} b={b} />
      </section>

      <section className="flex flex-col gap-2">
        <div className="eyebrow flex items-center gap-2"><GitDiff weight="duotone" size={13} /> side-by-side diff</div>
        <DiffViewer left={a} right={b} leftLabel="snippet A" rightLabel="snippet B" maxHeight={460} />
      </section>

      <footer className="border-t border-[var(--color-rule)] pt-4 mono text-[11px] text-[var(--color-ink-4)]">
        codeclone · shared comparisons are public to anyone with the link
      </footer>
    </div>
  );
}
