"""Diff -> training pair conversion.

Approach: for each authored commit, build per-file pairs where:
  prefix     = "# repo: ...\n# path: ...\n<pre-change snippet or context>\n"
  completion = "<the added lines for this file as a contiguous block>"

We avoid full-file dumps; we keep the additions because that is the user's
actual writing signal.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator

import git
from unidiff import PatchSet

from .author import AuthorFilter, hash_email
from .license_filter import (
    LicenseCategory,
    detect_license,
    license_allowed,
)
from .secret_scrub import scrub_secrets
from codeclone_dataset.pairs import Pair


_LANG_BY_EXT = {
    ".py": "py",
    ".pyi": "py",
    ".ts": "ts",
    ".tsx": "tsx",
    ".js": "js",
    ".jsx": "jsx",
    ".mjs": "js",
    ".cjs": "js",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
}

_GENERATED_PATTERNS = [
    re.compile(r"(^|/)(dist|build|out|node_modules|vendor|third_party)/"),
    re.compile(r"\.min\.(js|css)$"),
    re.compile(r"(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|Cargo\.lock|go\.sum)$"),
    re.compile(r"\.(map|snap|lock|bundle\.js)$"),
    re.compile(r"(^|/)__generated__/"),
]


def detect_language(path: str) -> str | None:
    ext = Path(path).suffix.lower()
    return _LANG_BY_EXT.get(ext)


def is_generated_path(path: str) -> bool:
    return any(p.search(path) for p in _GENERATED_PATTERNS)


@dataclass
class AcceptedHunk:
    path: str
    language: str
    added_text: str
    context_text: str


@dataclass
class DiffAccept:
    sha: str
    message_first_line: str
    files: list[AcceptedHunk]


def _hunk_added_text(hunk) -> str:
    return "\n".join(line.value.rstrip("\n") for line in hunk if line.is_added)


def _hunk_context_text(hunk) -> str:
    return "\n".join(line.value.rstrip("\n") for line in hunk if line.is_context)


def iter_authored_diffs(
    repo_path: str | Path,
    author: AuthorFilter,
    *,
    languages: set[str],
    max_files_per_commit: int = 64,
    max_diff_lines: int = 4000,
    license_mode: str = "permissive_only",
    repo_license_category: LicenseCategory = LicenseCategory.UNKNOWN,
    drop_secret_lines: bool = True,
    min_lines: int = 3,
    max_lines: int = 600,
    branch: str | None = None,
) -> Iterator[DiffAccept]:
    """Walk repo history and yield commits with the file-level accepted hunks."""
    repo = git.Repo(str(repo_path))
    try:
        commits: Iterable[git.Commit] = repo.iter_commits(rev=branch) if branch else repo.iter_commits()
    except git.GitCommandError:
        return

    for commit in commits:
        if len(commit.parents) > 1 and author.skip_merge:
            continue
        if not author.matches(commit.author.email):
            continue
        msg = (commit.message or "").strip()
        if not author.accept_message(msg):
            continue
        if not commit.parents:
            continue
        parent = commit.parents[0]
        try:
            diff_text = repo.git.diff(parent.hexsha, commit.hexsha, "--unified=3")
        except git.GitCommandError:
            continue
        if not diff_text:
            continue
        if diff_text.count("\n") > max_diff_lines:
            continue

        try:
            patches = PatchSet(diff_text)
        except Exception:
            continue

        accepted: list[AcceptedHunk] = []
        for pf in patches:
            if len(accepted) >= max_files_per_commit:
                break
            path = pf.path or pf.target_file or ""
            # unidiff already strips the a/ b/ prefix, but be tolerant.
            for prefix in ("a/", "b/"):
                if path.startswith(prefix):
                    path = path[len(prefix):]
            if not path or is_generated_path(path):
                continue
            lang = detect_language(path)
            if not lang or lang not in languages:
                continue
            # File-level license fallback to repo license; we don't have the
            # file text here (only diff), so use repo license category.
            if not license_allowed(repo_license_category, license_mode):
                continue
            for hunk in pf:
                added = _hunk_added_text(hunk)
                if not added.strip():
                    continue
                n_lines = added.count("\n") + 1
                if n_lines < min_lines or n_lines > max_lines:
                    continue
                if drop_secret_lines:
                    added, _ = scrub_secrets(added)
                    if not added.strip():
                        continue
                ctx = _hunk_context_text(hunk)
                accepted.append(
                    AcceptedHunk(
                        path=path,
                        language=lang,
                        added_text=added,
                        context_text=ctx,
                    )
                )
        if accepted:
            yield DiffAccept(
                sha=commit.hexsha,
                message_first_line=msg.splitlines()[0][:200],
                files=accepted,
            )


def diff_to_pairs(
    repo_full_name: str,
    accept: DiffAccept,
    author_email_for_hash: str,
) -> list[Pair]:
    """Materialize Pair rows from an accepted commit's file hunks."""
    out: list[Pair] = []
    author_hash = hash_email(author_email_for_hash)
    for i, f in enumerate(accept.files):
        prefix_parts = [
            f"# repo: {repo_full_name}",
            f"# path: {f.path}",
            f"# message: {accept.message_first_line}",
        ]
        if f.context_text.strip():
            prefix_parts.append(f.context_text.strip())
        prefix = "\n".join(prefix_parts) + "\n"
        pair = Pair(
            id=f"{accept.sha[:12]}-{i}",
            kind="completion",
            language=f.language,
            prefix=prefix,
            completion=f.added_text,
            repo=repo_full_name,
            commit_sha=accept.sha,
            path=f.path,
            author_email_hash=author_hash,
        )
        out.append(pair)
    return out
