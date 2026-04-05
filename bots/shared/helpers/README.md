# Pipedrive Helpers

Opinionated CLI wrappers for Pipedrive. Installed into every bot sandbox at `~/.local/bin/`.

## Design

Each helper is a self-contained Python script that does one thing correctly and refuses on invalid input. Helpers shell out to the sandbox's `pd` command (which has the bot's API token baked in).

## The helpers

| Helper | Purpose |
|---|---|
| `pd-search` | Unified ranked search across persons/orgs/leads/deals |
| `pd-find-or-create-person` | Fuzzy search; create only if no close match |
| `pd-find-or-create-org` | Same pattern, rejects placeholder names |
| `pd-new-lead` | Create lead with required links (title + person) |
| `pd-new-deal` | Create deal + required activity atomically |
| `pd-note` | Write a well-formatted note (structured input only) |
| `pd-advance-stage` | Move deal between stages with side-effects |
| `pd-convert-lead` | Hot lead → deal atomically, archives lead |

## Running tests

Tests run on a developer host against the real NordLight PD instance using the admin token. They create records tagged `__test__` and clean them up at the end of every run.

```bash
cd bots/shared/helpers
export PD_ADMIN_TOKEN="<admin-token-from-docs/pipedrive-ids.md>"
pytest
```

The tests use a host-side `pd` shim at `tests/bin/pd` that forwards to the admin token. During normal test runs this shim is prepended to `PATH` automatically by `conftest.py`.

## Installation into a sandbox

Handled by `deploy-skill.sh` — it copies every script from `bots/shared/helpers/*.py` and the `lib/` directory into `~/.local/bin/` on the target sandbox, and ensures `~/.local/bin/` is on PATH.
