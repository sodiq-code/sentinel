<div align="center">

# Sentinel

### An Autonomous Data Incident Response Agent for DataHub

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Build](https://img.shields.io/badge/build-passing-brightgreen.svg)](./.github/workflows/ci.yml)
[![Next.js](https://img.shields.io/badge/Next.js-16-black.svg)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)](https://www.typescriptlang.org/)
[![Hackathon](https://img.shields.io/badge/DataHub-Agent%20Hackathon-emerald.svg)](https://datahub.devpost.com)

**Submission for [Build with DataHub: The Agent Hackathon](https://datahub.devpost.com) · Challenge 1 — *Agents That Do Real Work***

**Live demo:** [sentinel-ivory-two-79.vercel.app](https://sentinel-ivory-two-79.vercel.app) · **Source:** [sodiq-code/sentinel](https://github.com/sodiq-code/sentinel)

</div>

---

## What Sentinel does

When a freshness, schema, or quality signal trips in DataHub, **Sentinel autonomously**:

1. **Triages** the incident — reads the failing asset, traverses upstream lineage, reads ownership, glossary, governance tags, and any prior post-mortems via DataHub's MCP tools.
2. **Acts** — opens a real GitHub issue + a draft pull request in the demo pipeline repo (never merged), posts a Block Kit triage card to the on-call Slack channel.
3. **Writes back** — composes a structured post-mortem, a glossary proposal, an ownership proposal, and a new SLA assertion, then ingests them back into DataHub via the Agent Context Kit so the next incident is faster.

Every incident leaves the catalog richer: the post-mortem Sentinel writes in Run 1 is the post-mortem it reads in Run 2. That's the closed loop. The agent runs a ReAct loop over DataHub's MCP tools (read), the Agent Context Kit (write), and real GitHub + Slack connectors — under a **code-level guardrail** that refuses destructive actions and gates governance writes behind human approval. The LLM cannot bypass the guardrail by rephrasing.

The full loop runs live: real GitHub issues, real Slack posts, real DataHub write-backs. [Proof below.](#verified-end-to-end)

<p align="center">
  <img src="./docs/screenshots/dashboard-hero.png" alt="Sentinel dashboard — the incident console at rest, with the Priya persona, three injectable signals, lineage graph, and the sticky demo control bar." width="960" />
</p>

---

## How it works

```
                       DataHub signal (freshness / schema / quality)
                                    │
                                    ▼
                          ┌──────────────────────┐
                          │   Orchestrator       │  ReAct loop
                          │   (orchestrator.ts)  │  (observe → think → act)
                          └──────────┬───────────┘
                                     │
            ┌────────────────────────┼────────────────────────┐
            ▼                        ▼                        ▼
   ┌─────────────────┐    ┌──────────────────┐    ┌────────────────────┐
   │  MCP read tools │    │  Guardrail       │    │  Action tools      │
   │  (DataHub)      │    │  (pre-exec.ts)   │    │  (GitHub, Slack)   │
   │                 │    │                  │    │                    │
   │  get_entities   │    │  PII refusal     │    │  openIssue         │
   │  get_lineage    │    │  No-merge rule   │    │  openPR (never     │
   │  search_docs    │    │  Approval gate   │    │    merged)         │
   │  get_queries    │    │                  │    │  postTriage        │
   └─────────────────┘    └──────────────────┘    └─────────┬──────────┘
                                                            │
                                                            ▼
                                                ┌────────────────────┐
                                                │  Write-back        │
                                                │  (Agent Context    │
                                                │   Kit → DataHub)   │
                                                │                    │
                                                │  post-mortem       │
                                                │  glossary proposal │
                                                │  ownership proposal│
                                                │  SLA assertion     │
                                                └─────────┬──────────┘
                                                          │
                                                          ▼
                                          next incident reads this context
                                              (the compounding beat)
```

---

## Quick start

Runs from a fresh clone in under a minute. No Docker, no live DataHub, no cloud credentials needed — the demo uses a seeded SQLite catalog.

```bash
git clone https://github.com/sodiq-code/sentinel.git
cd sentinel
bun install
bun run db:push          # creates the local SQLite DB + seeded fixtures
bun run dev              # http://localhost:3000
```

Open the dashboard, click **"Inject signal"** (or "Replay loop" for the compounding demo), and watch Sentinel triage → act → write back.

**Live vs dry-run:** a fresh clone defaults to dry-run mode (`SENTINEL_DRY_RUN=true`) — the connectors write to a local trace log instead of calling GitHub/Slack. This is a safety + reproducibility choice so a cold clone runs without tokens. The [live Vercel deployment](https://sentinel-ivory-two-79.vercel.app) runs with real tokens and fires real actions (see the [verified artefacts below](#verified-end-to-end)).

The dashboard ships a **DRY-RUN ↔ LIVE toggle** in the sticky demo control bar — flip it at runtime to switch the GitHub + Slack connectors between trace-log mode and real-API mode without touching `.env`. The toggle is persisted in a server-side `Setting` table (env vars are read-only on Vercel serverless, so the DB is the writable store) and a 3-second in-memory cache keeps warm lambdas fast. When LIVE, the control bar shows the live repo + Slack channel it will write to. To test live actions from your own clone, add your own GitHub + Slack tokens to `.env` and flip the toggle — see [`.env.example`](./.env.example).

---

## Verified end-to-end

✅ The full closed loop ran live on 2026-07-30. Every action below is a real, externally-verifiable artefact. No mocks, no dry-run.

| Action | Live artefact (click to verify) |
|---|---|
| **GitHub issue (freshness)** | [github.com/sodiq-code/sentinel-demo-pipeline/issues/12](https://github.com/sodiq-code/sentinel-demo-pipeline/issues/12) — state `open`, labels `auto-filed`, `data-ingestion`, `freshness`. |
| **GitHub issue (PII)** | [github.com/sodiq-code/sentinel-demo-pipeline/issues/13](https://github.com/sodiq-code/sentinel-demo-pipeline/issues/13) — labels `auto-filed`, `compliance`, `pii`, `security`. |
| **Slack triage (freshness)** | [sentinel-bot.slack.com/archives/C0BL9CQ4D5G/p1785375809753079](https://sentinel-bot.slack.com/archives/C0BL9CQ4D5G/p1785375809753079) — Block Kit card posted by `sentinel_bot2`. Requires workspace membership to view. |
| **Slack triage (PII)** | [sentinel-bot.slack.com/archives/C0BL9CQ4D5G/p1785375873722729](https://sentinel-bot.slack.com/archives/C0BL9CQ4D5G/p1785375873722729) — second triage card for the PII incident. Same membership requirement. |
| **DataHub write-back** | `urn:li:document:sentinel:1785375823525` — persisted to Turso; `sentinelPostMortem: true`. Visible in the dashboard's **Write-backs** tab. |
| **PII guardrail** | ✅ **Designed strength, not a weakness.** The code-level guardrail refuses to write a post-mortem to the PII-tagged asset (`customer_pii_dataset` carries `PII` + `Restricted` governance tags) — writing PII-adjacent details into a shared DataHub context doc is exactly what an autonomous agent must NOT do. Instead of leaving the write-backs panel empty, Sentinel writes a **governance refusal record** to DataHub: a structured audit entry that records the *decision* (asset URN, PII tags, refusal reason, timestamp) without exposing any PII *content*. The next incident on this asset retrieves this record and knows Sentinel previously refused to write here. The incident still fires the safe actions (real GitHub issue #13 + real Slack triage), refuses only the unsafe write, and resolves with `WRITE-BACKS=1` (status `resolved` — the refusal is a designed decision, not a degradation). The guardrail is code-level (the LLM cannot bypass it by rephrasing) and also persists a `PendingApproval` row so an operator can approve a redacted post-mortem later. |
| **Full ReAct loop** | 23 reasoning steps, status `resolved`. GitHub issue at step 13, Slack triage at step 16, DataHub write-back at step 20, final reflection at step 22. Zero skipped calls. |

The GitHub connector is **idempotent** (search-before-create): if an open issue with the same title already exists, Sentinel appends the new context as a comment instead of opening a duplicate. Enabled by default (`SENTINEL_GITHUB_DEDUP=true`).

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript 5 (strict) |
| Styling | Tailwind CSS 4 + shadcn/ui (New York) |
| Database | Prisma + SQLite (Turso libSQL in production) |
| LLM | Groq `llama-3.3-70b-versatile` (production primary) on a multi-provider failover bus — Gemini 2.0 Flash, NVIDIA NIM, and the z-ai gateway are swappable via `LLM_PROVIDER`. Code-level circuit breaker (opens after 3 consecutive 429/5xx, 90s cooldown) + token-bucket rate limiter + 429-specific backoff that honours `Retry-After`. No single provider's rate limit can stop the agent. |
| Real-time | Streaming reasoning tokens via Server-Sent Events |
| Connectors | GitHub REST API (issues + PRs, never merges), Slack Web API (Block Kit triage cards) |
| Agent pattern | ReAct loop over DataHub MCP tools + Agent Context Kit, under a code-level guardrail |

---

## Project structure

```
sentinel/
├── src/
│   ├── app/                          # Next.js App Router — single / route + API routes
│   ├── lib/
│   │   ├── agent/                    # orchestrator, tools, llm, prompts, guardrail wiring
│   │   ├── connectors/               # github.ts, slack.ts, _trace.ts (live + dry-run)
│   │   ├── guardrail/                # pre-exec.ts, pii-check.ts, policy.ts, approval-gate.ts
│   │   ├── datahub/                  # mock + live MCP/ContextKit/Ingestion clients
│   │   └── db.ts                     # Prisma client (Turso)
│   └── components/                   # shadcn/ui + custom dashboard components
├── prisma/schema.prisma              # 5 incident-state tables + signals, approvals, seed fixtures, runtime Setting
├── skill/incident-triage/            # 📦 packaged DataHub Skill (manifest + SKILL.md)
├── rfc/closed-loop-metadata-agents.md # 📐 RFC generalising the pattern beyond incidents
├── examples/                         # issue, PR patch, post-mortem, assertion, demo-replay fixtures
├── .github/workflows/ci.yml          # lint + type-check + Prisma validate + integration demo + gitleaks
└── .env.example                      # full config documentation
```

---

## Hackathon criteria mapping

| Criterion | How Sentinel delivers |
|---|---|
| **Use of DataHub** | ReAct loop over the DataHub MCP Server (read tools) + Agent Context Kit (write-back). Lineage traversal, ownership/glossary/governance-tag reads, prior post-mortem search, structured write-back of post-mortem + glossary + ownership + assertion. |
| **Technical Execution** | Multi-provider LLM with circuit breaker + failover. Code-level guardrail (not prompt-level) — PII refusal, no-merge rule, approval gate. Idempotent GitHub connector. Streaming reasoning. Prisma + Turso. |
| **Originality** | The closed-loop write-back: the post-mortem Sentinel writes in Run 1 is the context it reads in Run 2. Each incident leaves the catalog richer — structural compounding, not just a chat bot. |
| **Real-World Usefulness** | Solves a real on-call pain (Priya persona, freshness breaches, PII exposure). Real GitHub issues, real Slack posts, real DataHub write-backs — not theatre. |
| **Submission Quality** | Runs from a fresh clone in under a minute. Deterministic seed. Polished shadcn/ui console. Apache 2.0 LICENSE at the repo root. This README, a packaged DataHub Skill, and a closed-loop-metadata-agents RFC. |
| **Bonus** | Ships a new **[`incident-triage` DataHub Skill](./skill/incident-triage/)** (compatible with Cursor, Claude Code, Copilot, Codex, Gemini CLI) and a **[closed-loop-metadata-agents RFC](./rfc/closed-loop-metadata-agents.md)** generalising the pattern beyond incidents. |

---

## What ships in this repo

- ✅ **[`incident-triage` DataHub Skill](./skill/incident-triage/)** — packaged, with `manifest.json` + `SKILL.md`, compatible with Cursor / Claude Code / Copilot / Codex / Gemini CLI.
- ✅ **[closed-loop-metadata-agents RFC](./rfc/closed-loop-metadata-agents.md)** — generalises the closed-loop write-back pattern beyond incidents (applies to any metadata agent).
- ✅ **[Live demo on Vercel](https://sentinel-ivory-two-79.vercel.app)** — real LLM, real GitHub, real Slack, real DataHub write-backs.
- ✅ **Runtime DRY-RUN ↔ LIVE toggle** — flip connector mode from the dashboard without redeploying; persisted in a server-side `Setting` table.
- ✅ **"View post-mortem" / "View assertion" inspector** — click any write-back URN to read the full document Sentinel wrote back to DataHub.
- ✅ **Governance refusal write-back** — when the guardrail refuses a PII write, Sentinel still leaves a durable audit entry on DataHub (the *decision*, never the *content*).
- ✅ **API health endpoint** — `GET /api` returns service identity, runtime metadata, and a catalogue of all 24 real API routes.
- ✅ **[Apache 2.0 LICENSE](./LICENSE)** at the repo root.
- ✅ **[CI workflow](./.github/workflows/ci.yml)** — lint + type-check + Prisma validate + integration demo + gitleaks secret scan.
- ✅ **[Examples](./examples/)** — issue, PR patch, post-mortem, assertion, demo-replay fixtures.

---

## Roadmap

Sentinel is a hackathon proof-of-concept that demonstrates the closed-loop write-back pattern end-to-end. The roadmap below is the realistic path from demo to production — ordered by dependency, not by ambition.

### Phase 1 — Bind to a real DataHub instance

The demo runs against a seeded SQLite catalogue that stands in for DataHub. Production binds to a real DataHub deployment:

- Replace the `mock-datahub` client with the live GraphQL + MCP Server clients already scaffolded in `src/lib/datahub/live/`.
- Stream real assertion failures from DataHub's GraphQL API into the `SignalRecord` table.
- Verify the write-back round-trips: the post-mortem Sentinel writes in Run 1 must be retrievable via `get_entities` on Run 2 (the compounding beat, against the real catalog).

### Phase 2 — Event-driven signal intake

Replace the manual "Inject signal" button with a real listener:

- DataHub webhook subscription (or polled assertions endpoint) → `SignalRecord` row → auto-trigger the orchestrator.
- Idempotency key on `assertionUrn + firedAt` so a replayed webhook cannot double-fire an incident.
- Backpressure: queue concurrent incidents through a bounded worker so a burst of freshness breaches doesn't exhaust the LLM rate budget or the GitHub/Slack rate limits.

### Phase 3 — Approval workflow + RBAC

The guardrail already persists `PendingApproval` rows; the dashboard needs the matching UX:

- In-dashboard approve/deny on pending governance writes, with a full audit trail.
- Team-scoped incidents + role-based access (responder vs. approver vs. admin).
- Slack deep-link from the triage card straight into the approval dialog, so an on-call engineer can clear a PII write from their phone.

### Phase 4 — Expanded connector ecosystem

GitHub + Slack cover the demo. Real on-call needs more targets:

- PagerDuty / Opsgenie for paging outside business hours.
- Jira for tracking remediation tickets beyond the demo pipeline repo.
- MS Teams as a Slack alternative for enterprise tenants.
- Each new connector behind the same idempotency + dry-run toggle + trace-log contract as GitHub and Slack today.

### Phase 5 — Self-improving agent

Close the loop on agent quality, not just metadata:

- LLM-as-judge scores every written post-mortem; low scores feed back into the system prompt.
- Recurrence detection: if the same asset breaches the same SLA within N days, Sentinel escalates instead of re-triaging from scratch.
- MTTR + recurrence analytics dashboard, turning the incident log into a measurable reliability signal over time.

### Out of scope (by design)

- **Auto-merging PRs** — the no-merge rule is a permanent guardrail, not a Phase-N feature.
- **Writing PII content to DataHub** — the PII refusal is architectural; the governance refusal record is the most Sentinel will ever persist for a PII-tagged asset without explicit human approval.

---

## Acknowledgements

Block demonstrated human-driven incident response with Goose + the DataHub MCP Server. Sentinel extends that to **autonomous** response with a **write-back loop** — Block's prior art is in the sponsor-validated category, not a competitor. The `nyc-taxi` planted-freshness scenario uses the sponsor-provided sample dataset from the hackathon Resources tab.

---

## License

Apache 2.0 — see [`LICENSE`](./LICENSE). Visible in the GitHub repository About section, as required by the [hackathon rules](https://datahub.devpost.com/rules).
