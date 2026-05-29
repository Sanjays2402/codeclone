"""SPDX-style license filter for source files."""

from __future__ import annotations

import re
from enum import Enum
from pathlib import Path
from typing import Iterable


SPDX_PERMISSIVE: frozenset[str] = frozenset(
    {
        "MIT",
        "MIT-0",
        "Apache-2.0",
        "Apache-1.1",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "BSD-3-Clause-Clear",
        "ISC",
        "MPL-2.0",
        "0BSD",
        "Zlib",
        "Unlicense",
        "CC0-1.0",
        "Python-2.0",
    }
)

SPDX_COPYLEFT: frozenset[str] = frozenset(
    {
        "GPL-2.0",
        "GPL-2.0-only",
        "GPL-2.0-or-later",
        "GPL-3.0",
        "GPL-3.0-only",
        "GPL-3.0-or-later",
        "LGPL-2.1",
        "LGPL-2.1-only",
        "LGPL-2.1-or-later",
        "LGPL-3.0",
        "LGPL-3.0-only",
        "LGPL-3.0-or-later",
        "AGPL-3.0",
        "AGPL-3.0-only",
        "AGPL-3.0-or-later",
        "SSPL-1.0",
        "BUSL-1.1",
        "Commons-Clause",
    }
)


class LicenseCategory(str, Enum):
    PERMISSIVE = "permissive"
    COPYLEFT = "copyleft"
    UNKNOWN = "unknown"


_SPDX_RE = re.compile(r"SPDX-License-Identifier:\s*([A-Za-z0-9\.\+\-]+)")
_NAME_HINTS = {
    "gnu general public license": "GPL-3.0",
    "gnu lesser general public license": "LGPL-3.0",
    "gnu affero general public license": "AGPL-3.0",
    "gpl-3": "GPL-3.0",
    "gpl-2": "GPL-2.0",
    "lgpl": "LGPL-3.0",
    "agpl": "AGPL-3.0",
    "mit license": "MIT",
    "apache license": "Apache-2.0",
    "bsd 3-clause": "BSD-3-Clause",
    "bsd 2-clause": "BSD-2-Clause",
    "mozilla public license": "MPL-2.0",
    "isc license": "ISC",
    "the unlicense": "Unlicense",
    "creative commons zero": "CC0-1.0",
    "sspl": "SSPL-1.0",
    "business source license": "BUSL-1.1",
    "commons clause": "Commons-Clause",
}


def _classify(spdx: str | None) -> LicenseCategory:
    if not spdx:
        return LicenseCategory.UNKNOWN
    if spdx in SPDX_PERMISSIVE:
        return LicenseCategory.PERMISSIVE
    if spdx in SPDX_COPYLEFT:
        return LicenseCategory.COPYLEFT
    return LicenseCategory.UNKNOWN


def detect_license(text: str) -> tuple[str | None, LicenseCategory]:
    """Detect license from a string. Returns (spdx_id, category).

    Looks for explicit SPDX-License-Identifier first, then falls back to a
    handful of name hints.
    """
    if not text:
        return None, LicenseCategory.UNKNOWN
    m = _SPDX_RE.search(text)
    if m:
        spdx = m.group(1).strip()
        return spdx, _classify(spdx)
    head = text[:8192].lower()
    for needle, spdx in _NAME_HINTS.items():
        if needle in head:
            return spdx, _classify(spdx)
    return None, LicenseCategory.UNKNOWN


def license_allowed(
    category: LicenseCategory,
    mode: str = "permissive_only",
) -> bool:
    """Filter policy.

    * `permissive_only`: only permissive licenses pass; unknown passes too,
      because a lot of repos rely on the repo-level LICENSE file we don't
      always see here.
    * `strict`: only permissive passes; unknown is rejected.
    * `off`: everything passes.
    """
    if mode == "off":
        return True
    if mode == "strict":
        return category == LicenseCategory.PERMISSIVE
    # permissive_only (default)
    return category in (LicenseCategory.PERMISSIVE, LicenseCategory.UNKNOWN)


def detect_repo_license(repo_root: str | Path) -> tuple[str | None, LicenseCategory]:
    """Find a top-level LICENSE/COPYING file and classify it."""
    root = Path(repo_root)
    candidates: Iterable[str] = (
        "LICENSE",
        "LICENSE.md",
        "LICENSE.txt",
        "COPYING",
        "COPYING.md",
        "COPYING.txt",
        "LICENCE",
    )
    for name in candidates:
        p = root / name
        if p.exists() and p.is_file():
            try:
                return detect_license(p.read_text("utf-8", errors="replace"))
            except OSError:
                continue
    return None, LicenseCategory.UNKNOWN
