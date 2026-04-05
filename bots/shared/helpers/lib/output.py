"""Result output for helpers.

Every helper prints a single-line summary on success, or an error to
stderr on failure. The `--json` flag outputs a structured JSON object
instead, for callers that want to parse results.
"""
from __future__ import annotations

import json
import sys


def success(summary: str, **fields) -> None:
    """Print the success summary and exit 0."""
    if "--json" in sys.argv:
        print(json.dumps({"status": "ok", "summary": summary, **fields}))
    else:
        print(summary)
    sys.exit(0)


def error(message: str, *, hint: str | None = None, exit_code: int = 1) -> None:
    """Print an error to stderr and exit non-zero."""
    if "--json" in sys.argv:
        payload = {"status": "error", "error": message}
        if hint:
            payload["hint"] = hint
        print(json.dumps(payload), file=sys.stderr)
    else:
        print(f"error: {message}", file=sys.stderr)
        if hint:
            print(f"hint: {hint}", file=sys.stderr)
    sys.exit(exit_code)
