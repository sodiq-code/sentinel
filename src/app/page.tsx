import {
  Activity,
  ArrowRight,
  BookOpen,
  Boxes,
  BrainCircuit,
  CheckCircle2,
  Database,
  FileCode2,
  FileText,
  Github,
  Layers,
  Lock,
  Network,
  Radar,
  ScrollText,
  Send,
  ShieldAlert,
  Slack,
  Terminal,
} from "lucide-react";
import Link from "next/link";

const PHASES = [
  {
    id: 0,
    name: "Foundation & Repo Hygiene",
    status: "DONE",
    detail:
      "Apache 2.0 LICENSE, .env.example, README, repo layout, sentinel/ TypeScript interface contracts, skill/ + rfc/ + examples/, Prisma schema (5 tables), CI workflow stub.",
    deliverable: "Repo skeleton + database schema pushed",
  },
  {
    id: 1,
    name: "DataHub Mock + Seed",
    status: "NEXT",
    detail:
      "McpClient (12 tools), ContextKitClient (7 tools), IngestionClient (REST fallback). Seeded nyc-taxi planted-freshness, showcase-ecommerce cross-platform lineage, customer_pii PII scenario.",
    deliverable: "A script that prints lineage",
  },
  {
    id: 2,
    name: "Orchestrator + ReAct Loop",
    status: "PENDING",
    detail:
      "ReAct loop calling NVIDIA NIM (nvidia/llama-3.3-nemotron-super-49b-v1) at temperature 0. Layered system prompt committed to repo. Visible reasoning via SSE.",
    deliverable: "Console shows the agent traversing lineage and printing a diagnosis",
  },
  {
    id: 3,
    name: "Action Connectors + Guardrails",
    status: "PENDING",
    detail:
      "GitHubConnector (openIssue, openPR — never merges), SlackConnector (postTriage). Guardrail: PII refusal, no-merge policy, human-approval gate, structured tool-call inputs.",
    deliverable: "Agent opens a real GitHub issue + PR in the sandbox repo; refuses a PII action",
  },
  {
    id: 4,
    name: "Write-back + Audit Log",
    status: "PENDING",
    detail:
      "WriteBackIngester (context doc + assertion + 2 proposals). Dual write-back path (Agent Context Kit primary, REST ingestion fallback). AuditLog mirrored as DataHub Assertion/Event.",
    deliverable: "A DataHub context doc + assertion created by the agent",
  },
  {
    id: 5,
    name: "Incident Console UI",
    status: "PENDING",
    detail:
      "Real incident console at / — IncidentHeader, LineageGraph, ReasoningStream, ActionsPanel, GuardrailPanel, WriteBackPanel, AuditLogDrawer, DemoControlBar, Footer.",
    deliverable: "The final demo runs from a fresh clone in <1 min",
  },
  {
    id: 6,
    name: "Skill + RFC + README",
    status: "PENDING",
    detail:
      "incident-triage Skill (this Phase 0 already ships the draft), the RFC (this Phase 0 already ships the draft), and the README (this Phase 0 ships the v1). Phase 6 polishes + files the Skill PR to datahub-project/datahub-skills.",
    deliverable: "An open PR on datahub-skills + a published RFC",
  },
  {
    id: 7,
    name: "CI + Hardening + Submission Prep",
    status: "PENDING",
    detail:
      "GitHub Actions CI runs lint + the integration demo end-to-end. gitleaks secret scan. Dry-run mode (pre-recorded trace replayed through the same console UI). Devpost entry.",
    deliverable: "A green CI run + a submitted Devpost entry",
  },
] as const;

const COMPONENTS = [
  {
    icon: Activity,
    name: "SignalListener",
    role: "Subscribe to DataHub assertion failures (webhook or poll). Idempotent.",
    phase: 1,
  },
  {
    icon: BrainCircuit,
    name: "Orchestrator",
    role: "ReAct reasoning loop (Plan → Act → Observe → Reflect). NVIDIA Nemotron Super 49B @ temperature 0.",
    phase: 2,
  },
  {
    icon: Network,
    name: "DataHubReadTools",
    role: "12 MCP Server tools: search, get_entities, get_lineage, list_schema_fields, search_documents, grep_documents, get_dataset_queries, …",
    phase: 1,
  },
  {
    icon: Boxes,
    name: "DataHubWriteTools",
    role: "7 Agent Context Kit tools (include_mutations=True): save_document, add_glossary_terms, add_owners, …",
    phase: 4,
  },
  {
    icon: Github,
    name: "GitHubConnector",
    role: "openIssue, openPR — never merges (PDF §9.3.5 no-merge policy). Sandbox token scoped to one demo repo.",
    phase: 3,
  },
  {
    icon: Slack,
    name: "SlackConnector",
    role: "postTriage to the sandbox on-call channel. Sandbox token scoped to one channel.",
    phase: 3,
  },
  {
    icon: Lock,
    name: "Guardrail",
    role: "PII refusal · no-merge · human-approval gate · structured tool-call inputs (PDF §9.3.5 + §12.3).",
    phase: 3,
  },
  {
    icon: Send,
    name: "WriteBackIngester",
    role: "Compose + submit DataHub GraphQL proposals. Dual path: Agent Context Kit primary, REST ingestion fallback (PDF §12.2).",
    phase: 4,
  },
  {
    icon: ScrollText,
    name: "AuditLog",
    role: "Persist every tool call, action, and write-back. SQLite + mirrored as a DataHub Assertion/Event (PDF §9.3.5).",
    phase: 2,
  },
  {
    icon: Terminal,
    name: "DemoDriver",
    role: "Inject nyc-taxi freshness failure; replay loop; dry-run mode. CLI: `sentinel demo --scenario nyc-taxi-freshness`.",
    phase: 5,
  },
] as const;

const DELIVERABLES = [
  { icon: FileText, label: "README.md", desc: "Quickstart, architecture, pinned versions" },
  { icon: ShieldAlert, label: "LICENSE", desc: "Apache 2.0 (visible in repo About)" },
  { icon: Layers, label: "package.json", desc: "Pinned deps (Next.js 16, LangChain, Prisma)" },
  { icon: Lock, label: ".env.example", desc: "All required env vars (no secrets)" },
  { icon: BrainCircuit, label: "sentinel/", desc: "TypeScript interface contracts (orchestrator, guardrail, connectors, writeback, audit, demo_driver)" },
  { icon: BookOpen, label: "skill/incident-triage/", desc: "The bonus DataHub Skill (SKILL.md, manifest.json, references/)" },
  { icon: ScrollText, label: "rfc/closed-loop-metadata-agents.md", desc: "The second bonus artefact — the general pattern" },
  { icon: FileCode2, label: "examples/", desc: "sample_issue.md, sample_pr.patch, sample_postmortem.json, sample_assertion.json" },
  { icon: Database, label: "prisma/schema.prisma", desc: "5 tables (incidents, tool_calls, actions, writebacks, audit_log) + demo seed models" },
  { icon: Github, label: ".github/workflows/ci.yml", desc: "Lint + integration demo stub" },
] as const;

export default function Home() {
  return (
    <main className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Top bar */}
      <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Radar className="h-6 w-6 text-emerald-500" aria-hidden />
            <span className="font-mono text-sm font-bold tracking-[0.2em]">SENTINEL</span>
            <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">
              Autonomous Data Incident Response · DataHub
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" aria-hidden />
              PHASE 0 · FOUNDATION ✓
            </span>
            <Link
              href="https://github.com/sodiq-code/sentinel"
              className="hidden items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground sm:inline-flex"
              target="_blank"
              rel="noreferrer"
            >
              <Github className="h-3.5 w-3.5" aria-hidden /> sodiq-code/sentinel
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-border/40">
        <div className="container mx-auto max-w-6xl px-4 py-16 md:py-24">
          <div className="flex flex-col items-start gap-6">
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-3 py-1 text-xs font-medium text-muted-foreground">
              Built for{" "}
              <Link
                href="https://datahub.devpost.com/"
                target="_blank"
                rel="noreferrer"
                className="text-emerald-600 dark:text-emerald-400 hover:underline"
              >
                Build with DataHub: The Agent Hackathon
              </Link>
              · Challenge 1: Agents That Do Real Work
            </span>
            <h1 className="max-w-4xl text-4xl font-bold tracking-tight md:text-6xl">
              An <span className="text-emerald-500">autonomous data incident response agent</span>{" "}
              for DataHub.
            </h1>
            <p className="max-w-2xl text-lg text-muted-foreground md:text-xl">
              Sentinel turns DataHub into the substrate for autonomous data incident response.
              When a freshness, schema, or quality signal trips in DataHub, Sentinel autonomously
              triages the incident, traverses lineage to identify the likely root cause, takes real
              actions, and writes a structured post-mortem plus proposed context enrichments back
              to DataHub — so the next incident is faster and the agent inherits the knowledge.
            </p>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <span className="font-mono text-xs text-muted-foreground">The closed loop:</span>
              {[
                "Observe signal",
                "Ground in context graph",
                "Reason over lineage",
                "Act in the world",
                "Write back to DataHub",
              ].map((step, i) => (
                <span key={step} className="flex items-center gap-2">
                  <span className="rounded-md border border-border bg-muted/30 px-2 py-1 text-xs font-medium">
                    {step}
                  </span>
                  {i < 4 && <ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden />}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Phase 0 status banner */}
      <section className="border-b border-border/40 bg-emerald-500/[0.03]">
        <div className="container mx-auto max-w-6xl px-4 py-10">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10">
                <CheckCircle2 className="h-6 w-6 text-emerald-500" aria-hidden />
              </div>
              <div>
                <h2 className="text-xl font-semibold">Phase 0 — Foundation &amp; Repo Hygiene complete</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Apache 2.0 LICENSE · repo layout per PDF §10.3 · sentinel/ TypeScript interface
                  contracts · skill/ + rfc/ + examples/ · Prisma schema (5 tables) pushed · CI
                  workflow stub. <span className="font-mono">bun run db:push</span> ✓
                </p>
              </div>
            </div>
            <div className="text-sm text-muted-foreground md:text-right">
              <p className="font-medium text-foreground">Next: Phase 1 — DataHub Mock + Seed</p>
              <p className="text-xs">A script that prints lineage · 1 day</p>
            </div>
          </div>
        </div>
      </section>

      {/* Phase 0 deliverables grid */}
      <section className="border-b border-border/40">
        <div className="container mx-auto max-w-6xl px-4 py-12">
          <h3 className="mb-1 text-2xl font-semibold">Phase 0 deliverables</h3>
          <p className="mb-8 text-sm text-muted-foreground">
            Every artefact shipped in this commit. Awaiting your approval to start Phase 1.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {DELIVERABLES.map((d) => (
              <div
                key={d.label}
                className="rounded-lg border border-border bg-card/50 p-4 transition-colors hover:bg-card"
              >
                <div className="flex items-start gap-3">
                  <d.icon className="h-5 w-5 shrink-0 text-emerald-500" aria-hidden />
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-medium break-all">{d.label}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{d.desc}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Architecture diagram */}
      <section className="border-b border-border/40 bg-muted/[0.02]">
        <div className="container mx-auto max-w-6xl px-4 py-12">
          <h3 className="mb-1 text-2xl font-semibold">Architecture (PDF §9.3.1)</h3>
          <p className="mb-8 text-sm text-muted-foreground">
            One orchestrator agent (ReAct-style reasoning loop), MCP read tools, Agent Context Kit
            write tools, action connectors, a guardrail layer, and a write-back ingester. Each
            component is justified, not decorative.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {COMPONENTS.map((c) => (
              <div
                key={c.name}
                className="relative rounded-lg border border-border bg-card/50 p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <c.icon className="h-5 w-5 shrink-0 text-foreground/80" aria-hidden />
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                      c.phase === 0
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    Phase {c.phase}
                  </span>
                </div>
                <p className="mt-3 font-mono text-sm font-semibold">{c.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">{c.role}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Phase roadmap */}
      <section className="border-b border-border/40">
        <div className="container mx-auto max-w-6xl px-4 py-12">
          <h3 className="mb-1 text-2xl font-semibold">Phase roadmap (PDF §10.1)</h3>
          <p className="mb-8 text-sm text-muted-foreground">
            8 phases. Each ends with a demoable increment. The unit of progress is a demoable
            increment, not a story point.
          </p>
          <div className="space-y-2">
            {PHASES.map((p) => {
              const isDone = p.status === "DONE";
              const isNext = p.status === "NEXT";
              return (
                <div
                  key={p.id}
                  className={`flex flex-col gap-2 rounded-lg border p-4 md:flex-row md:items-center md:justify-between ${
                    isDone
                      ? "border-emerald-500/30 bg-emerald-500/[0.03]"
                      : isNext
                        ? "border-amber-500/40 bg-amber-500/[0.05]"
                        : "border-border bg-card/30"
                  }`}
                >
                  <div className="flex items-start gap-3 md:items-center">
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-mono font-medium ${
                        isDone
                          ? "bg-emerald-500 text-white"
                          : isNext
                            ? "bg-amber-500 text-white"
                            : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {p.id}
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold">{p.name}</p>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            isDone
                              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                              : isNext
                                ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                                : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {p.status}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{p.detail}</p>
                    </div>
                  </div>
                  <div className="ml-11 shrink-0 md:ml-0 md:max-w-xs">
                    <p className="text-xs font-mono text-muted-foreground">{p.deliverable}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Bonus callout */}
      <section className="border-b border-border/40 bg-muted/[0.02]">
        <div className="container mx-auto max-w-6xl px-4 py-12">
          <h3 className="mb-2 text-2xl font-semibold">Bonus open-source contribution</h3>
          <p className="mb-8 max-w-2xl text-sm text-muted-foreground">
            Sentinel ships not just a project but two reusable artefacts for the DataHub agent
            stack — a first-class bonus contribution targeting the hackathon&apos;s Criterion 6.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-border bg-card/50 p-6">
              <div className="flex items-center gap-2">
                <BookOpen className="h-5 w-5 text-emerald-500" aria-hidden />
                <h4 className="font-semibold">skill/incident-triage/</h4>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                A new DataHub Skill following the datahub-skills SKILL.md format. Teaches any agent
                (Claude Code, Cursor, Codex, Copilot, Gemini) the same closed-loop incident triage
                workflow Sentinel runs in code. PR target:{" "}
                <span className="font-mono text-xs">datahub-project/datahub-skills</span>.
              </p>
              <p className="mt-3 text-xs text-muted-foreground">
                Ships in Phase 0 (draft). Polished + filed in Phase 6.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card/50 p-6">
              <div className="flex items-center gap-2">
                <ScrollText className="h-5 w-5 text-emerald-500" aria-hidden />
                <h4 className="font-semibold">rfc/closed-loop-metadata-agents.md</h4>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                The general pattern: observe signal → ground in context graph → reason → act →
                write back → await feedback → update graph. Generalisable beyond incidents (ML
                audits, compliance, code generation). The second bonus artefact.
              </p>
              <p className="mt-3 text-xs text-muted-foreground">
                Ships in Phase 0 (draft). Published in Phase 6.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer (sticky to bottom — mt-auto on the wrapper) */}
      <footer className="mt-auto border-t border-border/40 bg-muted/[0.02]">
        <div className="container mx-auto max-w-6xl px-4 py-8">
          <div className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
            <div className="flex items-center gap-2">
              <Radar className="h-4 w-4 text-emerald-500" aria-hidden />
              <span className="font-mono text-xs font-bold tracking-widest">SENTINEL</span>
              <span className="text-xs text-muted-foreground">
                · Apache 2.0 · Built for Build with DataHub: The Agent Hackathon
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
              <Link
                href="https://github.com/sodiq-code/sentinel"
                target="_blank"
                rel="noreferrer"
                className="hover:text-foreground inline-flex items-center gap-1.5"
              >
                <Github className="h-3.5 w-3.5" aria-hidden /> GitHub
              </Link>
              <Link
                href="https://datahub.devpost.com/"
                target="_blank"
                rel="noreferrer"
                className="hover:text-foreground"
              >
                Hackathon
              </Link>
              <Link
                href="https://docs.datahub.com/docs/features/feature-guides/mcp/"
                target="_blank"
                rel="noreferrer"
                className="hover:text-foreground"
              >
                DataHub MCP
              </Link>
              <Link
                href="https://docs.datahub.com/docs/dev-guides/agent-context/agent-context/"
                target="_blank"
                rel="noreferrer"
                className="hover:text-foreground"
              >
                Agent Context Kit
              </Link>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                Phase 0 · Foundation ✓
              </span>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
