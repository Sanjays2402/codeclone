"""Tests for diff parsing edge cases."""

import subprocess
from pathlib import Path

import pytest

from codeclone_exporter.author import AuthorFilter
from codeclone_exporter.diff import iter_authored_diffs
from codeclone_exporter.license_filter import LicenseCategory


def _init_repo(path: Path, email: str = "me@example.com") -> None:
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", email], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Me"], cwd=path, check=True)


def _commit_all(path: Path, msg: str) -> None:
    subprocess.run(["git", "add", "-A"], cwd=path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", msg], cwd=path, check=True)


def test_skips_merge_commits(tmp_path: Path):
    repo = tmp_path / "r"
    repo.mkdir()
    _init_repo(repo)
    (repo / "a.py").write_text("def a(): return 1\n")
    _commit_all(repo, "init")
    subprocess.run(["git", "checkout", "-b", "feat", "-q"], cwd=repo, check=True)
    (repo / "a.py").write_text("def a():\n    return 1\n\ndef b():\n    return 2\n\ndef c():\n    return 3\n")
    _commit_all(repo, "add b/c")
    subprocess.run(["git", "checkout", "main", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "merge", "feat", "--no-ff", "-q", "-m", "Merge branch 'feat'"], cwd=repo, check=True)
    flt = AuthorFilter.from_strings(emails=["me@example.com"])
    out = list(iter_authored_diffs(repo, flt, languages={"py"}, repo_license_category=LicenseCategory.PERMISSIVE))
    # Merge commit must be skipped; the original commit on the feat branch is kept.
    shas = {o.sha for o in out}
    log_lines = subprocess.run(["git", "log", "--format=%H %s"], cwd=repo, capture_output=True, text=True).stdout.splitlines()
    merge_shas = {line.split()[0] for line in log_lines if " Merge " in line or line.startswith("Merge")}
    for s in merge_shas:
        assert s not in shas


def test_skips_revert_messages(tmp_path: Path):
    repo = tmp_path / "r"
    repo.mkdir()
    _init_repo(repo)
    (repo / "a.py").write_text("def a():\n    return 1\n\ndef b():\n    return 2\n\ndef c():\n    return 3\n")
    _commit_all(repo, "feat: add b")
    (repo / "a.py").write_text("def a():\n    return 1\n")
    _commit_all(repo, 'Revert "feat: add b"')
    flt = AuthorFilter.from_strings(emails=["me@example.com"])
    out = list(iter_authored_diffs(repo, flt, languages={"py"}, repo_license_category=LicenseCategory.PERMISSIVE))
    msgs = [o.message_first_line for o in out]
    assert not any(m.lower().startswith('revert "') for m in msgs)


def test_excludes_non_target_languages(tmp_path: Path):
    repo = tmp_path / "r"
    repo.mkdir()
    _init_repo(repo)
    (repo / "a.md").write_text("# hi\n")
    _commit_all(repo, "init readme")
    (repo / "a.md").write_text("# hi\n\nmore lines\nand more\nand more\n")
    _commit_all(repo, "expand readme")
    flt = AuthorFilter.from_strings(emails=["me@example.com"])
    out = list(iter_authored_diffs(repo, flt, languages={"py"}, repo_license_category=LicenseCategory.PERMISSIVE))
    assert out == []
