# Pipedrive — How It Thinks

Read this once per session if you're new or confused. Short on purpose.

## The deal is the unit of value

A **deal** is a commercial opportunity with a monetary value, a pipeline stage, an expected close date, and an owner. Deals move through stages from open to won or lost. Everything else exists to support deal execution — the pipeline board (Kanban of deals) is the primary workspace.

## Activity-based selling

Pipedrive is designed around activities, not outcomes. Focus on the next actions you control — calls, meetings, follow-ups, emails, deadlines — rather than obsessing over close dates. Activities drive deals forward. A deal with no open activity is stuck by definition.

## This is not a contact database

Persons and organizations exist to provide context for deals. They are not the primary anchor. You do not manage "contacts" — you manage deals that happen to link to contacts.

## Core entities

- **Deals** — the unit of value. One primary person + one primary organization per deal (intentional constraint — keeps reporting sane).
- **Leads** — unqualified prospects in a separate Leads Inbox. Leads keep the pipeline from being polluted by "maybes." A lead converts to a deal when qualified. Leads share custom-field definitions with deals.
- **Persons** — individual contacts. Belong to an organization.
- **Organizations** — company/account records. Single source of truth for company-level info.
- **Activities** — time-based actions (calls, meetings, tasks). The operational heartbeat. Attach to deals, leads, persons, orgs.
- **Notes** — unstructured text for context that doesn't fit structured fields. Attach to deals, leads, persons, orgs.
- **Products** — line items for quoting and revenue tracking.

## Entity relationships

```
Organizations
    └── Persons
          └── Deals (primary person + primary organization)
                ├── Activities
                ├── Notes
                └── Products
```

Activities, notes, and products attach primarily to deals and roll up to the linked person and organization.

## Leads vs Deals — the rule

- **Leads live in the Leads Inbox.** They are Lux's domain. They are not in the pipeline. They do not have stages.
- **Deals live in the NordLight Solar pipeline.** They are Taro's domain. They have stages. They have activities.
- **Converting** a lead means: creating a deal from it, linking the lead's person and org to the new deal, and archiving the lead. Use `pd-convert-lead`.

## A well-formed deal has

1. A primary organization (look up or create — for commercial; residential deals may be person-only).
2. A primary person linked to that organization.
3. The deal in the correct pipeline and stage.
4. At least one open follow-up activity.

Deals missing any of these are malformed. `pd-new-deal` enforces this.
