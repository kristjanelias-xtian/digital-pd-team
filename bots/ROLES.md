# NordLight Sales Team — Role Registry

This file is the source of truth for what each bot does. It's also the product doc — each row describes a sellable sales role.

When adding a new bot, fill in a row *before* writing any code. If you can't write a clean one-line job description, the role isn't clear enough to build.

## Built roles

### Lux — SDR (Sales Development Rep)

**Bot:** Lux Bot (`@lux_pd_bot`, PD user 25475071)
**One-line job:** Qualify inbound leads, prospect outbound, book meetings.
**Owns:** Leads Inbox, lead scoring and labelling, person/org creation from new contacts, first-contact outreach, lead→deal conversion.
**Does not own:** Deals, proposals, closing, site visits, post-sale.
**Receives work from:** Webhook (added/updated lead, added non-bot person/org), direct group mentions.
**Hands off to:** Taro (on Hot-lead conversion), Zeno (escalation on unusual leads).

### Taro — AE (Account Executive)

**Bot:** Taro Bot (`@taro_pd_bot`, PD user 25475082)
**One-line job:** Take qualified deals from Qualified through Contract Signed.
**Owns:** Deals in the NordLight Solar pipeline, discovery calls, site visits, proposals, negotiation, closing.
**Does not own:** Leads, re-qualification, post-sale customer success.
**Receives work from:** Lux (on conversion), webhook (added/updated deal with stage/status/value change), direct group mentions.
**Hands off to:** Zeno (stuck deals, deals over €40K at Negotiation), Kristjan (final sign-off on big deals).

### Zeno — Sales Manager

**Bot:** Zeno Bot (`@zeno_pd_bot`, PD user 25475093)
**One-line job:** Oversee pipeline health, coach the team, escalate stuck or big deals.
**Owns:** Pipeline oversight, team coordination, stuck-deal nudges, big-deal escalation to human, win celebrations, weekly summaries.
**Does not own:** Lead intake, deal execution, record creation, data hygiene.
**Receives work from:** Webhook cc on deal updates, webhook on deal/lead deletes, direct group mentions.
**Hands off to:** Kristjan (escalations, weekly reports).

## Reserved roles (not built)

### RevOps — Revenue Operations

**Status:** Reserved slot. Not built.
**One-line job:** Keep the CRM clean and the process predictable.
**Would own:** Lead intake routing, duplicate detection, custom-field hygiene, weekly data-health reports, pipeline analytics.
**Would not own:** Selling, closing, coaching.
**Would receive work from:** Webhook (first responder before Lux/Taro), scheduled heartbeat tasks.
**Would hand off to:** Lux (for routed leads), Zeno (for process violations needing coaching).

## Future role slots (brainstormed, not scoped)

- **CSM (Customer Success Manager)** — post-sale: onboarding, check-ins, renewal prep. Triggered on `won` deals.
- **AM (Account Manager)** — existing-customer expansion, renewals.
- **SE (Solutions Engineer)** — technical pre-sales for complex deals; partners with AE.
- **Meeting Intelligence** — Recall-based transcript capture + meeting summaries; writes post-meeting notes on deals.
