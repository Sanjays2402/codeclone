"""Verify the per-language code sample fixtures are well-formed and detected
by the language router.
"""

from pathlib import Path

import pytest

from codeclone_exporter.diff import detect_language


FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "code_samples"


@pytest.mark.parametrize(
    "lang_dir,ext,expected",
    [
        ("py", "py", "py"),
        ("ts", "ts", "ts"),
        ("js", "js", "js"),
        ("go", "go", "go"),
        ("rust", "rs", "rust"),
        ("java", "java", "java"),
    ],
)
def test_language_router_classifies_samples(lang_dir, ext, expected):
    d = FIXTURES / lang_dir
    files = sorted(d.glob(f"*.{ext}"))
    assert files, f"no fixtures in {d}"
    for f in files[:5]:
        lang = detect_language(str(f))
        assert lang == expected, f"{f} -> {lang}"


def test_all_sample_files_nonempty():
    files = list(FIXTURES.rglob("*"))
    code_files = [f for f in files if f.is_file()]
    assert len(code_files) >= 250, f"expected many sample files, got {len(code_files)}"
    for f in code_files:
        assert f.stat().st_size > 0, f"empty file: {f}"
