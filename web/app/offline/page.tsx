import { WifiSlash } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

export const metadata = {
  title: "offline — codeclone",
  description: "You are offline. Previously visited pages remain available.",
};

export default function OfflinePage() {
  return (
    <main className="mx-auto max-w-[640px] px-6 sm:px-8 py-16">
      <div className="flex items-center gap-3 text-[var(--color-ink)]">
        <WifiSlash weight="duotone" size={28} className="text-[var(--color-ink-3)]" />
        <h1 className="mono text-[14px] uppercase tracking-[0.18em]">offline</h1>
      </div>
      <p className="mt-4 text-[14px] leading-6 text-[var(--color-ink-2)]">
        codeclone cannot reach the network right now. Pages you have already
        visited are still available from the local cache. Live comparisons and
        new runs need a connection.
      </p>
      <ul className="mt-6 grid gap-1 text-[13px]">
        <li>
          <Link href="/" className="underline underline-offset-4 hover:text-[var(--color-accent)]">
            overview
          </Link>
        </li>
        <li>
          <Link href="/history" className="underline underline-offset-4 hover:text-[var(--color-accent)]">
            history
          </Link>
        </li>
        <li>
          <Link href="/demo" className="underline underline-offset-4 hover:text-[var(--color-accent)]">
            demo
          </Link>
        </li>
      </ul>
    </main>
  );
}
