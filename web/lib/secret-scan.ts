/**
 * Secret scanner used as a DLP guardrail on every snippet a customer
 * submits to compare/batch endpoints. Customers paste source code into
 * codeclone; without a DLP gate, a developer can silently leak an AWS
 * access key, GitHub PAT, Slack token, JWT, or private key into a hosted
 * service. Enterprise procurement reviews (SOC 2 CC6.7, ISO 27001
 * A.8.12) want the answer to "what stops our engineers from pasting
 * production secrets into your tool?" to be a concrete control, not a
 * policy doc.
 *
 * The scanner is pattern-based and deliberately conservative: each rule
 * has a precise regex anchored on a vendor-published prefix (AKIA, ghp_,
 * xoxb-, etc.) so false-positive rate stays low enough that the default
 * "redact" mode is safe to leave on. We do NOT regex for "any 40-char
 * hex string"; that yields too many false hits on real source code.
 *
 * The result is intentionally a plain JSON-serializable shape so it can
 * be returned to the caller, logged to the audit chain, and shipped to
 * webhooks without further massaging.
 */

export type SecretScanMode = "off" | "warn" | "redact" | "block";

export const SECRET_SCAN_MODES: readonly SecretScanMode[] = [
  "off",
  "warn",
  "redact",
  "block",
] as const;

export function isSecretScanMode(x: unknown): x is SecretScanMode {
  return (
    typeof x === "string" &&
    (SECRET_SCAN_MODES as readonly string[]).includes(x)
  );
}

export interface SecretFinding {
  /** Stable rule id, e.g. "aws_access_key_id". Safe to log. */
  rule: string;
  /** Human label suitable for surfacing to end users. */
  label: string;
  /** 0-based UTF-16 offset within the scanned string where match starts. */
  start: number;
  /** 0-based UTF-16 offset (exclusive) where the match ends. */
  end: number;
  /** Last 4 chars of the matched value, for forensic correlation only. */
  tail: string;
}

interface Rule {
  id: string;
  label: string;
  re: RegExp;
}

/**
 * Pattern set. Each regex is `g`-flagged and uses a vendor prefix so we
 * minimize collateral hits in real source. Order doesn't matter; we run
 * them all and de-duplicate overlapping spans afterward.
 */
const RULES: readonly Rule[] = [
  {
    id: "aws_access_key_id",
    label: "AWS Access Key ID",
    re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "github_token",
    label: "GitHub token",
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,255}\b/g,
  },
  {
    id: "github_fine_grained_pat",
    label: "GitHub fine-grained PAT",
    re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g,
  },
  {
    id: "slack_token",
    label: "Slack token",
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: "google_api_key",
    label: "Google API key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "openai_api_key",
    label: "OpenAI API key",
    re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "anthropic_api_key",
    label: "Anthropic API key",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "stripe_secret_key",
    label: "Stripe secret key",
    re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    id: "twilio_account_sid",
    label: "Twilio Account SID",
    re: /\bAC[0-9a-f]{32}\b/g,
  },
  {
    id: "sendgrid_api_key",
    label: "SendGrid API key",
    re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "jwt",
    label: "JSON Web Token",
    re: /\bey[A-Za-z0-9_-]{8,}\.ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: "private_key_pem",
    label: "PEM private key",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: "npm_token",
    label: "npm token",
    re: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
];

/**
 * Find secret-shaped substrings in `text`. The returned list is sorted
 * by `start` ascending and contains no overlapping spans (when two rules
 * overlap, the first match wins to keep replacement deterministic).
 */
export function findSecrets(text: string): SecretFinding[] {
  if (!text) return [];
  const raw: SecretFinding[] = [];
  for (const rule of RULES) {
    // Each call resets lastIndex implicitly because we construct fresh
    // RegExp state per-iteration by reading .exec on a copy via matchAll.
    for (const m of text.matchAll(rule.re)) {
      if (m.index == null) continue;
      const value = m[0];
      raw.push({
        rule: rule.id,
        label: rule.label,
        start: m.index,
        end: m.index + value.length,
        tail: value.slice(-4),
      });
    }
  }
  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  // De-overlap: drop any finding whose span overlaps a previously kept one.
  const kept: SecretFinding[] = [];
  let cursor = -1;
  for (const f of raw) {
    if (f.start < cursor) continue;
    kept.push(f);
    cursor = f.end;
  }
  return kept;
}

/**
 * Return `text` with every finding replaced by `[REDACTED:<rule>]`.
 * Findings must be the output of {@link findSecrets} on the same input
 * (i.e. already sorted and non-overlapping). The replacement length is
 * intentionally not padded to the original length: similarity scoring
 * normalizes whitespace and tokenizes on word boundaries, so a uniform
 * marker is what we want, not noise.
 */
export function redactSecrets(text: string, findings: SecretFinding[]): string {
  if (findings.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const f of findings) {
    if (f.start < cursor) continue;
    out += text.slice(cursor, f.start);
    out += `[REDACTED:${f.rule}]`;
    cursor = f.end;
  }
  out += text.slice(cursor);
  return out;
}

export interface ScanResult {
  mode: SecretScanMode;
  findings: SecretFinding[];
  /** Text the caller should hand to the similarity pipeline. */
  effectiveText: string;
  /** True when the policy says "stop the request" and findings exist. */
  blocked: boolean;
}

/**
 * Apply the workspace policy to a single piece of submitted text. See
 * SecretScanMode for semantics. When mode is "off" we don't even scan
 * (workspaces that opt out get zero added latency).
 */
export function applyPolicy(text: string, mode: SecretScanMode): ScanResult {
  if (mode === "off") {
    return { mode, findings: [], effectiveText: text, blocked: false };
  }
  const findings = findSecrets(text);
  if (findings.length === 0) {
    return { mode, findings, effectiveText: text, blocked: false };
  }
  if (mode === "block") {
    return { mode, findings, effectiveText: text, blocked: true };
  }
  if (mode === "redact") {
    return {
      mode,
      findings,
      effectiveText: redactSecrets(text, findings),
      blocked: false,
    };
  }
  // warn: pass through unchanged but surface the findings in the result
  return { mode, findings, effectiveText: text, blocked: false };
}

/** Public list of rule ids for the admin UI to enumerate. */
export function listRules(): Array<{ id: string; label: string }> {
  return RULES.map((r) => ({ id: r.id, label: r.label }));
}
