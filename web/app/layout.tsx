import type { Metadata } from "next";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";
import "../styles/globals.css";
import { TopStrip } from "../components/TopStrip";
import { NavBar } from "../components/NavBar";

const sans = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-inter-tight",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "codeclone — eval surface",
  description: "Clone-pair detection and adapter eval reports.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${sans.variable} ${mono.variable}`}
        style={{
          // Apply our display fonts globally (override @theme defaults).
          fontFamily: "var(--font-inter-tight), var(--font-sans)",
        }}
      >
        <style>{`
          :root {
            --font-sans: var(--font-inter-tight), ui-sans-serif, system-ui, sans-serif;
            --font-mono: var(--font-jetbrains-mono), ui-monospace, "SF Mono", Menlo, monospace;
          }
        `}</style>
        <TopStrip />
        <NavBar />
        <main className="mx-auto max-w-[1280px] px-7 pb-24 pt-6">
          {children}
        </main>
        <footer className="mx-auto max-w-[1280px] px-7 py-10 text-[11px] mono text-[var(--color-ink-4)]">
          codeclone · reads {process.env.CODECLONE_RUNS_DIR} · serve at {process.env.CODECLONE_SERVE_URL}
        </footer>
      </body>
    </html>
  );
}
