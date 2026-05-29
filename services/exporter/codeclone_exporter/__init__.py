"""GitHub commit exporter: clone repos, walk history, emit authored (prefix, completion) pairs."""

from .exporter import Exporter, ExportResult, ExportError
from .github_api import GitHubClient, RepoSummary
from .author import AuthorFilter, hash_email
from .diff import (
    iter_authored_diffs,
    diff_to_pairs,
    DiffAccept,
    AcceptedHunk,
    detect_language,
)
from .license_filter import (
    LicenseCategory,
    detect_license,
    license_allowed,
    SPDX_PERMISSIVE,
    SPDX_COPYLEFT,
)
from .secret_scrub import scrub_secrets, has_secret

__all__ = [
    "Exporter",
    "ExportResult",
    "ExportError",
    "GitHubClient",
    "RepoSummary",
    "AuthorFilter",
    "hash_email",
    "iter_authored_diffs",
    "diff_to_pairs",
    "DiffAccept",
    "AcceptedHunk",
    "detect_language",
    "LicenseCategory",
    "detect_license",
    "license_allowed",
    "SPDX_PERMISSIVE",
    "SPDX_COPYLEFT",
    "scrub_secrets",
    "has_secret",
]
