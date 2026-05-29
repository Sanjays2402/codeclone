from codeclone_exporter.author import AuthorFilter, hash_email, normalize_email, noreply_user
from codeclone_exporter.license_filter import (
    detect_license,
    license_allowed,
    LicenseCategory,
)
from codeclone_exporter.secret_scrub import has_secret, scrub_secrets


# ---------------- author ----------------


def test_normalize_email():
    assert normalize_email(" A@B.COM ") == "a@b.com"
    assert normalize_email(None) == ""


def test_hash_email_stable():
    h = hash_email("a@b.com")
    assert h == hash_email("A@B.COM")
    assert len(h) == 16


def test_noreply_user():
    assert noreply_user("123+sanjay@users.noreply.github.com") == "sanjay"
    assert noreply_user("sanjay@users.noreply.github.com") == "sanjay"
    assert noreply_user("foo@bar.com") is None


def test_author_filter_email_match():
    f = AuthorFilter.from_strings(emails=["a@b.com"])
    assert f.matches("A@B.COM")
    assert not f.matches("c@d.com")


def test_author_filter_username_via_noreply():
    f = AuthorFilter.from_strings(emails=[], usernames=["sanjays2402"])
    assert f.matches("123+SanjayS2402@users.noreply.github.com")
    assert not f.matches("attacker@evil.com")


def test_author_filter_message_filters():
    f = AuthorFilter.from_strings(emails=["a@b.com"])
    assert not f.accept_message("Merge pull request #1")
    assert not f.accept_message('Revert "feature: x"')
    assert f.accept_message("feat: real work")


# ---------------- license ----------------


def test_detect_spdx():
    spdx, cat = detect_license("// SPDX-License-Identifier: Apache-2.0\n")
    assert spdx == "Apache-2.0"
    assert cat == LicenseCategory.PERMISSIVE


def test_detect_name_hint_gpl():
    spdx, cat = detect_license("GNU GENERAL PUBLIC LICENSE\nVersion 3")
    assert cat == LicenseCategory.COPYLEFT


def test_license_allowed_permissive_only():
    assert license_allowed(LicenseCategory.PERMISSIVE)
    assert license_allowed(LicenseCategory.UNKNOWN)
    assert not license_allowed(LicenseCategory.COPYLEFT)


def test_license_allowed_strict():
    assert not license_allowed(LicenseCategory.UNKNOWN, "strict")
    assert license_allowed(LicenseCategory.PERMISSIVE, "strict")


def test_license_allowed_off():
    assert license_allowed(LicenseCategory.COPYLEFT, "off")


# ---------------- secret scrub ----------------


def test_has_secret_github_token():
    assert has_secret("token = ghp_" + "A" * 40)


def test_has_secret_openai():
    assert has_secret('OPENAI = "sk-' + "x" * 40 + '"')


def test_has_secret_aws():
    assert has_secret("aws AKIA" + "A" * 16)


def test_scrub_secrets_drops_lines():
    text = "ok\nsk-" + "x" * 40 + "\nalso ok\n"
    cleaned, dropped = scrub_secrets(text)
    assert dropped == 1
    assert "sk-" not in cleaned
    assert "ok" in cleaned and "also ok" in cleaned


def test_scrub_secrets_passes_clean():
    text = "def f():\n    return 1\n"
    cleaned, dropped = scrub_secrets(text)
    assert dropped == 0
    assert cleaned == text
