"""High-level exporter: list repos, clone (shallow), iterate diffs, write JSONL."""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from codeclone_config.logging import get_logger
from codeclone_dataset.pairs import Pair, write_pairs, stats_for

from .author import AuthorFilter
from .diff import iter_authored_diffs, diff_to_pairs
from .github_api import GitHubClient, RepoSummary
from .license_filter import detect_repo_license


log = get_logger(__name__)


class ExportError(RuntimeError):
    pass


@dataclass
class ExportResult:
    out_path: Path
    n_repos: int
    n_commits: int
    n_pairs: int
    skipped_repos: list[str] = field(default_factory=list)
    by_language: dict[str, int] = field(default_factory=dict)


def _clone_shallow(clone_url: str, dest: Path, depth: int = 0) -> None:
    cmd = ["git", "clone", "--quiet"]
    if depth > 0:
        cmd += ["--depth", str(depth)]
    cmd += [clone_url, str(dest)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise ExportError(f"git clone failed: {proc.stderr.strip()}")


@dataclass
class Exporter:
    author: AuthorFilter
    workspace: Path
    out_path: Path
    languages: set[str]
    license_mode: str = "permissive_only"
    drop_secret_lines: bool = True
    max_files_per_commit: int = 64
    max_diff_lines: int = 4000
    min_lines: int = 3
    max_lines: int = 600
    keep_clones: bool = False
    clone_depth: int = 0  # 0 means full history (required to walk commits)
    include_forks: bool = False
    max_repos: int | None = None

    def run(
        self,
        user: str,
        client: GitHubClient | None = None,
        repos: list[RepoSummary] | None = None,
        primary_email_for_hash: str | None = None,
    ) -> ExportResult:
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.out_path.parent.mkdir(parents=True, exist_ok=True)

        if repos is None:
            if client is None:
                raise ExportError("either `repos` or `client` must be provided")
            repos = client.list_user_repos(
                user, include_forks=self.include_forks, max_repos=self.max_repos
            )
        log.info("exporter.start", user=user, n_repos=len(repos))

        # Pick a stable author email for the per-pair hash. Falls back to any
        # configured email; this is hashed before storage.
        if primary_email_for_hash is None:
            primary_email_for_hash = next(iter(self.author.emails), "") or ""

        all_pairs: list[Pair] = []
        skipped: list[str] = []
        n_commits = 0

        for repo in repos:
            if repo.archived:
                log.info("exporter.skip_archived", repo=repo.full_name)
                skipped.append(repo.full_name)
                continue
            if not repo.clone_url:
                skipped.append(repo.full_name)
                continue
            dest = self.workspace / repo.full_name.replace("/", "__")
            try:
                if dest.exists():
                    shutil.rmtree(dest)
                _clone_shallow(repo.clone_url, dest, depth=self.clone_depth)
                _, lic_cat = detect_repo_license(dest)
                got = 0
                for accept in iter_authored_diffs(
                    dest,
                    self.author,
                    languages=self.languages,
                    max_files_per_commit=self.max_files_per_commit,
                    max_diff_lines=self.max_diff_lines,
                    license_mode=self.license_mode,
                    repo_license_category=lic_cat,
                    drop_secret_lines=self.drop_secret_lines,
                    min_lines=self.min_lines,
                    max_lines=self.max_lines,
                    branch=repo.default_branch,
                ):
                    pairs = diff_to_pairs(repo.full_name, accept, primary_email_for_hash)
                    all_pairs.extend(pairs)
                    n_commits += 1
                    got += len(pairs)
                log.info("exporter.repo_done", repo=repo.full_name, pairs=got)
            except Exception as e:  # noqa: BLE001
                log.warning("exporter.repo_error", repo=repo.full_name, error=str(e))
                skipped.append(repo.full_name)
            finally:
                if not self.keep_clones and dest.exists():
                    shutil.rmtree(dest, ignore_errors=True)

        n_written = write_pairs(self.out_path, all_pairs)
        s = stats_for(self.out_path) if n_written else None
        by_lang = s.by_language if s else {}
        log.info(
            "exporter.done",
            n_repos=len(repos),
            n_pairs=n_written,
            n_commits=n_commits,
            out=str(self.out_path),
        )
        return ExportResult(
            out_path=self.out_path,
            n_repos=len(repos),
            n_commits=n_commits,
            n_pairs=n_written,
            skipped_repos=skipped,
            by_language=by_lang,
        )
