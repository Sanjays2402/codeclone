import Link from "next/link";
import { loadPairsList } from "../../lib/data";
import { H1 } from "../../components/Headings";
import { Empty } from "../../components/States";
import PairsFilterBar from "../../components/PairsFilterBar";
import { fmtInt, shortHash } from "../../lib/format";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const lang = sp.lang;
  const q = sp.q;
  const { items, total } = await loadPairsList({ limit: 300, lang, q });

  return (
    <div>
      <H1 eyebrow={`pairs · ${fmtInt(total)} rows`}>Clone-pair index.</H1>

      <PairsFilterBar defaultQ={q} defaultLang={lang} />

      {items.length === 0 ? (
        <Empty title="No pairs match." hint="Try clearing filters or run the preprocess pipeline." mono="codeclone preprocess --recipe recipes/default.yaml" />
      ) : (
        <div className="ruled rounded-md overflow-hidden">
          <div className="grid grid-cols-[10rem_4rem_4rem_4rem_1fr_8rem_5rem_4rem] gap-3 px-4 h-8 items-center bg-[var(--color-paper-2)] border-b border-[var(--color-rule)] mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
            <div>id</div><div>sim</div><div>lang</div><div>split</div><div>path</div><div>repo</div><div className="text-right">chars</div><div>kind</div>
          </div>
          {items.map(p => (
            <Link
              key={p.id}
              href={`/pairs/${encodeURIComponent(p.id)}`}
              className="grid grid-cols-[10rem_4rem_4rem_4rem_1fr_8rem_5rem_4rem] gap-3 px-4 h-9 items-center border-b border-[var(--color-rule)] last:border-b-0 hover:bg-[var(--color-paper-2)] mono text-[12px]"
            >
              <div className="truncate text-[var(--color-ink-2)]">{shortHash(p.id, 12)}</div>
              <div className="tnum">{p.similarity.toFixed(2)}</div>
              <div className="text-[var(--color-ink-3)]">{p.language}</div>
              <div className="text-[var(--color-ink-3)]">{p.split}</div>
              <div className="truncate text-[var(--color-ink-2)]">{p.path}</div>
              <div className="truncate text-[var(--color-ink-3)]">{p.repo}</div>
              <div className="tnum text-right text-[var(--color-ink-3)]">{fmtInt(p.n_prefix_chars + p.n_completion_chars)}</div>
              <div className="text-[var(--color-ink-3)]">{p.kind === "fill_in_middle" ? "fim" : p.kind.slice(0, 4)}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
