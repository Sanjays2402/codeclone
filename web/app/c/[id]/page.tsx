import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import {
  FolderSimple,
  ArrowSquareOut,
} from "@phosphor-icons/react/dist/ssr";
import { expandCollection } from "../../../lib/collections";
import { CopyLinkButton } from "../../../components/CopyLinkButton";
import { fmtTs } from "../../../lib/format";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  const rec = await expandCollection(id);
  if (!rec) {
    return {
      title: "codeclone · collection not found",
      robots: { index: false, follow: false },
    };
  }
  const description =
    rec.description ||
    `${rec.items.length} saved comparison${rec.items.length === 1 ? "" : "s"}.`;
  return {
    title: `codeclone · ${rec.title}`,
    description,
    openGraph: {
      title: rec.title,
      description,
      type: "article",
      url: `/c/${id}`,
    },
    robots: { index: false, follow: false },
  };
}

export default async function PublicCollectionPage({ params }: PageProps) {
  const { id } = await params;
  const rec = await expandCollection(id);
  if (!rec) notFound();

  return (
    <main className="mx-auto max-w-[900px] px-7 py-10">
      <div className="mb-1">
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-ink-4)]">
          collection
        </span>
      </div>
      <h1 className="text-[28px] leading-[1.1] tracking-[-0.018em] font-medium">
        {rec.title}
      </h1>
      {rec.description && (
        <p className="text-[14px] text-[var(--color-ink-2)] mt-2 max-w-[640px]">
          {rec.description}
        </p>
      )}
      <div className="mt-3 flex items-center gap-3 flex-wrap">
        <span className="mono text-[11px] text-[var(--color-ink-3)]">
          {rec.items.length} item{rec.items.length === 1 ? "" : "s"} • updated{" "}
          {fmtTs(rec.updatedAt)}
        </span>
        <CopyLinkButton url={`/c/${rec.id}`} />
      </div>

      <div className="mt-8">
        {rec.items.length === 0 ? (
          <div className="ruled rounded-md py-14 px-6 text-center">
            <div className="text-[var(--color-ink-2)] text-[14px] mb-1">
              This collection is empty.
            </div>
            <div className="text-[var(--color-ink-3)] text-[12.5px]">
              The owner has not added any comparisons yet.
            </div>
          </div>
        ) : (
          <div className="ruled rounded-md overflow-hidden">
            {rec.items.map((item, i) => {
              const inner = (
                <div className="flex items-center gap-3">
                  <FolderSimple
                    weight="duotone"
                    size={16}
                    className="text-[var(--color-ink-3)] shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="text-[13.5px] font-medium truncate">
                        {item.missing
                          ? "(deleted share)"
                          : item.title || `share ${item.id}`}
                      </div>
                      {!item.missing && (
                        <span className="mono text-[10.5px] uppercase tracking-[0.14em] px-1.5 py-px rounded border border-[var(--color-rule)] text-[var(--color-ink-3)]">
                          {item.language}
                        </span>
                      )}
                      {!item.missing && (
                        <span className="mono text-[11px] text-[var(--color-ink-2)]">
                          {(item.shingleJaccard * 100).toFixed(0)}% •{" "}
                          {item.cloneLabel}
                        </span>
                      )}
                    </div>
                    <div className="mono text-[10.5px] text-[var(--color-ink-4)] mt-0.5 truncate">
                      {item.id}
                      {!item.missing && ` • ${fmtTs(item.createdAt)}`}
                    </div>
                  </div>
                  {!item.missing && (
                    <ArrowSquareOut
                      weight="duotone"
                      size={14}
                      className="text-[var(--color-ink-4)] shrink-0"
                    />
                  )}
                </div>
              );
              const cls = `block px-4 py-3 ${
                i > 0 ? "border-t border-[var(--color-rule)]" : ""
              } ${item.missing ? "opacity-60" : "hover:bg-[var(--color-paper-2)]"}`;
              return item.missing ? (
                <div key={item.id} className={cls}>
                  {inner}
                </div>
              ) : (
                <Link key={item.id} href={`/r/${item.id}`} className={cls}>
                  {inner}
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-10 pt-6 border-t border-[var(--color-rule)] text-center">
        <Link
          href="/"
          className="mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] hover:text-[var(--color-ink-1)]"
        >
          made with codeclone →
        </Link>
      </div>
    </main>
  );
}
