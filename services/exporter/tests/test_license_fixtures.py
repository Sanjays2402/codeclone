"""Tests driven by tests/fixtures/licenses."""

import json
from pathlib import Path

import pytest

from codeclone_exporter.license_filter import (
    LicenseCategory,
    detect_license,
    license_allowed,
)


def _licenses_dir() -> Path:
    return Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "licenses"


def _load_index() -> dict:
    return json.loads((_licenses_dir() / "INDEX.json").read_text())


@pytest.mark.parametrize("filename,expected", sorted(_load_index().items()))
def test_license_categorization_matches_index(filename, expected):
    text = (_licenses_dir() / filename).read_text()
    _, cat = detect_license(text)
    expected_cat = expected["category"]
    if expected_cat == "permissive":
        assert cat == LicenseCategory.PERMISSIVE
    elif expected_cat == "copyleft":
        assert cat == LicenseCategory.COPYLEFT
    else:
        assert cat == LicenseCategory.UNKNOWN


def test_filter_blocks_copyleft_in_strict_and_default():
    text = (_licenses_dir() / "gpl3.txt").read_text()
    _, cat = detect_license(text)
    assert cat == LicenseCategory.COPYLEFT
    assert not license_allowed(cat, "permissive_only")
    assert not license_allowed(cat, "strict")
    assert license_allowed(cat, "off")


def test_filter_off_allows_everything():
    for fname in _load_index():
        text = (_licenses_dir() / fname).read_text()
        _, cat = detect_license(text)
        assert license_allowed(cat, "off")
