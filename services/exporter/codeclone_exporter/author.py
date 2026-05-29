"""Author filter primitives.

We never write raw emails to disk. Each pair carries a `author_email_hash`
that is a 16-hex-char prefix of sha256(lowercase(email)); this is enough to
prove provenance without leaking a useful identifier beyond what the public
commit page already shows.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass


_NOREPLY_RE = re.compile(r"^(?:\d+\+)?(?P<user>[a-z0-9-]+)@users\.noreply\.github\.com$")


def normalize_email(email: str | None) -> str:
    if not email:
        return ""
    return email.strip().lower()


def hash_email(email: str | None) -> str:
    norm = normalize_email(email)
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()[:16] if norm else ""


def noreply_user(email: str | None) -> str | None:
    norm = normalize_email(email)
    if not norm:
        return None
    m = _NOREPLY_RE.match(norm)
    if not m:
        return None
    return m.group("user")


@dataclass
class AuthorFilter:
    """Accepts a commit if its author matches any of the configured emails OR
    a configured GitHub username (via the noreply pattern).
    """

    emails: frozenset[str]
    usernames: frozenset[str] = frozenset()
    skip_merge: bool = True
    skip_revert: bool = True

    @classmethod
    def from_strings(
        cls,
        emails: list[str] | set[str],
        usernames: list[str] | set[str] | None = None,
        skip_merge: bool = True,
        skip_revert: bool = True,
    ) -> "AuthorFilter":
        norm_emails = frozenset(normalize_email(e) for e in emails if e)
        norm_users = frozenset((u or "").strip().lower() for u in (usernames or []) if u)
        return cls(
            emails=norm_emails,
            usernames=norm_users,
            skip_merge=skip_merge,
            skip_revert=skip_revert,
        )

    def matches(self, author_email: str | None) -> bool:
        norm = normalize_email(author_email)
        if not norm:
            return False
        if norm in self.emails:
            return True
        user = noreply_user(norm)
        if user and user in self.usernames:
            return True
        return False

    def accept_message(self, message: str) -> bool:
        m = message.strip()
        if self.skip_merge and m.lower().startswith("merge "):
            return False
        if self.skip_revert and m.lower().startswith('revert "'):
            return False
        return True
