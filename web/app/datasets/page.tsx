import { loadDatasetStats } from "../../lib/data";
import { H1, H2 } from "../../components/Headings";
import { MetricChip } from "../../components/MetricChip";
import { Empty } from "../../components/States";
import { fmtInt, fmtPct } from "../../lib/format";
import { DownloadSimple } from "@phosphor-icons/react/dist/ssr";
import DatasetsFilterBar from "../../components/DatasetsFilterBar";

export const dynamic = "force-dynamic";

function LangBar({ entries, total }: { entries: Array<[string, number]>; total: number }) {
  return (
    <div className="ruled rounded-md overflow-hidden">
      <div className="grid grid-cols-[10rem_6rem_1fr_5rem] gap-3 px-4 h-8 items-center bg-[var(--color-paper-2)] border-b border-[var(--color-rule)] mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
        <div>lang</div><div>count</div><div>share</div><div className="text-right">%</div>
      </div>
      {entries.map(([lang, n]) => {
        const share = total > 0 ? n / total : 0;
        return (
          <div key={lang} className="grid grid-cols-[10rem_6rem_1fr_5rem] gap-3 px-4 h-9 items-center border-b border-[var(--color-rule)] last:border-b-0 mono text-[12px]">
            <div className="text-[var(--color-ink-2)]">{lang}</div>
            <div className="tnum">{fmtInt(n)}</div>
            <div className="h-1.5 bg-[var(--color-paper-3)] rounded-sm overflow-hidden">
              <div className="h-full bg-[var(--color-accent)]" style={{ width: `${Math.max(2, share * 100)}%` }} />
            </div>
            <div className="tnum text-right text-[var(--color-ink-3)]">{fmtPct(share, 1)}</div>
          </div>
        );
      })}
    </div>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";
  const stats = await loadDatasetStats();
  if (!stats) {
    return (
      <div>
        <H1 eyebrow="datasets">Splits and language mix.</H1>
        <Empty title="No preprocess report on disk." hint="Materialize data/processed/preprocess_report.json." mono="codeclone preprocess --recipe recipes/default.yaml" />
      </div>
    );
  }
  const train = stats.train?.total ?? 0;
  const val = stats.val?.total ?? 0;
  const test = stats.test?.total ?? 0;
  const total = train + val + test;
  const allLangs = stats.train?.by_language
    ? Object.entries(stats.train.by_language).sort((a, b) => b[1] - a[1])
    : [];
  // Filter the per-language rows by a case-insensitive substring on the
  // language name so a researcher who only cares about, say, python or ts
  // can narrow the table without scrolling. The split totals above keep
  // showing the full unfiltered counts so the filter never silently lies
  // about the size of the dataset.
  const ql = q.toLowerCase();
  const langs = ql ? allLangs.filter(([lang]) => lang.toLowerCase().includes(ql)) : allLangs;

  // Preserve the active language filter in the CSV download so a researcher
  // who narrowed to one language gets that exact slice in their spreadsheet,
  // not the unfiltered per-language matrix.
  const extraCsvParams = new URLSearchParams();
  if (q) extraCsvParams.set("q", q);
  const extraQs = extraCsvParams.toString();
  const csvHref = `/api/datasets?format=csv${extraQs ? `&${extraQs}` : ""}`;

  return (
    <div>
      <H1 eyebrow={`datasets · ${langs.length} of ${allLangs.length} languages`}>Dataset stats.</H1>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <DatasetsFilterBar defaultQ={q} />
        <a
          href={csvHref}
          download="codeclone-datasets.csv"
          className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)]"
          title="Download the per-language pair counts across splits as CSV"
        >
          <DownloadSimple size={12} weight="duotone" />
          Download CSV
        </a>
      </div>
      <div className="grid grid-cols-4 gap-3 mb-6">
        <MetricChip label="total pairs" value={fmtInt(total)} sub="after preprocess + dedupe" large accent />
        <MetricChip label="train" value={fmtInt(train)} sub={fmtPct(total > 0 ? train / total : 0, 1)} />
        <MetricChip label="val"   value={fmtInt(val)}   sub={fmtPct(total > 0 ? val / total : 0, 1)} />
        <MetricChip label="test"  value={fmtInt(test)}  sub={fmtPct(total > 0 ? test / total : 0, 1)} />
      </div>

      <H2 eyebrow="train · by language">Language mix</H2>
      {langs.length > 0
        ? <LangBar entries={langs} total={train} />
        : <Empty title={q ? "No languages match the filter." : "No language stats."} hint={q ? "Clear the filter or try a different name." : undefined} mono="" />}

      <H2 eyebrow="report · raw">preprocess_report.json</H2>
      <pre className="ruled rounded-md p-4 mono text-[11.5px] overflow-auto max-h-[360px]">
        {JSON.stringify(stats, null, 2)}
      </pre>
    </div>
  );
}
