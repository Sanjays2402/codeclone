/**
 * OIDC SSO for codeclone workspaces.
 *
 * Each workspace owner can wire one OIDC provider (Google Workspace, Okta,
 * Azure AD, Auth0, ...) by setting issuer + clientId + clientSecret +
 * allowedDomain on the workspace record. When `enforced` is true, magic-link
 * sign-in is blocked for any email whose domain matches the configured
 * allowedDomain on any workspace, forcing those users through SSO.
 *
 * Authorization Code + PKCE. State is stored in an HttpOnly cookie that
 * pins the workspace id, the PKCE verifier, and the post-login redirect.
 * Discovery documents and JWKS are fetched lazily and cached in-memory for
 * an hour to keep callbacks fast.
 *
 * Token validation uses crypto.createVerify against the discovered JWKS.
 * RS256 and ES256 are accepted; HS256 is rejected (a known OIDC pitfall).
 */
import crypto from "node:crypto";
import {
  listWorkspaces,
  getWorkspace,
  type WorkspaceRecord,
} from "./workspaces.ts";

export const SSO_STATE_COOKIE = "cc_sso_state";
export const SSO_STATE_TTL_SEC = 60 * 10; // 10 minutes

export interface SsoStateClaims {
  wsId: string;
  verifier: string;     // PKCE verifier
  nonce: string;
  redirect: string;     // post-login path
  iat: number;
  exp: number;
}

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
}

interface CacheEntry<T> { value: T; expiresAt: number }
const discoveryCache = new Map<string, CacheEntry<OidcDiscovery>>();
const jwksCache = new Map<string, CacheEntry<JsonWebKey[]>>();
const CACHE_TTL_MS = 60 * 60 * 1000;

function getStateSecret(): string {
  return process.env.CODECLONE_AUTH_SECRET || "codeclone-dev-secret-not-for-production";
}

export function normalizeIssuer(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  let u: URL;
  try { u = new URL(trimmed); } catch { return null; }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "localhost")) {
    return null;
  }
  // Strip trailing slash for stable lookups.
  return u.toString().replace(/\/$/, "");
}

export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const v = input.trim().toLowerCase().replace(/^@/, "");
  if (v.length < 3 || v.length > 253) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return null;
  return v;
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * Find a workspace whose enforced SSO policy claims the given email domain.
 * Returns the first match. O(n) over workspaces; fine for the FS-backed
 * datastore the rest of the app uses.
 */
export async function findEnforcedSsoForEmail(email: string): Promise<WorkspaceRecord | null> {
  const dom = emailDomain(email);
  if (!dom) return null;
  const all = await listWorkspaces();
  for (const ws of all) {
    if (ws.sso && ws.sso.enforced && ws.sso.allowedDomain === dom) return ws;
  }
  return null;
}

/**
 * Find a workspace that requires this *user* to sign in via SSO. This is
 * the superset of `findEnforcedSsoForEmail` plus a membership check, so
 * a contractor invited from a different email domain into an SSO-enforced
 * workspace is still funneled through the IdP. Also defends against the
 * race where SSO enforcement is toggled on after a magic link was issued.
 *
 * Order of preference for the returned workspace:
 *   1) one that matches the email domain (the most specific claim);
 *   2) any workspace the user is an active member of with sso.enforced=true.
 */
export async function findEnforcedSsoForUser(opts: {
  userId?: string | null;
  email: string;
}): Promise<WorkspaceRecord | null> {
  const dom = emailDomain(opts.email);
  const all = await listWorkspaces();
  // Pass 1: domain-claim match (most specific).
  if (dom) {
    for (const ws of all) {
      if (ws.sso && ws.sso.enforced && ws.sso.allowedDomain === dom) return ws;
    }
  }
  // Pass 2: existing-membership match for contractors / cross-domain members.
  if (opts.userId) {
    const { getActiveMember } = await import("./workspaces.ts");
    for (const ws of all) {
      if (!ws.sso || !ws.sso.enforced) continue;
      if (getActiveMember(ws, opts.userId)) return ws;
    }
  }
  return null;
}

/** Workspace SSO config as exposed to API consumers (clientSecret redacted). */
export function publicSsoConfig(ws: WorkspaceRecord) {
  if (!ws.sso) return null;
  return {
    provider: ws.sso.provider,
    issuer: ws.sso.issuer,
    clientId: ws.sso.clientId,
    clientSecretSet: Boolean(ws.sso.clientSecret),
    allowedDomain: ws.sso.allowedDomain,
    enforced: ws.sso.enforced,
    updatedAt: ws.sso.updatedAt,
    updatedBy: ws.sso.updatedBy,
    groupClaim: ws.sso.groupClaim ?? "",
    groupMappings: Array.isArray(ws.sso.groupMappings)
      ? ws.sso.groupMappings.map((m) => ({ group: m.group, role: m.role }))
      : [],
    groupsUpdatedAt: ws.sso.groupsUpdatedAt ?? null,
    groupsUpdatedBy: ws.sso.groupsUpdatedBy ?? null,
  };
}

// ---------- PKCE ----------

export function makePkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ---------- Signed state cookie ----------

function sign(body: string): string {
  return crypto.createHmac("sha256", getStateSecret()).update(body).digest("base64url");
}
function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function signState(claims: SsoStateClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyState(token: string | undefined | null): SsoStateClaims | null {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".", 2);
  if (!body || !sig) return null;
  if (!safeEq(sig, sign(body))) return null;
  let payload: SsoStateClaims;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
  catch { return null; }
  if (!payload || typeof payload.wsId !== "string" || typeof payload.exp !== "number") return null;
  if (Math.floor(Date.now() / 1000) >= payload.exp) return null;
  return payload;
}

export function stateCookieAttributes(maxAgeSec = SSO_STATE_TTL_SEC): string {
  const parts = [`Path=/`, `Max-Age=${maxAgeSec}`, `HttpOnly`, `SameSite=Lax`];
  if (process.env.CODECLONE_COOKIE_SECURE === "1") parts.push("Secure");
  return parts.join("; ");
}

export function clearedStateCookie(): string {
  const parts = [`Path=/`, `Max-Age=0`, `HttpOnly`, `SameSite=Lax`];
  if (process.env.CODECLONE_COOKIE_SECURE === "1") parts.push("Secure");
  return parts.join("; ");
}

// ---------- Discovery + JWKS ----------

export async function discover(issuer: string): Promise<OidcDiscovery> {
  const now = Date.now();
  const cached = discoveryCache.get(issuer);
  if (cached && cached.expiresAt > now) return cached.value;
  const url = issuer.replace(/\/$/, "") + "/.well-known/openid-configuration";
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`discovery_failed:${res.status}`);
  const doc = (await res.json()) as OidcDiscovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error("discovery_incomplete");
  }
  discoveryCache.set(issuer, { value: doc, expiresAt: now + CACHE_TTL_MS });
  return doc;
}

interface JwksResponse { keys: JsonWebKey[] }

export async function fetchJwks(jwksUri: string): Promise<JsonWebKey[]> {
  const now = Date.now();
  const cached = jwksCache.get(jwksUri);
  if (cached && cached.expiresAt > now) return cached.value;
  const res = await fetch(jwksUri, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`jwks_failed:${res.status}`);
  const doc = (await res.json()) as JwksResponse;
  if (!Array.isArray(doc.keys)) throw new Error("jwks_invalid");
  jwksCache.set(jwksUri, { value: doc.keys, expiresAt: now + CACHE_TTL_MS });
  return doc.keys;
}

// ---------- ID token verification ----------

export interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  hd?: string; // Google hosted domain
  [k: string]: unknown;
}

export async function verifyIdToken(
  idToken: string,
  expect: { issuer: string; clientId: string; nonce: string },
): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("idtoken_malformed");
  const [h64, p64, s64] = parts;
  const header = JSON.parse(Buffer.from(h64, "base64url").toString("utf8")) as { alg: string; kid?: string };
  if (!header.alg || header.alg === "none" || header.alg === "HS256") {
    throw new Error("idtoken_bad_alg");
  }
  const claims = JSON.parse(Buffer.from(p64, "base64url").toString("utf8")) as IdTokenClaims;

  // Standard OIDC claim checks.
  const expectedIssuer = expect.issuer.replace(/\/$/, "");
  const gotIssuer = String(claims.iss || "").replace(/\/$/, "");
  if (gotIssuer !== expectedIssuer) throw new Error("idtoken_bad_issuer");
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(expect.clientId)) throw new Error("idtoken_bad_aud");
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || now >= claims.exp) throw new Error("idtoken_expired");
  if (claims.nonce !== expect.nonce) throw new Error("idtoken_bad_nonce");

  // Signature: locate the JWK by kid in the discovery JWKS.
  const disc = await discover(expectedIssuer);
  const keys = await fetchJwks(disc.jwks_uri);
  const jwk = keys.find((k) => (k as { kid?: string }).kid === header.kid) ?? keys[0];
  if (!jwk) throw new Error("idtoken_no_key");
  const keyObj = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
  const signingInput = `${h64}.${p64}`;
  const sigBuf = Buffer.from(s64, "base64url");
  let ok = false;
  if (header.alg === "RS256") {
    ok = crypto.verify("RSA-SHA256", Buffer.from(signingInput), keyObj, sigBuf);
  } else if (header.alg === "ES256") {
    // Convert raw r||s to DER for OpenSSL.
    if (sigBuf.length !== 64) throw new Error("idtoken_bad_es256_sig");
    const r = sigBuf.subarray(0, 32);
    const s = sigBuf.subarray(32, 64);
    const der = encodeEcdsaDer(r, s);
    ok = crypto.verify("SHA256", Buffer.from(signingInput), keyObj, der);
  } else {
    throw new Error("idtoken_unsupported_alg");
  }
  if (!ok) throw new Error("idtoken_bad_signature");
  return claims;
}

function encodeEcdsaDer(r: Buffer, s: Buffer): Buffer {
  function trim(b: Buffer): Buffer {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let out = b.subarray(i);
    if (out[0] & 0x80) out = Buffer.concat([Buffer.from([0]), out]);
    return out;
  }
  const rt = trim(r); const st = trim(s);
  const seq = Buffer.concat([
    Buffer.from([0x02, rt.length]), rt,
    Buffer.from([0x02, st.length]), st,
  ]);
  return Buffer.concat([Buffer.from([0x30, seq.length]), seq]);
}

// ---------- Helpers exported for routes ----------

export async function getWorkspaceForSso(id: string): Promise<WorkspaceRecord | null> {
  if (!/^ws_[A-Za-z0-9_-]{4,40}$/.test(id)) return null;
  return getWorkspace(id);
}
