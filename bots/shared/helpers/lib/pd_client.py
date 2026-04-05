"""Thin Pipedrive client that shells out to the `pd` command.

The `pd` command inside a bot sandbox has the bot's API token hardcoded.
On a developer host, a shim at tests/bin/pd provides the admin token.
This module is intentionally agnostic about which is in use — it just
invokes `pd` via subprocess and parses JSON from stdout.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import time
from typing import Any
from urllib.parse import quote


class PDError(RuntimeError):
    """Raised when the PD API returns an error or shells out fails."""


class PDClient:
    """Shells out to `pd <METHOD> <path> [body]` and parses JSON."""

    def __init__(self, pd_binary: str | None = None, max_retries: int = 3):
        self.pd_binary = pd_binary or shutil.which("pd")
        if not self.pd_binary:
            raise PDError("`pd` command not found on PATH")
        self.max_retries = max_retries

    def _run(self, method: str, path: str, body: dict | None = None) -> dict:
        args = [self.pd_binary, method, path]
        if body is not None:
            args.append(json.dumps(body))
        last_err: Exception | None = None
        for attempt in range(self.max_retries):
            try:
                result = subprocess.run(
                    args, capture_output=True, text=True, timeout=30
                )
                if result.returncode != 0:
                    raise PDError(
                        f"pd {method} {path} failed (rc={result.returncode}): "
                        f"{result.stderr.strip()}"
                    )
                data = json.loads(result.stdout or "{}")
                if data.get("success") is False:
                    error = data.get("error", "unknown")
                    error_info = data.get("error_info", "")
                    # Rate limit — back off and retry
                    if "rate limit" in str(error).lower() or "429" in str(error):
                        time.sleep(2**attempt)
                        continue
                    raise PDError(f"pd {method} {path}: {error} {error_info}".strip())
                return data
            except (subprocess.TimeoutExpired, json.JSONDecodeError) as e:
                last_err = e
                time.sleep(1)
        raise PDError(f"pd {method} {path} failed after {self.max_retries} attempts: {last_err}")

    def get(self, path: str) -> dict:
        return self._run("GET", path)

    def post(self, path: str, body: dict) -> dict:
        return self._run("POST", path, body)

    def put(self, path: str, body: dict) -> dict:
        return self._run("PUT", path, body)

    def patch(self, path: str, body: dict) -> dict:
        return self._run("PATCH", path, body)

    def delete(self, path: str) -> dict:
        return self._run("DELETE", path)

    # Convenience helpers
    def search_persons(self, term: str) -> list[dict]:
        result = self.get(f"/persons/search?term={quote(term, safe='')}&limit=20")
        items = result.get("data", {}).get("items", [])
        return [item.get("item", {}) for item in items]

    def search_organizations(self, term: str) -> list[dict]:
        result = self.get(f"/organizations/search?term={quote(term, safe='')}&limit=20")
        items = result.get("data", {}).get("items", [])
        return [item.get("item", {}) for item in items]

    def search_leads(self, term: str) -> list[dict]:
        result = self.get(f"/leads/search?term={quote(term, safe='')}&limit=20")
        items = result.get("data", {}).get("items", [])
        return [item.get("item", {}) for item in items]

    def search_deals(self, term: str) -> list[dict]:
        result = self.get(f"/deals/search?term={quote(term, safe='')}&limit=20")
        items = result.get("data", {}).get("items", [])
        return [item.get("item", {}) for item in items]
