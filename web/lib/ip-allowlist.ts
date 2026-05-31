/**
 * Workspace IP allowlist.
 *
 * Enterprise customers require the ability to restrict API + dashboard access
 * to a known set of corporate egress IPs. This module is the single source of
 * truth for parsing CIDR rules, matching a request's client IP against a
 * workspace's allowlist, and producing the structured 403 response.
 *
 * Storage: lives on WorkspaceRecord.ipAllowlist (string[] of CIDRs).
 * Empty / missing array means "no allowlist enforced" (open).
 *
 * Supports IPv4 and IPv6 in CIDR notation. A bare IP is treated as /32 (v4)
 * or /128 (v6). Loopback (127.0.0.1, ::1) is always permitted so that local
 * health checks and same-host tooling do not lock out the owner.
 */

export const MAX_CIDR_ENTRIES = 64;
export const MAX_CIDR_LEN = 64;

export interface ParsedCidr {
  family: 4 | 6;
  bytes: Uint8Array; // network address, normalised to family width
  prefix: number;   // mask length in bits
  source: string;   // original string (normalised)
}

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function parseIpv4(s: string): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i];
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIpv6(s: string): Uint8Array | null {
  // Handle IPv4-mapped IPv6 like ::ffff:1.2.3.4 by converting tail
  let str = s;
  const v4match = str.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4match) {
    const v4 = parseIpv4(v4match[2]);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    str = v4match[1] + hi + ":" + lo;
  }
  const sides = str.split("::");
  if (sides.length > 2) return null;
  const head = sides[0] ? sides[0].split(":") : [];
  const tail = sides.length === 2 && sides[1] ? sides[1].split(":") : [];
  if (sides.length === 1 && head.length !== 8) return null;
  const fillCount = 8 - head.length - tail.length;
  if (sides.length === 2 && fillCount < 0) return null;
  const groups = [
    ...head,
    ...Array.from({ length: sides.length === 2 ? fillCount : 0 }, () => "0"),
    ...tail,
  ];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i] || "0";
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    out[i * 2] = (n >> 8) & 0xff;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

export function parseCidr(input: unknown): ParsedCidr | null {
  if (typeof input !== "string") return null;
  const raw = input.trim().toLowerCase();
  if (!raw || raw.length > MAX_CIDR_LEN) return null;
  const slash = raw.indexOf("/");
  const ipPart = slash === -1 ? raw : raw.slice(0, slash);
  const prefixPart = slash === -1 ? null : raw.slice(slash + 1);

  if (ipPart.includes(":")) {
    const bytes = parseIpv6(ipPart);
    if (!bytes) return null;
    let prefix = 128;
    if (prefixPart !== null) {
      if (!/^\d{1,3}$/.test(prefixPart)) return null;
      prefix = Number(prefixPart);
      if (prefix < 0 || prefix > 128) return null;
    }
    return { family: 6, bytes: maskBytes(bytes, prefix), prefix, source: raw };
  }
  const bytes = parseIpv4(ipPart);
  if (!bytes) return null;
  let prefix = 32;
  if (prefixPart !== null) {
    if (!/^\d{1,3}$/.test(prefixPart)) return null;
    prefix = Number(prefixPart);
    if (prefix < 0 || prefix > 32) return null;
  }
  return { family: 4, bytes: maskBytes(bytes, prefix), prefix, source: raw };
}

function maskBytes(bytes: Uint8Array, prefix: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < out.length; i++) {
    const bit = i * 8;
    if (bit >= prefix) {
      out[i] = 0;
    } else if (bit + 8 > prefix) {
      const keep = prefix - bit;
      const mask = (0xff << (8 - keep)) & 0xff;
      out[i] = out[i] & mask;
    }
  }
  return out;
}

export function parseIp(input: string): { family: 4 | 6; bytes: Uint8Array } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Strip IPv6 zone id and brackets.
  const clean = trimmed.replace(/^\[/, "").replace(/]$/, "").split("%")[0];
  if (clean.includes(":")) {
    const bytes = parseIpv6(clean);
    if (!bytes) return null;
    return { family: 6, bytes };
  }
  const bytes = parseIpv4(clean);
  if (!bytes) return null;
  return { family: 4, bytes };
}

export function matchCidr(ip: string, cidrs: ParsedCidr[]): boolean {
  if (cidrs.length === 0) return true; // no rules => allow
  const parsed = parseIp(ip);
  if (!parsed) return false;
  for (const c of cidrs) {
    if (c.family !== parsed.family) continue;
    const masked = maskBytes(parsed.bytes, c.prefix);
    if (bytesEqual(masked, c.bytes)) return true;
  }
  return false;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Best-effort client IP extraction. Prefers x-forwarded-for (first hop),
 * falls back to x-real-ip. Used for both audit recording and allowlist
 * enforcement so the two stay consistent.
 */
export function clientIpFromRequest(req: Request): string | null {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) {
    const first = xf.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim().slice(0, 64);
  return null;
}

export interface AllowlistDecision {
  allowed: boolean;
  reason: "open" | "loopback" | "match" | "no_ip" | "blocked";
  ip: string | null;
  rules: number;
}

/**
 * Decide whether a request should be allowed for a workspace whose
 * ipAllowlist field is `entries`. Empty/missing => open. Loopback is
 * always permitted. Returns a structured decision the route can audit.
 */
export function evaluateAllowlist(
  req: Request,
  entries: string[] | undefined | null,
): AllowlistDecision {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) {
    return { allowed: true, reason: "open", ip: clientIpFromRequest(req), rules: 0 };
  }
  const ip = clientIpFromRequest(req);
  if (!ip) {
    // If we genuinely cannot identify the caller, deny when allowlist is set.
    return { allowed: false, reason: "no_ip", ip: null, rules: list.length };
  }
  if (isLoopback(ip)) {
    return { allowed: true, reason: "loopback", ip, rules: list.length };
  }
  const parsed: ParsedCidr[] = [];
  for (const e of list) {
    const p = parseCidr(e);
    if (p) parsed.push(p);
  }
  if (matchCidr(ip, parsed)) {
    return { allowed: true, reason: "match", ip, rules: parsed.length };
  }
  return { allowed: false, reason: "blocked", ip, rules: parsed.length };
}

/**
 * Per-API-key variant. Identical CIDR semantics to evaluateAllowlist, but
 * skips the loopback bypass: enterprise teams use per-key allowlists to
 * prove that a specific production credential ONLY works from a named
 * source network, and silently letting localhost through would defeat
 * that audit story. An empty/missing list still means open.
 */
export function evaluateKeyAllowlist(
  req: Request,
  entries: string[] | undefined | null,
): AllowlistDecision {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) {
    return { allowed: true, reason: "open", ip: clientIpFromRequest(req), rules: 0 };
  }
  const ip = clientIpFromRequest(req);
  if (!ip) {
    return { allowed: false, reason: "no_ip", ip: null, rules: list.length };
  }
  const parsed: ParsedCidr[] = [];
  for (const e of list) {
    const p = parseCidr(e);
    if (p) parsed.push(p);
  }
  if (matchCidr(ip, parsed)) {
    return { allowed: true, reason: "match", ip, rules: parsed.length };
  }
  return { allowed: false, reason: "blocked", ip, rules: parsed.length };
}

/**
 * Sanitise a user-submitted CIDR list. Dedupes, drops invalid entries,
 * preserves order, and caps at MAX_CIDR_ENTRIES. Returns the cleaned
 * list AND the set of rejected raw inputs so the UI can surface them.
 */
export function sanitizeCidrList(input: unknown): { ok: string[]; rejected: string[] } {
  const ok: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(input)) return { ok, rejected };
  for (const raw of input.slice(0, MAX_CIDR_ENTRIES * 2)) {
    if (typeof raw !== "string") {
      rejected.push(String(raw).slice(0, MAX_CIDR_LEN));
      continue;
    }
    const p = parseCidr(raw);
    if (!p) {
      rejected.push(raw.slice(0, MAX_CIDR_LEN));
      continue;
    }
    const norm = p.source;
    if (seen.has(norm)) continue;
    seen.add(norm);
    ok.push(norm);
    if (ok.length >= MAX_CIDR_ENTRIES) break;
  }
  return { ok, rejected };
}

