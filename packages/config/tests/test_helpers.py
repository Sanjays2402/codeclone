"""Tests for fs / http / paths helpers."""

import json
from pathlib import Path

import httpx
import pytest

from codeclone_config.fs import atomic_write_text, ensure_dir, human_bytes
from codeclone_config.http_util import is_retryable, TransientError, parse_rate_limit_reset
from codeclone_exporter.paths import is_generated, filename_only


def test_atomic_write_text_roundtrip(tmp_path: Path):
    f = tmp_path / "deep" / "out.json"
    atomic_write_text(f, json.dumps({"k": 1}))
    assert json.loads(f.read_text()) == {"k": 1}


def test_atomic_write_text_overwrite(tmp_path: Path):
    f = tmp_path / "x.txt"
    atomic_write_text(f, "first")
    atomic_write_text(f, "second")
    assert f.read_text() == "second"


def test_ensure_dir_idempotent(tmp_path: Path):
    p = ensure_dir(tmp_path / "a" / "b")
    assert p.exists()
    ensure_dir(p)
    assert p.exists()


def test_human_bytes_units():
    assert "B" in human_bytes(500)
    assert "KiB" in human_bytes(2048)
    assert "MiB" in human_bytes(5 * 1024 * 1024)


def test_is_retryable_classifies():
    assert is_retryable(httpx.TimeoutException("x"))
    assert is_retryable(httpx.ConnectError("x"))
    assert is_retryable(TransientError("x"))
    # 500 -> retry
    req = httpx.Request("GET", "https://x")
    resp = httpx.Response(500, request=req)
    assert is_retryable(httpx.HTTPStatusError("oops", request=req, response=resp))
    # 400 -> no
    resp2 = httpx.Response(400, request=req)
    assert not is_retryable(httpx.HTTPStatusError("oops", request=req, response=resp2))


def test_parse_rate_limit_reset_zero_when_missing():
    assert parse_rate_limit_reset({}) == 0.0


def test_is_generated_patterns():
    assert is_generated("dist/x.js")
    assert is_generated("a/node_modules/lib.js")
    assert is_generated("foo.min.js")
    assert is_generated("yarn.lock")
    assert not is_generated("src/main.ts")


def test_filename_only():
    assert filename_only("/a/b/c.ts") == "c.ts"
