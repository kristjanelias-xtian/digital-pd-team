"""Shared pytest fixtures.

Prepends tests/bin/ to PATH so helpers pick up the host-side `pd` shim.
Provides a `pd` client fixture and cleanup for records tagged __test__.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Make lib/ importable
HELPERS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HELPERS_DIR))

from lib.pd_client import PDClient  # noqa: E402

TEST_MARKER = "__test__"


@pytest.fixture(scope="session", autouse=True)
def _ensure_admin_token():
    if not os.environ.get("PD_ADMIN_TOKEN"):
        pytest.skip("PD_ADMIN_TOKEN not set — integration tests require it")


@pytest.fixture(scope="session", autouse=True)
def _use_test_pd_shim():
    bin_dir = HELPERS_DIR / "tests" / "bin"
    os.environ["PATH"] = f"{bin_dir}:{os.environ['PATH']}"
    yield


@pytest.fixture
def pd() -> PDClient:
    return PDClient()


@pytest.fixture
def cleanup_test_records(pd: PDClient):
    """Track IDs created during a test and delete them afterward."""
    created: dict[str, list] = {"persons": [], "organizations": [], "leads": [], "deals": [], "notes": []}
    yield created
    # Cleanup in reverse dependency order
    for note_id in created["notes"]:
        try:
            pd.delete(f"/notes/{note_id}")
        except Exception:
            pass
    for deal_id in created["deals"]:
        try:
            pd.delete(f"/deals/{deal_id}")
        except Exception:
            pass
    for lead_id in created["leads"]:
        try:
            pd.delete(f"/leads/{lead_id}")
        except Exception:
            pass
    for person_id in created["persons"]:
        try:
            pd.delete(f"/persons/{person_id}")
        except Exception:
            pass
    for org_id in created["organizations"]:
        try:
            pd.delete(f"/organizations/{org_id}")
        except Exception:
            pass


def test_marker() -> str:
    """Return the marker substring every test record must contain."""
    return TEST_MARKER
