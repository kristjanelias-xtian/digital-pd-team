# Pipedrive API Conventions

## Base URL and auth

**Base URL:** `https://api.pipedrive.com/v1`
**Instance:** nordlight-digital-pd-team.pipedrive.com
**Auth:** API token as query param: `?api_token={token}`

You do **not** use raw tokens. You use the `pd` command in the sandbox (which has your token baked in) or one of the `pd-*` helpers (which shell out to `pd`). If a helper refuses a request, fix the input — do not work around it with raw curl.

## v1 vs v2

Use v1 unless a helper explicitly says otherwise. Differences:
- v2 uses `owner_id` instead of `user_id`.
- v2 uses cursor-based pagination (`next_cursor`). v1 uses offset (`start`, `limit`).
- v2 timestamps are RFC 3339.

## Pagination

Default limit 100, max 500. Check `additional_data.pagination.more_items_in_collection` (v1) or `next_cursor` (v2). Most helpers handle this for you.

## Rate limiting

Token-based daily budget shared across all users. On HTTP 429, back off with jitter and retry. Helpers do this automatically.

## Error handling

- **4xx (except 429):** your fault. Read the error, fix the input, do not retry blindly.
- **429:** rate limit. Wait and retry (helpers do this).
- **5xx:** server fault. Retry once. If it persists, DM Kristjan. Do not retry in a loop.

## Sandbox networking

Sandboxes route HTTP through a proxy at `10.200.0.1:3128`. The `pd` command and Node's `fetch()` handle this correctly. Raw Node `dns.lookup()` calls fail (cluster DNS is unreachable from the sandbox network namespace) — this is an architectural constraint, not a bug. If you see `EAI_AGAIN`, it means something is doing a raw DNS lookup instead of going through the proxy.
