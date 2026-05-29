import subprocess
from pathlib import Path

import pytest

from codeclone_exporter.author import AuthorFilter
from codeclone_exporter.diff import iter_authored_diffs, diff_to_pairs
from codeclone_exporter.license_filter import LicenseCategory


def _git(repo: Path, *args: str, env: dict | None = None) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, env=env)


def _setup_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "r"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "me@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Me"], cwd=repo, check=True)
    (repo / "a.py").write_text("def a():\n    return 1\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "first")
    (repo / "a.py").write_text("def a():\n    return 1\n\ndef b():\n    return 2\n\ndef c():\n    return 3\n\ndef d():\n    return 4\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "feat: add b")
    return repo


def test_iter_authored_diffs_basic(tmp_path: Path):
    repo = _setup_repo(tmp_path)
    flt = AuthorFilter.from_strings(emails=["me@example.com"])
    out = list(
        iter_authored_diffs(
            repo,
            flt,
            languages={"py"},
            repo_license_category=LicenseCategory.PERMISSIVE,
        )
    )
    assert out, "expected at least one accepted commit"
    accept = out[0]
    assert accept.files
    assert accept.files[0].language == "py"
    pairs = diff_to_pairs("me/r", accept, "me@example.com")
    assert pairs
    assert pairs[0].language == "py"
    assert "def b" in pairs[0].completion


def test_author_mismatch_excludes(tmp_path: Path):
    repo = _setup_repo(tmp_path)
    flt = AuthorFilter.from_strings(emails=["other@example.com"])
    out = list(
        iter_authored_diffs(
            repo,
            flt,
            languages={"py"},
            repo_license_category=LicenseCategory.PERMISSIVE,
        )
    )
    assert out == []
