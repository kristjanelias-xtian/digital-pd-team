# How to Write a Good Pipedrive Note

## The three rules

1. **Max 12 rendered lines.** Count them.
2. **No markdown tables, headers, or code fences.** PD renders markdown poorly: tables collapse to one line, headers vanish, code fences become garbled. Use plain text with line breaks.
3. **Structure: one-line summary → bullet list of facts → "Next:" line.** Every note. No exceptions.

## Why these rules exist

PD notes are read on the pipeline board sidebar — a narrow column next to the deal card. They are glanced at, not read. A scannable 8-line note beats a thorough 50-line essay every time. Your future self and your teammates will thank you.

## Use `pd-note` — it enforces the format

You do not write notes by hand. You call `pd-note` with structured input and it produces the correct format:

```
pd-note --on deal --id 49 \
  --summary "Discovery call done with Eva — strong fit, moving to site visit" \
  --facts "South-facing metal roof 40m²;Budget €15K confirmed;Both owners aligned;No shading;Modern electrical panel" \
  --next-action "Site visit booked for Apr 11"
```

If `pd-note` refuses your input, fix the input — do not bypass it with raw curl.

## Worked example: qualification note

**Bad (wall of text):**

> So I just got off the call with Eva Pirita and she was really pleasant to talk to. I asked her about the roof and she said it's south-facing metal which is great because as we know that's the best orientation for solar in Estonia. She mentioned the budget is around 15K which aligns with what we usually charge for a mid-sized residential. Both her and her husband are on board with this. There's no shading from nearby trees because they had them trimmed last year. The electrical panel in the house is modern so we won't need to do any upgrades. We scheduled a site visit for next Thursday, April 11...

**Good:**

```
Discovery call done with Eva — strong fit, moving to site visit

• South-facing metal roof 40m²
• Budget €15K confirmed
• Both owners aligned
• No shading
• Modern electrical panel

Next: site visit booked for Apr 11
```

## Worked example: site assessment

```
Site visit complete at Pirita Villa — ready to propose

• Confirmed 40m² usable south-facing roof, 35° pitch
• No shading morning or afternoon
• Electrical panel sized for 12-panel system, no upgrade
• One heritage restriction — needs permit check for front-facing array

Next: check heritage permit requirement, send proposal Thursday
```

## Worked example: disqualification

```
Saare farm — disqualified, property not suitable

• Barn roof is asbestos, can't mount panels
• Owner not ready for full roof replacement
• No alternative mounting location on property

Next: marked lost, reason "property not suitable"
```

## Anti-patterns — never put in a note

- **Raw IDs, JSON blobs, or API responses.** "person_id=10, deal_id=49" belongs in debug logs, not in a sales record.
- **Meta-commentary.** "As an AI assistant I have processed the webhook and determined..." No.
- **Status updates the group already saw.** The group chat and PD notes serve different audiences — don't duplicate.
- **Long call transcripts.** If you must store a transcript, put it in a *separate* note from the summary. The summary note stays short.
- **Emoji on every line.** A few are fine. One per line is spam.
- **Markdown tables.** They collapse to a single line in PD's renderer.
- **Repeated information.** If a fact is already in a structured field (value, stage, owner), don't restate it in the note.

## When you need to store more than 12 lines of content

Split into multiple notes. Each note is one topic, one summary, one next action. A discovery call and a site visit are two separate notes, not one long one.
