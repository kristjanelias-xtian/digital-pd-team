# Pipedrive — How It Thinks

Read this file before doing anything in Pipedrive. It teaches you how Pipedrive works conceptually, what your NordLight Solar account looks like, and how to discover account-specific configuration at runtime.

## Mental model

The **deal** is the unit of value and the unit of work. Everything else in Pipedrive exists to support deal execution. The **pipeline board** — a visual Kanban of deals moving through stages — is the primary workspace. Always treat the deal as the central anchor.

Pipedrive follows **activity-based selling**: focus on the next actions within your control (calls, meetings, follow-ups) rather than obsessing over outcomes. Activities drive deals forward.

This is not a contact database. Persons and organizations are important context for deals, not independent anchors.

## Core entities

**Deals** — A commercial opportunity with a monetary value, pipeline stage, expected close date, and owner. Deals move through stages from open to won or lost. A deal links to one primary person and one primary organization. This constraint is intentional — it keeps reporting and the UI predictable.

**Leads** — An unqualified prospect stored in a separate Leads Inbox, not in the pipeline. Leads prevent the pipeline from being overloaded with unqualified "maybes." A lead converts to a deal when qualified. Leads share the same custom field definitions as deals.

**Persons** — Individual contacts. A person can belong to an organization. Persons are linked to deals as participants or primary contacts.

**Organizations** — Company or account records. The single source of truth for company-level information.

**Activities** — Time-based actions: calls, meetings, tasks, emails, deadlines. Activities are the operational heartbeat — they represent "what happened" and "what's next." They link to deals, leads, persons, and organizations. Important: activities do not support custom fields.

**Notes** — Unstructured text attached to deals, persons, organizations, or leads. Notes capture context that doesn't fit structured fields.

**Products** — Items being sold, attached to deals with prices and quantities. Used for quoting and revenue tracking at the line-item level.

## Entity relationships

The pattern is deal-as-hub:

```
Organizations
    └── Persons
          └── Deals (primary person + primary organization)
                ├── Activities
                ├── Notes
                ├── Products (line items)
                └── Projects (post-sale)
```

Activities, notes, and products attach primarily to deals and roll up to the linked person and organization. Relationship constraints are intentional — a deal has one primary person and one primary organization. These constraints simplify the UI, reporting, and permissions.

## Pipelines and stages

A pipeline is a sequence of stages that deals move through. Each stage represents a milestone in the sales process. Moving a deal between stages is the primary interaction pattern — it reflects real progress.

When creating or updating deals, always assign them to a valid pipeline and stage. Do not create deals without a stage.

## Custom fields

Deals, persons, organizations, and products support custom fields. Custom field codes are system-generated 40-character hashes (e.g., `c4edaffd98369398ebaac0348cdb3f86f5a8eb26`). They are not human-readable.

**Always discover custom fields before writing to them.** Use the field metadata endpoints:
- `GET /dealFields` — custom fields on deals
- `GET /personFields` — custom fields on persons
- `GET /organizationFields` — custom fields on organizations

Each response includes: the hash-based field `key`, a human-readable `name`, the field `type` (varchar, enum, date, monetary, etc.), and for enum fields the list of `options` with their IDs and labels.

When setting enum or set fields, use the option **ID** (an integer), not the label text.

## API conventions

**Base URL:** `https://api.pipedrive.com/v1`

**Auth:** API token as query parameter: `?api_token={your_token}`

**Instance:** xtian.pipedrive.com

**Key v1 vs v2 differences** (use v1 unless specified):
- v2 uses `owner_id` instead of `user_id`
- v2 uses cursor-based pagination (`next_cursor`), v1 uses offset (`start`, `limit`)
- v2 timestamps are RFC 3339

**Pagination:** Default limit 100, max 500. Check for `additional_data.pagination.more_items_in_collection` (v1) or `next_cursor` (v2).

**Rate limiting:** Token-based daily budget shared across all users. On 429, back off with jitter.

## Common patterns

### Creating a deal with full context

A well-formed deal has:
1. A primary **organization** (look up or create)
2. A primary **person** linked to that organization (look up or create)
3. The **deal** in the correct pipeline and stage, linked to person and organization
4. A follow-up **activity** on the deal

Do not create orphan deals without a person, organization, or follow-up activity.

### Discovering account configuration

Before complex operations, discover the account's setup:
- `GET /pipelines` — list pipelines
- `GET /stages?pipeline_id={id}` — stages within a pipeline
- `GET /dealFields` — deal custom fields and their options
- `GET /personFields` — person custom fields
- `GET /activityTypes` — available activity types
- `GET /persons/search?term={name}` — search before creating (avoid duplicates)

---

## NordLight Solar — Account Anchors

These are stable facts about the xtian.pipedrive.com account.

### Pipeline

| Pipeline | ID |
|----------|----|
| NordLight Solar | 3 |

### Stages

| Stage | ID | Probability |
|-------|----|-------------|
| New Lead | 11 | 0% |
| Qualified | 12 | 15% |
| Site Visit Scheduled | 13 | 30% |
| Proposal Sent | 14 | 50% |
| Negotiation | 15 | 70% |
| Verbal Agreement | 16 | 85% |
| Contract Signed | 17 | 100% |

### Team

| Name | Role | User ID |
|------|------|---------|
| Kristjan Elias | Owner | 980093 |
| Joonas Karulauk | Admin | 25474697 |
| Zeno Bot | Sales Director | 25475093 |
| Lux Bot | SDR | 25475071 |
| Taro Bot | Account Executive | 25475082 |

### Lead labels

| Label | UUID |
|-------|------|
| Hot | 43b6da41-0a3f-49b3-8024-c09fd2708d02 |
| Warm | fd40651a-b18b-4781-9ac7-de9ed226ad3b |
| Cold | d0a616f6-603a-48e7-9620-03057cfe3648 |
