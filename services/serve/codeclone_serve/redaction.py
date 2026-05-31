"""Inbound PII and secret redaction for inference prompts.

Enterprise SOC2 / data-loss-prevention requirement: prompts that flow into a
hosted code model must not silently carry credentials (AWS keys, GitHub
tokens, JWTs, private keys) or directly-identifying personal data (emails,
IPv4 addresses) out of the customer's network. This module gives operators a
single place to declare the policy, applies it on every chat and completion
request, and emits an audit record per request with the per-category counts
so security teams can prove enforcement after the fact.

Modes
-----
* ``off``    do nothing (default; preserves legacy behaviour).
* ``redact`` rewrite the prompt in place with deterministic placeholders.
* ``block``  reject the request with HTTP 422 and a structured error body so
  the caller cannot retry-around the policy without first removing the
  secret.

Configuration (env, read via ``codeclone_config.settings``):

* ``CODECLONE_REDACT_POLICY``     default mode for every tenant.
* ``CODECLONE_REDACT_OVERRIDES``  CSV of ``tenant=mode`` overrides.

Both knobs are *additive*: an operator can ship the default ``off`` and roll
the policy out tenant-by-tenant without redeploying the service.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Iterable

# ---- public types -----------------------------------------------------------

VALID_MODES = ("off", "redact", "block")


@dataclass(frozen=True)
class Finding:
    """A single detected secret or PII span."""

    category: str
    count: int


@dataclass
class RedactionResult:
    """Outcome of applying the policy to a single text payload."""

    text: str
    findings: list[Finding] = field(default_factory=list)

    @property
    def total(self) -> int:
        return sum(f.count for f in self.findings)

    def summary(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for f in self.findings:
            out[f.category] = out.get(f.category, 0) + f.count
        return out


# ---- detectors --------------------------------------------------------------
#
# Order matters: longer / higher-confidence patterns run first so they "win"
# their character ranges before broader patterns like ``email`` see them. Each
# detector is conservative (anchored on a recognisable prefix or shape) to
# keep false-positive rates low on actual source code, which is what this
# service mostly sees.

_DETECTORS: list[tuple[str, re.Pattern[str], str]] = [
    # PEM-encoded private keys (RSA, EC, OpenSSH, generic).
    (
        "private_key",
        re.compile(
            r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY-----"
            r"[\s\S]+?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY-----"
        ),
        "[REDACTED_PRIVATE_KEY]",
    ),
    # AWS access key id (AKIA / ASIA) and 40-char secret access key that
    # follows an ``aws_secret`` / ``AWS_SECRET_ACCESS_KEY`` style assignment.
    (
        "aws_access_key_id",
        re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
        "[REDACTED_AWS_ACCESS_KEY_ID]",
    ),
    (
        "aws_secret_access_key",
        re.compile(
            r"(?i)aws(?:.{0,20})?(?:secret|sk)[\"'\s:=]{1,5}([A-Za-z0-9/+=]{40})"
        ),
        # We only redact the secret span (group 1); the surrounding key=
        # text is preserved so the prompt context still makes sense.
        "[REDACTED_AWS_SECRET]",
    ),
    # GitHub personal access tokens / fine-grained tokens / app tokens.
    (
        "github_token",
        re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{30,255}\b"),
        "[REDACTED_GITHUB_TOKEN]",
    ),
    # OpenAI / Anthropic / Slack-style prefixed keys.
    (
        "api_key_prefixed",
        re.compile(r"\b(?:sk-[A-Za-z0-9_\-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b"),
        "[REDACTED_API_KEY]",
    ),
    # Three-segment JWTs (header.payload.signature) with base64url segments.
    (
        "jwt",
        re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b"),
        "[REDACTED_JWT]",
    ),
    # Authorization: Bearer <token> headers pasted into prompts. Group 1 is
    # the token span.
    (
        "bearer_token",
        re.compile(r"(?i)(?:Authorization\s*:\s*)?Bearer\s+([A-Za-z0-9._\-]{20,})"),
        "Bearer [REDACTED_BEARER]",
    ),
    # Email addresses.
    (
        "email",
        re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"),
        "[REDACTED_EMAIL]",
    ),
    # IPv4 addresses, excluding the unspecified 0.0.0.0 placeholder so local
    # examples like ``--host 0.0.0.0`` don't trip the detector.
    (
        "ipv4",
        re.compile(
            r"\b(?!0\.0\.0\.0\b)"
            r"(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)"
            r"(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b"
        ),
        "[REDACTED_IPV4]",
    ),
]


def redact(text: str) -> RedactionResult:
    """Apply every detector in order, returning the rewritten text + findings.

    Detectors run sequentially so a later detector cannot re-match the
    placeholder text emitted by an earlier one (placeholders contain ``[``
    and capital letters which none of the detectors anchor on).
    """
    if not text:
        return RedactionResult(text=text or "")
    findings: list[Finding] = []
    current = text
    for category, pattern, placeholder in _DETECTORS:
        # Use a callable substitution so we can count matches without paying
        # for a second pass.
        count = 0

        def _sub(match: re.Match[str], _ph=placeholder) -> str:
            nonlocal count
            count += 1
            # If the detector exposed a capture group, only redact the
            # captured span and keep the prefix the operator wrote.
            if match.groups():
                start, end = match.span(1)
                whole_start, whole_end = match.span(0)
                prefix = match.string[whole_start:start]
                return prefix + _ph

            return _ph

        current = pattern.sub(_sub, current)
        if count:
            findings.append(Finding(category=category, count=count))
    return RedactionResult(text=current, findings=findings)


# ---- policy resolution ------------------------------------------------------


def parse_overrides(raw: str) -> dict[str, str]:
    """Parse ``tenant=mode`` CSV into a dict, raising on shape errors."""
    out: dict[str, str] = {}
    for entry in (raw or "").split(","):
        entry = entry.strip()
        if not entry:
            continue
        if "=" not in entry:
            raise ValueError(
                f"CODECLONE_REDACT_OVERRIDES entry missing '=': {entry!r}"
            )
        tenant, _, mode = entry.partition("=")
        tenant = tenant.strip()
        mode = mode.strip().lower()
        if not tenant:
            raise ValueError(
                f"CODECLONE_REDACT_OVERRIDES entry has empty tenant: {entry!r}"
            )
        if mode not in VALID_MODES:
            raise ValueError(
                f"CODECLONE_REDACT_OVERRIDES tenant {tenant!r} has invalid mode "
                f"{mode!r}; must be one of {VALID_MODES}"
            )
        out[tenant] = mode
    return out


@dataclass
class RedactionPolicy:
    """Resolved policy: default mode + per-tenant overrides."""

    default_mode: str = "off"
    overrides: dict[str, str] = field(default_factory=dict)

    def mode_for(self, tenant: str | None) -> str:
        if tenant and tenant in self.overrides:
            return self.overrides[tenant]
        return self.default_mode

    @property
    def enabled(self) -> bool:
        if self.default_mode != "off":
            return True
        return any(m != "off" for m in self.overrides.values())


def policy_from_env() -> RedactionPolicy:
    raw_default = (os.environ.get("CODECLONE_REDACT_POLICY") or "off").strip().lower()
    if raw_default not in VALID_MODES:
        raise ValueError(
            f"CODECLONE_REDACT_POLICY must be one of {VALID_MODES}, got {raw_default!r}"
        )
    overrides = parse_overrides(os.environ.get("CODECLONE_REDACT_OVERRIDES", ""))
    return RedactionPolicy(default_mode=raw_default, overrides=overrides)


# ---- enforcement helper -----------------------------------------------------


@dataclass
class EnforcementOutcome:
    """What the route handler should do next."""

    blocked: bool
    findings: list[Finding]
    summary: dict[str, int]
    # When ``blocked`` is False the caller substitutes these rewritten texts
    # back into the request payload before invoking the model.
    rewritten: list[str]


def enforce(texts: Iterable[str], mode: str) -> EnforcementOutcome:
    """Run the configured policy over every text and aggregate findings."""
    rewritten: list[str] = []
    agg: dict[str, int] = {}
    findings: list[Finding] = []
    if mode == "off":
        for t in texts:
            rewritten.append(t)
        return EnforcementOutcome(blocked=False, findings=[], summary={}, rewritten=rewritten)
    for t in texts:
        res = redact(t)
        rewritten.append(res.text)
        for f in res.findings:
            agg[f.category] = agg.get(f.category, 0) + f.count
    findings = [Finding(category=k, count=v) for k, v in sorted(agg.items())]
    blocked = mode == "block" and any(agg.values())
    return EnforcementOutcome(blocked=blocked, findings=findings, summary=agg, rewritten=rewritten)
