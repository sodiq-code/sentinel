# RFC — Closed-Loop Metadata Agents

**A generalisable pattern for agents that read AND write the context graph.**

- **Status**: Draft (Phase 0 — filed as a hackathon bonus contribution)
- **Author**: Sentinel Contributors
- **Discussion**: https://github.com/sodiq-code/sentinel/discussions
- **License**: Apache 2.0
- **Target**: `datahub-project/rfcs` (companion to the `incident-triage` Skill)

---

## Abstract

Most metadata-grounded agents today are read-only: they query the catalog, generate a response, and stop. They leave the catalog unchanged. This RFC proposes the **closed-loop-metadata-agent** pattern: agents that read the context graph, reason, act in the world, and write structured knowledge back to the graph — so the next run starts smarter. The pattern is generalisable beyond incidents: ML audits, compliance reviews, code generation, schema migrations. The reference implementation is **Sentinel** (https://github.com/sodiq-code/sentinel), an autonomous data incident response agent for DataHub.

---

## Background

DataHub is a context platform: a typed graph of assets, lineages, owners, glossary terms, governance tags, assertions, and context documents. The DataHub MCP Server exposes 12 read tools over this graph; the Agent Context Kit exposes 7 write tools (with `include_mutations=True`).

Read-only agent demos are common — text-to-SQL chatbots, search-and-summarise, lineage-explainer. They consume the graph. None of them produce it.

The state of the art prior art is Block's Goose + DataHub MCP Server use case (human-driven incident response). Block demonstrated that an agent *could* investigate an incident using DataHub. Sentinel extends that to an agent that *does* — autonomously, end-to-end, and writes back.

The pattern is the contribution.

---

## Motivation

The unique insight: **incident response is a write-back loop, not a read.** Every incident an agent handles should leave the context graph richer:

- The post-mortem is captured as a context doc.
- The discovered owner is proposed.
- The new SLA is encoded as an assertion.
- The runbook delta is proposed as a glossary update.

This **compounds**: the second incident is faster because the first was documented. Run 2 reads Run 1's post-mortem. The context graph is not just for discovery — it is the substrate an agent needs to safely act. The moat is structural, not technical.

Read-only agents cannot accumulate this knowledge. They start from scratch every time. They are commodities.

---

## Specification

The closed-loop-metadata-agent pattern has six phases:

```
observe signal
  → ground in context graph
  → reason over lineage + ownership + governance
  → act in the world
  → write structured knowledge back to the graph
  → await human feedback
  → update graph
```

### Phase 1 — observe signal

The agent subscribes to a signal source. For incidents: DataHub assertion failures (freshness, schema, quality). For ML audits: feature drift signals. For compliance: policy violations. For code generation: a PR comment.

The signal is structured (typed URN + payload), not free text.

### Phase 2 — ground in context graph

The agent reads the relevant subgraph via the catalog's API:

- Search for the affected asset
- Get the entity (owners, glossary terms, governance tags, schema)
- Get upstream lineage (root cause candidates)
- Get downstream lineage (blast radius)
- Search context docs for prior post-mortems (the compounding beat)

This is RAG over a typed graph, not a vector store. The graph provides lineage constraints, ownership constraints, and governance constraints that embeddings alone cannot.

### Phase 3 — reason over lineage + ownership + governance

A ReAct-style loop (plan → act → observe → reflect) over the read tools. The agent reasons about:

- Which upstream asset's freshness breach explains this asset's staleness?
- Which owner should be paged?
- Does the governance posture allow the proposed action? (PII refusal, no-merge policy, human-approval gate)
- Has this happened before? What did the post-mortem say?

The reasoning is visible (streamed to a UI) because judges and on-call engineers reward "I can see the agent thinking".

### Phase 4 — act in the world

The agent takes real-world actions via external connectors:

- Open a GitHub issue + a draft PR (NEVER merge — the no-merge policy)
- Post a Slack triage summary
- File a Jira ticket (for compliance agents)

All actions are scoped (scoped tokens, demo repos/channels/workspaces). All actions are audited.

### Phase 5 — write structured knowledge back to the graph

The agent writes back to the catalog:

- A structured post-mortem as a context doc
- A glossary proposal (proposed, not patched — humans approve)
- An ownership proposal (proposed, not patched)
- A new assertion (the only direct write — reversible)

The dual write-back path (Agent Context Kit primary + REST ingestion fallback) ensures robustness against API version drift.

### Phase 6 — await human feedback → update graph

The pending approvals surface in a UI. When a human approves, the glossary/ownership proposals are applied. The audit log records every step. The next incident reads the post-mortem this one wrote — the loop compounds.

---

## The pattern, generalised

The closed-loop pattern applies beyond incident response:

| Domain | Signal | Read | Reason | Act | Write back |
|---|---|---|---|---|---|
| **Incident response** (Sentinel) | DataHub assertion failure | lineage, ownership, glossary | root cause + blast radius | GitHub issue + PR + Slack | post-mortem doc + glossary/owner proposals + assertion |
| **ML audit** (porting MLLineageGuard) | Feature drift / model quality drop | ML lineage, training data, features | proxy-PII features via lineage + governance | open an issue on the feature repo | ML-impact note + feature-deprecation proposal |
| **Compliance** | Policy violation | governance tags, ownership | which assets violate which policy | file a Jira ticket | compliance-status assertion + audit doc |
| **Code generation** (dbtForge) | PR comment "add a dbt model for X" | schema, lineage, glossary | generate SQL + tests + contract | open a PR with the model | glossary proposal for the new model |

Every closed-loop agent:
- Reads the catalog
- Reasons over the typed graph
- Acts in the world (governed)
- Writes back to the catalog
- Compounds

---

## Properties

A correctly-implemented closed-loop-metadata-agent has five properties:

1. **Grounded** — every claim the agent makes is backed by a typed URN in the catalog, not a free-text hallucination.
2. **Governed** — the agent refuses to act on PII-tagged assets without approval; it never auto-merges; it proposes, doesn't patch.
3. **Audited** — every tool call, action, and write-back is in an immutable audit log.
4. **Compounding** — every incident leaves the graph richer; the next is faster.
5. **Reproducible** — pinned versions, deterministic seed, dry-run fallback. The demo runs from a fresh clone in under a minute.

---

## Threat model

| Threat | Mitigation |
|---|---|
| Agent takes a destructive action | Scoped tokens; no-merge policy; guardrail refusal |
| Agent writes incorrect metadata | Proposals, not patches (humans approve). Assertions are the only direct write and are reversible. |
| Secrets leakage | `.env` out of git; gitleaks in CI; env-var-only secrets |
| Prompt injection via catalog metadata | Structured tool-call inputs (never free-text execution); metadata treated as data, not instructions |
| Catalog API version drift | Pinned versions; dual write-back path (Agent Context Kit + REST ingestion) |
| Demo doesn't run | Dry-run fallback (pre-recorded trace replayed through the same UI); deterministic seed; retries on every call |

---

## Reference implementation

Sentinel (https://github.com/sodiq-code/sentinel) is the reference implementation of this pattern. It targets the *Agents That Do Real Work* challenge at the Build with DataHub Agent Hackathon.

- **Stack**: Next.js 16 + TypeScript + Prisma/SQLite + shadcn/ui + NVIDIA NIM API (`nvidia/llama-3.3-nemotron-super-49b-v1`)
- **Read tools**: DataHub MCP Server (12 tools)
- **Write tools**: DataHub Agent Context Kit (7 tools) + REST ingestion fallback
- **Action connectors**: GitHub, Slack (scoped)
- **Bonus artefacts**: this RFC + the `incident-triage` Skill (https://github.com/sodiq-code/sentinel/tree/main/skill/incident-triage)

The `incident-triage` Skill is the agent-agnostic form of the same loop — installable into Claude Code, Cursor, Codex, Copilot, or Gemini via the DataHub Skills CLI.

---

## Open questions

1. **Cross-incident pattern mining** — when N post-mortems accumulate, can the agent detect recurring patterns (e.g. "this is the 4th freshness breach on a Spark job that hasn't run in 6h — propose an upstream SLA")? Left as future work.
2. **Multi-agent decomposition** — a planner + investigator + remediator + documenter pod. The PDF §9.3.2 Option B rejected this for the hackathon (single-orchestrator + tools is more reliable in the demo window) but documented it as a stretch goal.
3. **Learned triage policies** — fine-tune the triage reasoning on historical incidents. Out of scope for the hackathon; noted in the post-hackathon roadmap.

---

## Acknowledgements

Block's Goose + DataHub MCP Server use case demonstrated human-driven incident response with the MCP Server. Sentinel extends this to autonomous response with a write-back loop. The Block prior art is sponsor-validated category, not a competitor — the closed-loop pattern subsumes and extends it.

The DataHub team's `datahub-skills` registry provided the Skill format the `incident-triage` Skill follows.

---

## License

Apache 2.0 — see `LICENSE` in the Sentinel repo.
