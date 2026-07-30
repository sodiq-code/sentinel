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

**Live vs dry-run:** a fresh clone defaults to dry-run mode (`SENTINEL_DRY_RUN=true`) — the connectors write to a local trace log instead of calling GitHub/Slack. This is a safety + reproducibility choice so a cold clone runs without tokens. The [live Vercel deployment](https://sentinel-ivory-two-79.vercel.app) runs with real tokens and fires real actions (see the [verified artefacts below](#verified-end-to-end)). To test live actions from your own clone, add your own GitHub + Slack tokens to `.env` and set `SENTINEL_DRY_RUN=false` — see [`.env.example`](./.env.example).

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
| **PII guardrail** | ✅ **Designed strength, not a weakness.** BLOCKED the post-mortem write-back on the PII-tagged asset (`customer_pii_dataset` carries `PII` + `Restricted` governance tags). Writing a post-mortem about a PII asset into a shared DataHub context doc would leak PII-adjacent details — exactly what an autonomous agent must NOT do. The incident still fired the safe actions (real GitHub issue #13 + real Slack triage), then refused only the unsafe write. Status `degraded` = "safe subset ran, unsafe write refused" — the correct graded response. The guardrail is code-level (the LLM cannot bypass it by rephrasing) and persisted a `PendingApproval` row so an operator can approve a redacted post-mortem later. |
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
| LLM | Multi-provider with failover: Gemini 2.0 Flash (production primary) → Groq (fallback). Code-level circuit breaker + rate limiter. No single provider's rate limit can stop the agent. |
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
├── prisma/schema.prisma              # 5 core tables + seed fixtures
├── skill/incident-triage/            # 📦 packaged DataHub Skill (manifest + SKILL.md)
├── rfc/closed-loop-metadata-agents.md # 📐 RFC generalising the pattern beyond incidents
├── examples/                         # sample issue, PR patch, post-mortem, assertion, demo-replay fixtures
├── .github/workflows/ci.yml          # lint + type-check + integration demo
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
- ✅ **[Apache 2.0 LICENSE](./LICENSE)** at the repo root.
- ✅ **[CI workflow](./.github/workflows/ci.yml)** — lint + type-check + integration demo.
- ✅ **[Examples](./examples/)** — sample issue, PR patch, post-mortem, assertion, demo-replay fixtures.

---

## Acknowledgements

Block demonstrated human-driven incident response with Goose + the DataHub MCP Server. Sentinel extends that to **autonomous** response with a **write-back loop** — Block's prior art is in the sponsor-validated category, not a competitor. The `nyc-taxi` planted-freshness scenario uses the sponsor-provided sample dataset from the hackathon Resources tab.

---

## License

Apache 2.0 — see [`LICENSE`](./LICENSE). Visible in the GitHub repository About section, as required by the [hackathon rules](https://datahub.devpost.com/rules).
