# Deal Lifecycle

For each stage: what it means, how a deal arrives, what to do, how it exits. Use `pd-advance-stage` for transitions — it enforces the rules.

## Stage 11 — New Lead (probability 0%)

Deals should not be in this stage. It exists for legacy reasons. If you see a deal here, either archive it or move it to Qualified with a reason. Ask Zeno why it's there.

## Stage 12 — Qualified (probability 15%)

**Meaning:** Lux has qualified this prospect as Hot and converted the lead. There's a person, an org (if commercial), and the deal is ready for an AE to run discovery.

**Arrives from:** `pd-convert-lead` (Lux's action). Never created directly.

**What Taro does here:**
- Read Lux's qualification note on the deal.
- Run a discovery call — real conversation with the prospect about needs, constraints, timeline.
- Write a discovery call transcript as a **separate note** using `pd-note` (structured). Keep the summary note short.
- Schedule a site visit activity with realistic details (date, time, address).
- Advance to Site Visit Scheduled with `pd-advance-stage`.

**Exits to:** Site Visit Scheduled.

**Stuck signal (for Zeno):** >7 days in Qualified with no activity = Taro hasn't picked it up. Nudge.

## Stage 13 — Site Visit Scheduled (probability 30%)

**Meaning:** A site visit is booked. The physical check is the gating step before quoting.

**What Taro does:**
- Mark the site visit activity done when complete.
- Write a site assessment note: roof area, orientation, shading, electrical panel, permits, issues.
- Draft a proposal: system specs, pricing, ROI, timeline, warranty.
- Write the proposal as a note on the deal (short — the full proposal is a separate document, the note captures key terms).
- Advance to Proposal Sent with `pd-advance-stage`.

**Stuck signal:** site visit activity past due by 3+ days.

## Stage 14 — Proposal Sent (probability 50%)

**Meaning:** The prospect has the numbers. Waiting on their reaction.

**What Taro does:**
- Schedule a proposal review activity ~5–7 days out.
- When the review happens: if client accepts as-is → Verbal Agreement. If they want changes → Negotiation. If they're cold → keep pushing or lose.
- Write a review-call note capturing their reaction.

**Stuck signal:** >7 days in Proposal Sent with no activity. Send a nudge.

## Stage 15 — Negotiation (probability 70%)

**Meaning:** Client wants changes. Taro is working terms.

**What Taro does:**
- Each round of negotiation gets a note: what they asked, what you offered.
- When terms are final → Verbal Agreement.

**Stuck signal:** >14 days in Negotiation. Flag to Zeno.
**Escalation signal:** Deal value >€40K in Negotiation. Tag both Zeno and Kristjan — commercial opportunities at this scale get senior visibility.

## Stage 16 — Verbal Agreement (probability 85%)

**Meaning:** Client has said yes. Contract signing is the remaining step.

**What Taro does:**
- Schedule contract signing activity.
- Write a note capturing the final terms.
- Advance to Contract Signed when signed.

## Stage 17 — Contract Signed (probability 100%)

**Meaning:** Won. `PUT /deals/{id}` with `{"status": "won"}` (handled by `pd-advance-stage --to "Contract Signed"`).

**What happens:** Taro marks the signing done, notes the final terms, marks the deal won. Zeno posts a celebration in the group with the value.

## Losing a deal

Not every deal closes. When it happens:
1. Write a final note showing what happened — honest about the reason.
2. Mark the deal lost via `pd-advance-stage --to "Lost"` (or the raw API if no helper covers it).
3. Zeno asks what happened in the group so the team learns.

## Deals over €40K

These are significant commercial opportunities. When one reaches Negotiation, tag both @zeno_pd_bot and Kristjan for senior visibility.

## Activity hygiene

Every open deal should have exactly one open forward activity. Zero means the deal is stuck. Two or more means ambiguity about what's next. When you advance a stage, close the previous stage's activity and open the next one. `pd-advance-stage` enforces this.
