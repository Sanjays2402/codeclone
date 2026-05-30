"""Bearer API key auth with per-key scopes (RBAC).

Two configuration paths, used together:

1. ``CODECLONE_API_KEY`` (legacy single key). When set, this key is granted
   the wildcard scope ``*`` so existing deployments keep working unchanged.

2. ``CODECLONE_API_KEYS`` (multi key). Comma separated list of
   ``<key>:<scope>+<scope>[@<tenant>]`` entries. Example:

       CODECLONE_API_KEYS=sk-ci-ro:models:read+infer@acme,sk-admin:*

   The scope token list after the first ``:`` is split on ``+``. A literal
   ``*`` means all scopes (admin). The optional ``@<tenant>`` suffix binds
   the key to a tenant id; when omitted the tenant defaults to ``default``.
   Whitespace around entries is ignored. Tenant ids must be lowercase
   ``[a-z0-9][a-z0-9-]{0,62}`` so they are safe to embed in metric labels,
   log fields, and storage keys.

The :class:`Principal` returned to handlers also carries the resolved tenant
so downstream code (audit log, rate limiter, GDPR endpoints) can enforce
tenant scoping without re-parsing the keyring.

Route handlers protect themselves with ``Depends(require_scope("infer"))``.
The dependency returns a :class:`Principal` with the matched key fingerprint
and granted scopes so handlers and audit can inspect who acted.

Backward compatible: routes that only need authentication can still use
``Depends(verify_api_key)`` which accepts any valid key regardless of scope.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field

from codeclone_config.settings import get_settings
from fastapi import Header, HTTPException, Request, status

# Scopes recognised by the service. Kept small on purpose: extend only when a
# new protected route lands. ``*`` is the implicit wildcard granted to the
# legacy single key and to entries that pass ``*`` in CODECLONE_API_KEYS.
KNOWN_SCOPES = frozenset({"models:read", "infer", "admin"})
WILDCARD_SCOPE = "*"

# Default tenant for the legacy single-key path and for multi-key entries
# that do not specify an ``@tenant`` suffix. Treating untagged keys as
# ``default`` keeps backward compatibility while still giving every audit row
# and rate-limit bucket a non-empty tenant id to key off.
DEFAULT_TENANT = "default"

# Lowercase DNS-label-ish ids. We deliberately reject mixed case and weird
# punctuation so a tenant id survives unchanged through Prometheus label
# names, structlog fields, filenames, and Postgres identifiers.
_TENANT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")


def _validate_tenant(tenant: str) -> str:
    if not _TENANT_RE.match(tenant):
        raise ValueError(
            f"invalid tenant id {tenant!r}; must match {_TENANT_RE.pattern}"
        )
    return tenant


@dataclass(frozen=True)
class Principal:
    """The authenticated caller for one request."""

    fingerprint: str  # sha256[:12] of the raw key, prefixed with "key:"
    scopes: frozenset[str]
    tenant: str = DEFAULT_TENANT

    def has_scope(self, required: str) -> bool:
        return WILDCARD_SCOPE in self.scopes or required in self.scopes

    def is_admin(self) -> bool:
        return WILDCARD_SCOPE in self.scopes or "admin" in self.scopes


@dataclass
class _KeyRecord:
    raw: str
    scopes: frozenset[str]
    tenant: str = DEFAULT_TENANT
    fingerprint: str = field(init=False)

    def __post_init__(self) -> None:
        digest = hashlib.sha256(self.raw.encode("utf-8")).hexdigest()
        object.__setattr__(self, "fingerprint", f"key:{digest[:12]}")


def _parse_multi(raw: str) -> list[_KeyRecord]:
    """Parse the ``CODECLONE_API_KEYS`` CSV format.

    Format: ``key1:scope+scope[@tenant],key2:*[@tenant]``. Empty entries are
    skipped. Entries without a scope segment are rejected so a misconfigured
    env does not silently grant a key zero permissions. The optional
    ``@tenant`` suffix binds the key to a tenant id; omit it to inherit the
    :data:`DEFAULT_TENANT`.
    """
    out: list[_KeyRecord] = []
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if ":" not in entry:
            raise ValueError(
                f"CODECLONE_API_KEYS entry missing scope segment: {entry!r}; "
                "use 'key:scope+scope[@tenant]' or 'key:*[@tenant]'"
            )
        key, _, rest = entry.partition(":")
        key = key.strip()
        rest = rest.strip()
        if not key or not rest:
            raise ValueError(
                f"CODECLONE_API_KEYS entry has empty key or scope: {entry!r}"
            )
        # Split the optional ``@tenant`` suffix off the scopes segment. The
        # ``@`` is reserved; it cannot appear in scope tokens, so a single
        # rsplit is unambiguous.
        if "@" in rest:
            scopes_part, _, tenant_part = rest.rpartition("@")
            scopes_part = scopes_part.strip()
            tenant_part = tenant_part.strip()
            if not scopes_part or not tenant_part:
                raise ValueError(
                    f"CODECLONE_API_KEYS entry has empty scope or tenant: {entry!r}"
                )
            try:
                tenant = _validate_tenant(tenant_part)
            except ValueError as exc:
                raise ValueError(
                    f"CODECLONE_API_KEYS entry {key[:8]}... has {exc}"
                ) from None
        else:
            scopes_part = rest
            tenant = DEFAULT_TENANT
        scope_tokens = [s.strip() for s in scopes_part.split("+") if s.strip()]
        if not scope_tokens:
            raise ValueError(f"CODECLONE_API_KEYS entry has no scopes: {entry!r}")
        for tok in scope_tokens:
            if tok != WILDCARD_SCOPE and tok not in KNOWN_SCOPES:
                raise ValueError(
                    f"CODECLONE_API_KEYS entry {key[:8]}... has unknown scope {tok!r}; "
                    f"known scopes: {[*sorted(KNOWN_SCOPES), WILDCARD_SCOPE]}"
                )
        out.append(
            _KeyRecord(raw=key, scopes=frozenset(scope_tokens), tenant=tenant)
        )
    return out


def _build_keyring() -> dict[str, _KeyRecord]:
    """Resolve the active key set from settings.

    The legacy ``CODECLONE_API_KEY`` (when non-empty) is always included with
    wildcard scope so existing deployments keep working without edits.
    """
    s = get_settings()
    ring: dict[str, _KeyRecord] = {}
    if s.api_keys:
        for rec in _parse_multi(s.api_keys):
            ring[rec.raw] = rec
    legacy = s.api_key
    if legacy:
        # Legacy key always gets wildcard so existing scripts keep working.
        # It is bound to DEFAULT_TENANT; operators wanting per-tenant keys
        # should migrate to CODECLONE_API_KEYS with the @tenant suffix.
        ring.setdefault(
            legacy,
            _KeyRecord(
                raw=legacy,
                scopes=frozenset({WILDCARD_SCOPE}),
                tenant=DEFAULT_TENANT,
            ),
        )
    return ring


def _extract_bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    token = authorization.strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    return token or None


def _lookup_principal(token: str | None) -> Principal:
    if token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )
    ring = _build_keyring()
    rec = ring.get(token)
    if rec is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid api key",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return Principal(
        fingerprint=rec.fingerprint, scopes=rec.scopes, tenant=rec.tenant
    )


def verify_api_key(
    request: Request,
    authorization: str | None = Header(default=None),
) -> Principal:
    """Authenticate the bearer token and return the matching :class:`Principal`.

    Stashes the principal on ``request.state.principal`` so middlewares (audit)
    can read who acted without re-parsing the header. The tenant id is also
    surfaced on ``request.state.tenant`` for fast access from handlers and
    downstream middleware (audit, rate limit).
    """
    principal = _lookup_principal(_extract_bearer(authorization))
    request.state.principal = principal
    request.state.tenant = principal.tenant
    return principal


def require_scope(scope: str):
    """FastAPI dependency factory enforcing a single scope.

    Usage::

        @app.post("/v1/chat/completions",
                  dependencies=[Depends(require_scope("infer"))])
    """
    if scope != WILDCARD_SCOPE and scope not in KNOWN_SCOPES:
        raise ValueError(f"require_scope: unknown scope {scope!r}")

    def _dep(
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> Principal:
        principal = _lookup_principal(_extract_bearer(authorization))
        request.state.principal = principal
        request.state.tenant = principal.tenant
        if not principal.has_scope(scope):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"missing required scope: {scope}",
            )
        return principal

    return _dep
