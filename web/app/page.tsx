import Link from "next/link";
import { Lightning, ArrowRight } from "@phosphor-icons/react/dist/ssr";
import { loadAllPairs, loadEvalReports, loadLatestRun, loadAdapters, loadDatasetStats } from "../lib/data";
import { H1, H2 } from "../components/Headings";
import { MetricChip } from "../components/MetricChip";
import { DiffViewer, DiffStats } from "../components/DiffViewer";
import { Empty } from "../components/States";
import { fmtFloat, fmtInt, fmtPct, fmtTs, shortHash } from "../lib/format";

export const dynamic = "force-dynamic";

export default async function Page() {
  const [{ pairs, raw }, evals, latestRun, adapters, stats] = await Promise.all([
    loadAllPairs(),
    loadEvalReports(),
    loadLatestRun(),
    loadAdapters(),
    loadDatasetStats(),
  ]);

  // pick a hero pair: highest similarity with non-trivial size
  const candidates = pairs
    .filter(p => p.n_prefix_chars > 40 && p.n_completion_chars > 40)
    .sort((a, b) => b.similarity - a.similarity);
  const hero = candidates[0] ?? pairs[0];
  const heroFull = hero ? raw.get(hero.id) : null;
  const evalLatest = evals[0];
  const recent = pairs.slice(0, 8);
  const totalPairs = (stats?.train?.total ?? 0) + (stats?.val?.total ?? 0) + (stats?.test?.total ?? 0);

  return (
    <div>
      <H1 eyebrow="overview · codeclone">Clone-pair surface and adapter eval report.</H1>

      <section className="ruled rounded-md p-4 mb-6 bg-[var(--color-accent-soft)] border-[color:var(--color-accent)] flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-5 justify-between">
        <div className="flex flex-col gap-0.5">
          <div className="eyebrow text-[var(--color-accent-ink)]">new · interactive demo</div>
          <div className="text-[14px] tracking-tight text-[var(--color-ink)]">
            Try the live clone detector on three real samples. No setup, sub-second response.
          </div>
        </div>
        <Link
          href="/demo"
          className="inline-flex items-center gap-1.5 mono text-[11.5px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[color:var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-paper)] hover:opacity-90 shrink-0"
        >
          <Lightning weight="duotone" size={13} /> open demo <ArrowRight weight="duotone" size={13} />
        </Link>
      </section>

      {hero && heroFull ? (
        <section className="ruled rounded-lg p-5 bg-[var(--color-paper)]">
          <div className="flex items-start gap-8 mb-4">
            <div className="shrink-0">
              <div className="eyebrow mb-1.5">similarity · jaccard tokens</div>
              <div className="mono tnum text-[64px] leading-none tracking-tight font-medium">
                {hero.similarity.toFixed(2)}
              </div>
              <div className="mono text-[11.5px] text-[var(--color-ink-3)] mt-2">
                pair <span className="text-[var(--color-ink)]">{shortHash(hero.id, 8)}</span> ·{" "}
                {hero.language} · {hero.split} split
              </div>
              <div className="mt-1"><DiffStats left={heroFull.pair.prefix} right={heroFull.pair.completion} /></div>
              <Link href={`/pairs/${encodeURIComponent(hero.id)}`} className="inline-block mt-4 mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-accent-ink)] border border-[var(--color-accent)] rounded-sm px-2.5 py-1 hover:bg-[var(--color-accent-soft)]">
                open pair →
              </Link>
            </div>
            <div className="flex-1 min-w-0">
              <DiffViewer
                left={heroFull.pair.prefix}
                right={heroFull.pair.completion}
                leftLabel={`prefix · ${heroFull.pair.path}`}
                rightLabel={`completion · ${heroFull.pair.path}`}
                maxHeight={360}
              />
            </div>
          </div>
        </section>
      ) : (
        <Empty title="No pairs on disk." hint="Run the preprocess pipeline to materialize data/processed/{train,val,test}.jsonl." mono="codeclone preprocess --recipe recipes/default.yaml" />
      )}

      <H2 eyebrow="metric · latest" right={evalLatest && <Link href={`/eval/${evalLatest.runId ?? ""}`} className="mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]">eval detail →</Link>}>
        Eval summary
      </H2>
      <div className="grid grid-cols-4 gap-3">
        <MetricChip
          label="pass@1"
          value={evalLatest ? fmtPct(evalLatest.pass_at_1 ?? evalLatest.mini_pass_rate, 1) : "—"}
          sub={evalLatest?.model ?? "no eval yet"}
          accent
        />
        <MetricChip
          label="exact-match"
          value={evalLatest ? fmtPct(evalLatest.exact_match ?? 0, 1) : "—"}
          sub={evalLatest?.mini_scores ? `${evalLatest.mini_scores.filter(c => c.passed).length} / ${evalLatest.mini_scores.length} cases` : ""}
        />
        <MetricChip
          label="perplexity"
          value={evalLatest?.perplexity ? fmtFloat(evalLatest.perplexity.perplexity, 2) : "—"}
          sub={evalLatest?.perplexity?.proxy ? "proxy" : evalLatest?.perplexity ? "exact" : ""}
        />
        <MetricChip
          label="last run"
          value={latestRun ? fmtFloat(latestRun.lastLoss, 3) : "—"}
          sub={latestRun ? `${latestRun.steps} steps · ${fmtTs(latestRun.startedAt)}` : "no runs yet"}
        />
      </div>

      <H2 eyebrow="rows · most recent" right={<Link href="/pairs" className="mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]">all pairs →</Link>}>
        Recent pairs
      </H2>
      {recent.length === 0 ? (
        <Empty title="No pairs to list." hint="The data directory is empty." />
      ) : (
        <div className="ruled rounded-md overflow-hidden">
          <div className="grid grid-cols-[8rem_5rem_5rem_1fr_8rem_5rem] gap-3 px-4 h-8 items-center bg-[var(--color-paper-2)] border-b border-[var(--color-rule)] mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
            <div>id</div><div>sim</div><div>lang</div><div>path</div><div>repo</div><div className="text-right">chars</div>
          </div>
          {recent.map(p => (
            <Link
              key={p.id}
              href={`/pairs/${encodeURIComponent(p.id)}`}
              className="grid grid-cols-[8rem_5rem_5rem_1fr_8rem_5rem] gap-3 px-4 h-9 items-center border-b border-[var(--color-rule)] last:border-b-0 hover:bg-[var(--color-paper-2)] mono text-[12px]"
            >
              <div className="truncate text-[var(--color-ink-2)]">{shortHash(p.id, 10)}</div>
              <div className="tnum">{p.similarity.toFixed(2)}</div>
              <div className="text-[var(--color-ink-3)]">{p.language}</div>
              <div className="truncate text-[var(--color-ink-2)]">{p.path}</div>
              <div className="truncate text-[var(--color-ink-3)]">{p.repo}</div>
              <div className="tnum text-right text-[var(--color-ink-3)]">{fmtInt(p.n_prefix_chars + p.n_completion_chars)}</div>
            </Link>
          ))}
        </div>
      )}

      <H2 eyebrow="counts">Index</H2>
      <div className="grid grid-cols-4 gap-3">
        <MetricChip label="total pairs"     value={fmtInt(totalPairs)} sub={`${fmtInt(stats?.train?.total)} / ${fmtInt(stats?.val?.total)} / ${fmtInt(stats?.test?.total)}`} />
        <MetricChip label="languages"       value={fmtInt(stats?.train?.by_language ? Object.keys(stats.train.by_language).length : 0)} sub="distinct in train" />
        <MetricChip label="adapters"        value={fmtInt(adapters.length)} sub={adapters[0]?.name ?? "none registered"} />
        <MetricChip label="dedupe dropped"  value={fmtInt(stats?.dedupe_dropped)} sub="rows removed at preprocess" />
      </div>
    </div>
  );
}
