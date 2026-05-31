/**
 * Trust center.
 *
 * Single page enterprise security and procurement teams visit before
 * signing. Lists subprocessors, the security posture we actually ship
 * (HTTP headers, auth model, audit log shape), regional residency
 * options, and how to file a vulnerability report. Everything links to
 * the matching code or docs so the page is auditable, not marketing.
 *
 * Server-rendered. No client JS, no third party requests.
 */
import Link from "next/link";
import {
  ShieldCheck,
  Lock,
  Globe,
  FileText,
  Bug,
  Database,
  Buildings,
  Scales,
  ListChecks,
} from "@phosphor-icons/react/dist/ssr";
import { H1, H2, Eyebrow } from "../../components/Headings";
import { buildSecurityHeaders } from "../../lib/security-headers";

export const metadata = {
  title: "Trust · CodeClone",
  description:
    "Security posture, subprocessors, data residency, and disclosure policy for CodeClone.",
};

interface Subprocessor {
  name: string;
  purpose: string;
  region: string;
  optional: boolean;
}

// Keep this list synced with docs/operations.md. A subprocessor here is
// any third party that may process customer data in the default
// deployment. Self-hosted operators replace this list with their own.
const SUBPROCESSORS: Subprocessor[] = [
  {
    name: "Sentry",
    purpose: "Error reporting (stack traces, request id, no payloads)",
    region: "US",
    optional: true,
  },
  {
    name: "GitHub",
    purpose: "Source hosting and security advisory intake",
    region: "US",
    optional: false,
  },
  {
    name: "Hugging Face Hub",
    purpose: "Optional base model and adapter distribution",
    region: "US / EU",
    optional: true,
  },
];

interface ControlRow {
  control: string;
  status: "yes" | "configurable" | "no";
  detail: string;
  link?: { href: string; label: string };
}

const CONTROLS: ControlRow[] = [
  {
    control: "Single sign-on (SAML / OIDC)",
    status: "yes",
    detail: "Per-workspace SSO with JIT user provisioning.",
    link: { href: "/workspaces", label: "Configure" },
  },
  {
    control: "SCIM 2.0 user provisioning",
    status: "yes",
    detail: "Push users and groups from your IdP; deprovision revokes sessions.",
    link: { href: "/scim", label: "Endpoint" },
  },
  {
    control: "Multi-factor authentication (TOTP)",
    status: "yes",
    detail: "Owner-enforceable with grace window; step-up for sensitive mutations.",
  },
  {
    control: "Role-based access control",
    status: "yes",
    detail: "Owner / admin / member / viewer; API keys carry independent scopes.",
    link: { href: "/api-keys", label: "Scopes" },
  },
  {
    control: "Tamper-evident audit log",
    status: "yes",
    detail: "Append-only with SHA-256 hash chain; verify endpoint exposed to owners.",
    link: { href: "/audit", label: "View log" },
  },
  {
    control: "Data residency pinning",
    status: "yes",
    detail: "Workspace pins to a region; cross-region calls return 451.",
  },
  {
    control: "IP allowlists",
    status: "configurable",
    detail: "Per-workspace CIDR allowlist enforced on dashboard and API keys.",
  },
  {
    control: "Rate limits and quotas",
    status: "yes",
    detail: "Per-key and per-session limits with standard 429 + X-RateLimit headers.",
  },
  {
    control: "PII and secret redaction",
    status: "yes",
    detail: "Inbound prompt scrub with per-tenant policy; audited on every match.",
  },
  {
    control: "GDPR export and deletion",
    status: "yes",
    detail: "Workspace owners can export and irreversibly delete tenant data.",
    link: { href: "/workspaces", label: "Lifecycle" },
  },
  {
    control: "Webhook signatures (HMAC-SHA256)",
    status: "yes",
    detail: "Signed deliveries with rotating secrets and replay protection.",
    link: { href: "/webhooks", label: "Endpoints" },
  },
  {
    control: "Encryption in transit",
    status: "configurable",
    detail: "HSTS preload header set; TLS termination is operator responsibility.",
  },
];

const HEADERS = buildSecurityHeaders();

function StatusPill({ status }: { status: ControlRow["status"] }) {
  const map = {
    yes: { label: "Shipped", cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
    configurable: { label: "Configurable", cls: "bg-sky-500/10 text-sky-400 border-sky-500/20" },
    no: { label: "Roadmap", cls: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20" },
  } as const;
  const m = map[status];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium border rounded-md ${m.cls}`}>
      {m.label}
    </span>
  );
}

function Card({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof ShieldCheck;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center gap-2 mb-3">
        <Icon size={18} weight="duotone" className="text-zinc-400" aria-hidden />
        <h3 className="text-[14px] font-medium tracking-tight">{title}</h3>
      </div>
      <div className="text-[13px] text-zinc-400 leading-relaxed space-y-2">{children}</div>
    </section>
  );
}

export default function TrustPage() {
  return (
    <main className="mx-auto max-w-5xl px-5 sm:px-8 py-10">
      <H1 eyebrow="Trust">Security posture and procurement facts</H1>
      <p className="text-[14px] text-zinc-400 max-w-2xl leading-relaxed">
        Everything below is enforced by code in this repository. Each control
        links to the screen, endpoint, or source file that implements it so
        your security review can verify it without contacting us.
      </p>

      <H2 eyebrow="Controls">What is shipped today</H2>
      <div className="rounded-lg border border-white/10 overflow-hidden">
        <table className="w-full text-[13px]">
          <thead className="bg-white/[0.03] text-zinc-400">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">Control</th>
              <th className="text-left font-medium px-4 py-2.5 w-32">Status</th>
              <th className="text-left font-medium px-4 py-2.5">Detail</th>
            </tr>
          </thead>
          <tbody>
            {CONTROLS.map((c) => (
              <tr key={c.control} className="border-t border-white/5 align-top">
                <td className="px-4 py-3 text-zinc-200 font-medium">{c.control}</td>
                <td className="px-4 py-3"><StatusPill status={c.status} /></td>
                <td className="px-4 py-3 text-zinc-400">
                  {c.detail}
                  {c.link && (
                    <>
                      {" "}
                      <Link href={c.link.href} className="text-sky-400 hover:text-sky-300 underline underline-offset-2">
                        {c.link.label}
                      </Link>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <H2 eyebrow="HTTP">Baseline security headers</H2>
      <p className="text-[13px] text-zinc-400 mb-3 max-w-2xl">
        Set by <code className="text-zinc-300 bg-white/5 px-1.5 py-0.5 rounded">web/middleware.ts</code>
        {" "}on every dashboard and API response. Verified by{" "}
        <code className="text-zinc-300 bg-white/5 px-1.5 py-0.5 rounded">tests/security-headers.test.ts</code>.
      </p>
      <div className="rounded-lg border border-white/10 overflow-hidden">
        <table className="w-full text-[12px] font-mono">
          <tbody>
            {Object.entries(HEADERS).map(([name, value]) => (
              <tr key={name} className="border-t border-white/5 first:border-t-0">
                <td className="px-4 py-2 text-zinc-300 align-top whitespace-nowrap">{name}</td>
                <td className="px-4 py-2 text-zinc-400 break-all">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-10">
        <Card icon={Buildings} title="Subprocessors">
          <p>Third parties that may process customer data in the hosted deployment.</p>
          <ul className="space-y-2 mt-2">
            {SUBPROCESSORS.map((s) => (
              <li key={s.name} className="flex items-baseline justify-between gap-3">
                <div>
                  <span className="text-zinc-200 font-medium">{s.name}</span>
                  <span className="text-zinc-500"> · {s.purpose}</span>
                </div>
                <span className="text-zinc-500 text-[11px] whitespace-nowrap">
                  {s.region}{s.optional ? " · optional" : ""}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card icon={Globe} title="Data residency">
          <p>
            Workspaces are pinned to a region at creation. The serve API
            returns <code className="text-zinc-300">451</code> for cross-region
            calls so misrouted traffic cannot exfiltrate data.
          </p>
          <p>Available regions: <span className="text-zinc-200">us-east, eu-west, ap-south</span>.</p>
        </Card>

        <Card icon={Database} title="Data handling">
          <p>
            Inbound prompts pass through a per-tenant redaction pipeline that
            strips configured PII classes and known secret formats before they
            reach the model. Matches are recorded in the audit log with the
            class, not the value.
          </p>
        </Card>

        <Card icon={Lock} title="Authentication">
          <p>
            Magic-link sign in with per-email and per-IP brute-force lockouts.
            SAML, OIDC, and SCIM available for workspace-level identity.
            TOTP MFA can be enforced for owners and admins.
          </p>
        </Card>

        <Card icon={Scales} title="Legal and compliance">
          <p>
            Source is Apache 2.0 (<Link className="text-sky-400 underline underline-offset-2" href="https://github.com/Sanjays2402/codeclone/blob/main/LICENSE">LICENSE</Link>).
            Threat model and operations guide are public.
          </p>
          <ul className="mt-2 space-y-1">
            <li>· <Link className="text-sky-400 underline underline-offset-2" href="https://github.com/Sanjays2402/codeclone/blob/main/SECURITY.md">SECURITY.md</Link></li>
            <li>· <Link className="text-sky-400 underline underline-offset-2" href="https://github.com/Sanjays2402/codeclone/blob/main/docs/threat-model.md">Threat model</Link></li>
            <li>· <Link className="text-sky-400 underline underline-offset-2" href="https://github.com/Sanjays2402/codeclone/blob/main/docs/operations.md">Operations guide</Link></li>
          </ul>
        </Card>

        <Card icon={Bug} title="Vulnerability disclosure">
          <p>
            Report through the GitHub security advisory channel or email
            <span className="text-zinc-200"> security@codeclone.dev</span>.
            We acknowledge within 72 hours.
          </p>
          <p>
            Machine-readable policy:
            {" "}
            <Link className="text-sky-400 underline underline-offset-2" href="/.well-known/security.txt">/.well-known/security.txt</Link>
          </p>
        </Card>

        <Card icon={ListChecks} title="Audit and observability">
          <p>
            Append-only audit log with a SHA-256 hash chain. Owners can verify
            integrity from the dashboard. Prometheus metrics, structured logs,
            and request id propagation are on by default.
          </p>
          <p>
            <Link className="text-sky-400 underline underline-offset-2" href="/audit">View audit log</Link>
            <span className="text-zinc-600"> · </span>
            <Link className="text-sky-400 underline underline-offset-2" href="/api/metrics">/api/metrics</Link>
          </p>
        </Card>
      </div>

      <div className="mt-10 text-[12px] text-zinc-500 flex items-center gap-2">
        <FileText size={14} weight="duotone" aria-hidden />
        <span>
          Need a signed copy of this page for procurement? Send the URL to your
          reviewer. The page is server-rendered and dated by your browser.
        </span>
      </div>
    </main>
  );
}
