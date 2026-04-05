# Lead Lifecycle

## States a lead can be in

- **Unworked** — just arrived, no label, no scoring note yet.
- **Labeled Hot (≥70)** — qualified, ready for conversion to deal.
- **Labeled Warm (40–69)** — interested but not ready. Needs follow-up.
- **Labeled Cold (<40)** — disqualified. Archive.
- **Converted** — Hot lead has been turned into a deal via `pd-convert-lead`. The lead record is archived.
- **Archived** — final state. No further action.

## NordLight ICP scoring (0–100)

Score each lead on six criteria. Full points = clear positive. Half = ambiguous. Zero = disqualifier or no signal.

| # | Criterion | Weight | What you're evaluating |
|---|-----------|--------|----------------------|
| 1 | Property Suitability | 25 | Own the building? Roof south-facing, no shading, enough area? Detached? Heritage restrictions? |
| 2 | Energy Need & Motivation | 20 | High electricity costs? Clear motivation (savings, green values, energy independence)? |
| 3 | Budget & Financing | 20 | Can afford €7K-€80K? Budget indicated? Recent property investment? |
| 4 | Decision Authority | 15 | Talking to the owner/decision-maker? Or landlord, board, procurement in the way? |
| 5 | Service Area & Feasibility | 10 | In Tallinn, Tartu, Pärnu, Harju/Rapla/Lääne? Island or remote? |
| 6 | Timeline & Readiness | 10 | Ready within 6 months? Can install before winter? |

## Instant disqualifiers (auto-Cold)

- No roof access (apartment, rented without owner buy-in)
- Outside service area, no expansion plans
- No property ownership AND no path to owner decision
- Budget explicitly unavailable and no financing path

## Worked scoring example

Smarten Logistics — commercial inquiry about rooftop solar.

- **Property Suitability (25):** Owns multiple warehouses in Rae with flat roofs. Full 25.
- **Energy Need (20):** Mentioned ESG reporting and rising electricity costs. Full 20.
- **Budget (20):** Commercial buyer, no explicit budget, but "next year budget cycle" signals real intent. Half 10.
- **Decision Authority (15):** Contact is facilities director — right person. Full 15.
- **Service Area (10):** Rae = Harju county. Full 10.
- **Timeline (10):** "Next year budget cycle" = 6+ months out. Half 5.

Total: **85 (Hot)**. Score-note rationale: strong property + motivation + authority; timeline is the only soft spot.

## Writing the scoring note

Don't dump a table. Weave it into a brief:

> "Smarten Logistics — strong fit. They own multiple warehouses in Rae with flat roofs, perfect for commercial solar. Andrus is the facilities director so he's the right call. ESG reporting gives us a clear hook. Timeline is the only soft spot — next year budget cycle, so we seed now for a spring install. Score 85."

Always use `pd-note --on lead --id <n>` to write this.

## Converting a Hot lead

`pd-convert-lead` does the whole flow atomically:
1. Verifies the lead is labeled Hot (refuses otherwise).
2. Creates the deal in the Qualified stage with person/org/activity linkages from the lead.
3. Archives the lead.
4. Returns the new deal ID.

You never create a deal from a lead manually. That path is `pd-convert-lead` and nothing else.

## Outbound prospecting (proactive mode)

When proactive mode is ON and there are fewer than 3 leads in the inbox, create new ones. Think about who in Estonia would realistically be shopping for solar right now:

- Homeowners in suburbs of Tallinn/Tartu/Pärnu with detached houses
- Commercial property owners with flat roofs (warehouses, logistics, retail)
- Municipal or hospitality operators with high daytime energy use
- People who recently bought property (motivation + budget)

Use `pd-new-lead` to create each one. Then qualify immediately — don't leave unworked leads in the inbox.
