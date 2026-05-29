"""Line-level secret scrubbing.

Conservative: when in doubt, drop the line. Better to lose a few training rows
than push a token to a checkpoint.
"""

from __future__ import annotations

import re


_PATTERNS = [
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,255}\b"),               # GitHub tokens
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),                # GH fine-grained
    re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),                         # OpenAI-style keys
    re.compile(r"\bsk-ant-[A-Za-z0-9\-_]{20,}\b"),                  # Anthropic
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                            # AWS access key id
    re.compile(r"\baws_secret_access_key\b\s*=\s*['\"]?[A-Za-z0-9/+=]{30,}"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b"),  # JWT
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),                # Slack
    re.compile(r"\bAIza[0-9A-Za-z\-_]{35}\b"),                       # Google API
    re.compile(r"\bAC[a-z0-9]{32}\b"),                               # Twilio account SID
]


def has_secret(line: str) -> bool:
    return any(p.search(line) for p in _PATTERNS)


def scrub_secrets(text: str) -> tuple[str, int]:
    """Return (cleaned_text, dropped_line_count). Lines containing a secret
    are removed entirely.
    """
    out = []
    dropped = 0
    for line in text.splitlines():
        if has_secret(line):
            dropped += 1
            continue
        out.append(line)
    cleaned = "\n".join(out)
    if text.endswith("\n"):
        cleaned += "\n"
    return cleaned, dropped
