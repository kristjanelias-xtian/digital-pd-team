"""Input validation shared across helpers.

These are the enforcement layer. Every validation failure returns a
human-readable error message that will be surfaced to the bot via
`output.error()`. The bot reads the message and retries with fixed input.
"""
from __future__ import annotations

import re

PLACEHOLDER_NAMES = {"test", "asdf", "xxx", "foo", "bar", "placeholder", "todo", "tbd"}
MARKDOWN_TABLE_RE = re.compile(r"^\s*\|.*\|.*$", re.MULTILINE)
MARKDOWN_HEADER_RE = re.compile(r"^\s*#{1,6}\s", re.MULTILINE)
CODE_FENCE_RE = re.compile(r"```")


def max_length(value: str, limit: int, field: str) -> None:
    if len(value) > limit:
        raise ValueError(f"{field} is {len(value)} chars, max {limit}")


def non_empty(value: str, field: str) -> None:
    if not value or not value.strip():
        raise ValueError(f"{field} is required")


def max_items(items: list, limit: int, field: str) -> None:
    if len(items) > limit:
        raise ValueError(f"{field} has {len(items)} items, max {limit}")


def no_markdown_tables(text: str, field: str) -> None:
    if MARKDOWN_TABLE_RE.search(text):
        raise ValueError(f"{field} contains a markdown table — PD renders them badly, use plain text")


def no_markdown_headers(text: str, field: str) -> None:
    if MARKDOWN_HEADER_RE.search(text):
        raise ValueError(f"{field} contains a markdown header — PD renders them badly, use plain text")


def no_code_fences(text: str, field: str) -> None:
    if CODE_FENCE_RE.search(text):
        raise ValueError(f"{field} contains a code fence — use plain text")


def max_rendered_lines(text: str, limit: int, field: str) -> None:
    lines = text.split("\n")
    if len(lines) > limit:
        raise ValueError(f"{field} renders to {len(lines)} lines, max {limit}")


def safe_name(name: str, field: str) -> None:
    non_empty(name, field)
    if len(name.strip()) < 3:
        raise ValueError(f"{field} is too short (< 3 chars)")
    if name.strip().lower() in PLACEHOLDER_NAMES:
        raise ValueError(f"{field} looks like a placeholder ('{name}')")


def fuzzy_match(a: str, b: str) -> float:
    """Very simple normalized token overlap. Returns 0.0 to 1.0."""
    ta = set(a.lower().split())
    tb = set(b.lower().split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / max(len(ta), len(tb))
