"""Per-tenant IP allowlist enforcement for the CodeClone serve API.

Enterprise buyers routinely require that production credentials only work
from a known set of source networks (corporate egress IPs, a VPC NAT, a
bastion host). This middleware enforces that policy at the edge of the
service, before any handler runs.

Configuration lives in :data:`codeclone_config.settings.Settings.ip_allowlist`
(env ``CODECLONE_IP_ALLOWLIST``). The format is a CSV of
``tenant=cidr1+cidr2[,tenant2=cidr]`` entries. The literal value ``*`` on the
right-hand side declares an explicit "any source" policy, which is useful
when an operator wants the audit trail to show that the open policy was
intentional rather than a missing configuration. Tenants with no entry at all
are unrestricted, so existing single-tenant deployments keep working
unchanged.

The middleware runs after :class:`RateLimitMiddleware` so that flood traffic
is throttled before we spend cycles parsing CIDRs, but before any route
handler. It reuses the same ``trust_forwarded`` setting and the same
``EXEMPT_PATHS`` (health probes and ``/metrics``) so an operator can never
accidentally cut a Kubernetes kubelet or Prometheus scraper out of the pod.

Rejected requests return HTTP 403 with a small JSON body identifying the
tenant and source IP so the security team can correlate the denial against
the audit log without leaking other tenants' policies.
"""

from __future__ import annotations

import ipaddress
import threading
from collections.abc import Iterable
from dataclasses import dataclass

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from .ratelimit import EXEMPT_PATHS, _api_key, _client_ip, _tenant_for_key

# Right-hand-side token meaning "any source IP is acceptable for this
# tenant". We still record the tenant in the parsed policy so audit consumers
# can distinguish "open by policy" from "open by omission".
WILDCARD = "*"

_Network = ipaddress.IPv4Network | ipaddress.IPv6Network


@dataclass(frozen=True)
class TenantPolicy:
    """Resolved per-tenant policy.

    ``networks`` is empty when the tenant declared the wildcard policy, in
    which case :attr:`allow_any` is ``True``. The two fields are kept
    separate so an empty network list does not silently fall through to
    "allow any" by accident.
    """

    tenant: str
    networks: tuple[_Network, ...]
    allow_any: bool = False

    def permits(self, ip: str) -> bool:
        if self.allow_any:
            return True
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            # Unparseable client IP (e.g. ``unknown``) is never permitted
            # against a non-wildcard policy. Refuse closed.
            return False
        return any(addr in net for net in self.networks)


def parse_policy(raw: str) -> dict[str, TenantPolicy]:
    """Parse ``CODECLONE_IP_ALLOWLIST`` into a tenant -> policy mapping.

    Format: ``tenant=cidr+cidr[,tenant2=*]``. Empty entries are skipped.
    Whitespace around tokens is ignored. Invalid CIDRs raise
    :class:`ValueError` so a misconfigured env fails the process at startup
    rather than silently allowing all traffic.
    """
    out: dict[str, TenantPolicy] = {}
    for entry in (raw or "").split(","):
        entry = entry.strip()
        if not entry:
            continue
        if "=" not in entry:
            raise ValueError(
                f"ip_allowlist entry missing '=': {entry!r}; "
                "use 'tenant=cidr+cidr' or 'tenant=*'"
            )
        tenant, _, rhs = entry.partition("=")
        tenant = tenant.strip()
        rhs = rhs.strip()
        if not tenant or not rhs:
            raise ValueError(
                f"ip_allowlist entry has empty tenant or cidr: {entry!r}"
            )
        tokens = [t.strip() for t in rhs.split("+") if t.strip()]
        if not tokens:
            raise ValueError(f"ip_allowlist entry has no cidrs: {entry!r}")
        if tokens == [WILDCARD]:
            out[tenant] = TenantPolicy(tenant=tenant, networks=(), allow_any=True)
            continue
        nets: list[_Network] = []
        for tok in tokens:
            if tok == WILDCARD:
                raise ValueError(
                    f"ip_allowlist tenant {tenant!r}: wildcard '*' must be "
                    "the only entry; remove the other CIDRs or drop '*'"
                )
            try:
                nets.append(ipaddress.ip_network(tok, strict=False))
            except ValueError as exc:
                raise ValueError(
                    f"ip_allowlist tenant {tenant!r}: invalid CIDR {tok!r}: {exc}"
                ) from None
        out[tenant] = TenantPolicy(tenant=tenant, networks=tuple(nets))
    return out


class IpAllowlistMiddleware(BaseHTTPMiddleware):
    """Reject requests whose authenticated tenant forbids the source IP.

    The middleware is a no-op when no tenant policy is configured, so it is
    safe to install unconditionally. When a request authenticates as a
    tenant that has at least one CIDR (or wildcard) configured and the
    source IP does not fall inside any listed network, the request is
    rejected with HTTP 403 before reaching the route handler.

    Anonymous traffic (no Authorization header, or an unknown bearer token)
    is never gated by this middleware. Unauthenticated callers cannot
    associate with a tenant, so the policy has no opinion. The auth
    dependency on the protected route still rejects them with 401/403.
    """

    def __init__(
        self,
        app,
        *,
        policy: dict[str, TenantPolicy],
        trust_forwarded: bool = False,
        exempt: Iterable[str] = EXEMPT_PATHS,
    ) -> None:
        super().__init__(app)
        self._policy = dict(policy)
        self.trust_forwarded = trust_forwarded
        self.exempt = frozenset(exempt)
        # Cheap re-entrant guard for future hot-reload support. The dict is
        # only mutated through :meth:`replace_policy`.
        self._lock = threading.Lock()

    def replace_policy(self, policy: dict[str, TenantPolicy]) -> None:
        with self._lock:
            self._policy = dict(policy)

    def policy_for(self, tenant: str | None) -> TenantPolicy | None:
        if tenant is None:
            return None
        return self._policy.get(tenant)

    async def dispatch(self, request: Request, call_next):
        if request.url.path in self.exempt:
            return await call_next(request)

        key = _api_key(request)
        tenant = _tenant_for_key(key)
        policy = self.policy_for(tenant)
        if policy is None:
            return await call_next(request)

        ip = _client_ip(request, self.trust_forwarded)
        if not policy.permits(ip):
            return JSONResponse(
                status_code=403,
                content={
                    "error": {
                        "type": "ip_not_allowed",
                        "message": (
                            f"source ip {ip} is not in the allowlist for "
                            f"tenant {tenant}"
                        ),
                        "tenant": tenant,
                        "source_ip": ip,
                    }
                },
            )
        return await call_next(request)
