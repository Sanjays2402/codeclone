import Link from "next/link";
import { notFound } from "next/navigation";
import { DownloadSimple } from "@phosphor-icons/react/dist/ssr";
import { loadPair } from "../../../lib/data";
import { H1 } from "../../../components/Headings";
import { DiffViewer, DiffStats } from "../../../components/DiffViewer";
import { MetricChip } from "../../../components/MetricChip";
import { fmtInt, shortHash } from "../../../lib/format";

export const dynamic = "force-dynamic";

// Per-function alignment: split each side by blank lines + heuristic def boundaries.
function splitBlocks(src: string): Array<{ title: string; body: string }> {
  const lines = src.split("\n");
  const blocks: Array<{ title: string; body: string }> = [];
  let cur: string[] = [];
  let title = "block 1";
  let n = 1;
  const isDef = (l: string) => /^\s*(def |class |function |fn |func |public |private |export\s+(function|class)|async\s+function)/.test(l);
  for (const l of lines) {
    if (isDef(l) && cur.length > 0) {
      blocks.push({ title, body: cur.join("\n") });
      cur = [];
      n++;
      title = l.trim().slice(0, 80);
    } else if (cur.length === 0 && isDef(l)) {
      title = l.trim().slice(0, 80);
    }
    cur.push(l);
  }
  if (cur.length > 0) blocks.push({ title: title === `block ${n}` ? title : title, body: cur.join("\n") });
  return blocks.length > 0 ? blocks : [{ title: "block", body: src }];
}

function alignBlocks(l: Array<{ title: string; body: string }>, r: Array<{ title: string; body: string }>) {
  // greedy nearest by title token overlap
  const used = new Set<number>();
  const rows: Array<{ left?: { title: string; body: string }; right?: { title: string; body: string }; score: number }> = [];
  for (const li of l) {
    const lt = new Set(li.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    let bestI = -1, bestScore = -1;
    for (let i = 0; i < r.length; i++) {
      if (used.has(i)) continue;
      const rt = new Set(r[i].title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
      let s = 0; for (const t of lt) if (rt.has(t)) s++;
      if (s > bestScore) { bestScore = s; bestI = i; }
    }
    if (bestI >= 0 && bestScore > 0) {
      used.add(bestI);
      rows.push({ left: li, right: r[bestI], score: bestScore });
    } else {
      rows.push({ left: li, score: 0 });
    }
  }
  for (let i = 0; i < r.length; i++) if (!used.has(i)) rows.push({ right: r[i], score: 0 });
  return rows;
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const got = await loadPair(decodeURIComponent(id));
  if (!got) notFound();
  const { pair, split, similarity } = got;

  const lBlocks = splitBlocks(pair.prefix);
  const rBlocks = splitBlocks(pair.completion);
  const aligned = alignBlocks(lBlocks, rBlocks);
  const alignedPairs = aligned.filter(a => a.left && a.right).length;

  // Download the raw pair record (prefix, completion, metadata, similarity)
  // as JSON so a researcher reviewing a clone pair in the dashboard can
  // save the exact record for offline analysis, attach it to a ticket, or
  // diff it against another corpus without rebuilding the query. The API
  // route at /api/pairs/[id] already serves the JSON payload, so this is
  // just a plain <a download> on top of the existing endpoint.
  const jsonHref = `/api/pairs/${encodeURIComponent(pair.id)}`;
  const jsonName = `codeclone-pair-${shortHash(pair.id, 12)}.json`;

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <H1 eyebrow={`pair · ${pair.kind} · ${split} split`}>
          <span className="mono">{shortHash(pair.id, 14)}</span>
        </H1>
        <a
          href={jsonHref}
          download={jsonName}
          className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)] mt-2"
          title="Download this pair (prefix, completion, metadata) as JSON"
        >
          <DownloadSimple size={12} weight="duotone" />
          Download JSON
        </a>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-6">
        <MetricChip label="similarity" value={similarity.toFixed(2)} sub="jaccard tokens" accent large />
        <MetricChip label="alignment" value={`${alignedPairs} / ${Math.max(lBlocks.length, rBlocks.length)}`} sub="blocks paired" />
        <MetricChip label="prefix" value={fmtInt(pair.n_prefix_chars)} sub="chars" />
        <MetricChip label="completion" value={fmtInt(pair.n_completion_chars)} sub="chars" />
      </div>

      <div className="ruled rounded-md p-4 mb-6 bg-[var(--color-paper)]">
        <div className="grid grid-cols-3 gap-6 mono text-[12px]">
          <div>
            <div className="eyebrow mb-1">repo</div>
            <div className="text-[var(--color-ink-2)] truncate">{pair.repo}</div>
          </div>
          <div>
            <div className="eyebrow mb-1">path</div>
            <div className="text-[var(--color-ink-2)] truncate">{pair.path}</div>
          </div>
          <div>
            <div className="eyebrow mb-1">commit · license</div>
            <div className="text-[var(--color-ink-2)] truncate">{shortHash(pair.commit_sha, 12)} · {pair.license ?? "unknown"}</div>
          </div>
        </div>
      </div>

      <div className="mb-2 flex items-baseline justify-between">
        <div className="eyebrow">side by side · synced scroll</div>
        <DiffStats left={pair.prefix} right={pair.completion} />
      </div>
      <DiffViewer
        left={pair.prefix}
        right={pair.completion}
        leftLabel={`prefix · ${pair.language}`}
        rightLabel={`completion · ${pair.language}`}
        maxHeight={620}
      />

      <div className="mt-10 mb-3 flex items-end justify-between">
        <div>
          <div className="eyebrow mb-1">alignment</div>
          <h2 className="text-[17px] tracking-tight font-medium">Per-function blocks</h2>
        </div>
        <div className="mono text-[11px] text-[var(--color-ink-3)]">{alignedPairs} of {Math.max(lBlocks.length, rBlocks.length)} blocks aligned</div>
      </div>
      <div className="ruled rounded-md overflow-hidden">
        <div className="grid grid-cols-[2rem_1fr_1fr] gap-3 px-4 h-8 items-center bg-[var(--color-paper-2)] border-b border-[var(--color-rule)] mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
          <div>·</div><div>prefix block</div><div>completion block</div>
        </div>
        {aligned.map((a, i) => (
          <div key={i} className="grid grid-cols-[2rem_1fr_1fr] gap-3 px-4 py-2 items-center border-b border-[var(--color-rule)] last:border-b-0 mono text-[12px]">
            <div className={a.left && a.right ? "text-[var(--color-pos)]" : "text-[var(--color-ink-4)]"}>
              {a.left && a.right ? "●" : a.left ? "−" : "+"}
            </div>
            <div className="truncate text-[var(--color-ink-2)]">{a.left?.title ?? <span className="text-[var(--color-ink-4)]">—</span>}</div>
            <div className="truncate text-[var(--color-ink-2)]">{a.right?.title ?? <span className="text-[var(--color-ink-4)]">—</span>}</div>
          </div>
        ))}
      </div>

      <div className="mt-8">
        <Link href="/pairs" className="mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]">← back to pairs</Link>
      </div>
    </div>
  );
}
