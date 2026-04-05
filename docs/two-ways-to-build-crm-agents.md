# Two ways to build agents that touch your CRM

This essay lives in the sibling repo **pipeagent**, which is the LangGraph/Hono counterpart to this project. It compares the two approaches to building Pipedrive agents with Claude:

- **pipeagent** — a compiled LangGraph pipeline. Typed state, Postgres checkpointing, HITL as a graph node. Claude as a function.
- **digital-pd-team** (this repo) — three openclaw bots in a Telegram group. Markdown skills, shell helpers, a 13-line trigger relay. Claude as the runtime.

**Read it here:** [`../../pipeagent/docs/two-ways-to-build-crm-agents.md`](../../pipeagent/docs/two-ways-to-build-crm-agents.md)

> The framework you pick is just a decision about how much of Claude you're willing to let into your system. LangGraph lets in a function. openclaw lets in a whole employee. The architecture follows from that, not the other way around.
