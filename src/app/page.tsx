"use client";

import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Boxes,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Database,
  FileCode2,
  FileText,
  Github,
  Layers,
  LineChart,
  Loader2,
  Lock,
  Network,
  Radar,
  RefreshCw,
  ScrollText,
  Send,
  ShieldAlert,
  Slack,
  Terminal,
} from "lucide-react";
import Link from "next/link";
import { useState, useMemo } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Static content (phases, components, deliverables)
// ---------------------------------------------------------------------------

const PHASES = [
  {
    id: 0,
    name: "Foundation & Repo Hygiene",
    status: "DONE" as const,
    detail:
      "Apache 2.0 LICENSE, .env.example, README, repo layout, sentinel/ TypeScript interface contracts, skill/ + rfc/ + examples/, Prisma schema (5 tables), CI workflow stub.",
    deliverable: "Repo skeleton + database schema pushed",
  },
  {
    id: 1,
    name: "DataHub Mock + Seed",
    status: "DONE" as const,
    detail:
      "McpClient (12 tools), ContextKitClient (7 tools), IngestionClient (REST fallback). Seeded nyc-taxi planted-freshness, showcase-ecommerce cross-platform lineage, customer_pii PII scenario. Verified live below.",
    deliverable: "A script that prints lineage ✓ (try it ↓)",
  },
  {
    id: 2,
    name: "Orchestrator + ReAct Loop",
    status: "NEXT" as const,
    detail:
      "ReAct loop calling NVIDIA NIM (nvidia/llama-3.3-nemotron-super-49b-v1) at temperature 0. Layered system prompt committed to repo. Visible reasoning via SSE.",
    deliverable: "Console shows the agent traversing lineage and printing a diagnosis",
  },
  {
    id: 3,
    name: "Action Connectors + Guardrails",
    status: "PENDING" as const,
    detail:
      "GitHubConnector (openIssue, openPR — never merges), SlackConnector (postTriage). Guardrail: PII refusal, no-merge policy, human-approval gate, structured tool-call inputs.",
    deliverable: "Agent opens a real GitHub issue + PR in the sandbox repo; refuses a PII action",
  },
  {
    id: 4,
    name: "Write-back + Audit Log",
    status: "PENDING" as const,
    detail:
      "WriteBackIngester (context doc + assertion + 2 proposals). Dual write-back path (Agent Context Kit primary, REST ingestion fallback). AuditLog mirrored as DataHub Assertion/Event.",
    deliverable: "A DataHub context doc + assertion created by the agent",
  },
  {
    id: 5,
    name: "Incident Console UI",
    status: "PENDING" as const,
    detail:
      "Real incident console at / — IncidentHeader, LineageGraph, ReasoningStream, ActionsPanel, GuardrailPanel, WriteBackPanel, AuditLogDrawer, DemoControlBar, Footer.",
    deliverable: "The final demo runs from a fresh clone in <1 min",
  },
  {
    id: 6,
    name: "Skill + RFC + README",
    status: "PENDING" as const,
    detail:
      "incident-triage Skill (Phase 0 draft), the RFC (Phase 0 draft), README (Phase 0 v1). Phase 6 polishes + files the Skill PR to datahub-project/datahub-skills.",
    deliverable: "An open PR on datahub-skills + a published RFC",
  },
  {
    id: 7,
    name: "CI + Hardening + Submission Prep",
    status: "PENDING" as const,
    detail:
      "GitHub Actions CI runs lint + the integration demo end-to-end. gitleaks secret scan. Dry-run mode (pre-recorded trace replayed through the same console UI). Devpost entry.",
    deliverable: "A green CI run + a submitted Devpost entry",
  },
] as const;

const COMPONENTS = [
  { icon: Activity, name: "SignalListener", role: "Subscribe to DataHub assertion failures (webhook or poll). Idempotent.", phase: 1 },
  { icon: BrainCircuit, name: "Orchestrator", role: "ReAct reasoning loop (Plan → Act → Observe → Reflect). NVIDIA Nemotron Super 49B @ temperature 0.", phase: 2 },
  { icon: Network, name: "DataHubReadTools", role: "12 MCP Server tools: search, get_entities, get_lineage, list_schema_fields, search_documents, grep_documents, get_dataset_queries, …", phase: 1 },
  { icon: Boxes, name: "DataHubWriteTools", role: "7 Agent Context Kit tools (include_mutations=True): save_document, add_glossary_terms, add_owners, …", phase: 4 },
  { icon: Github, name: "GitHubConnector", role: "openIssue, openPR — never merges (PDF §9.3.5 no-merge policy). Sandbox token scoped to one demo repo.", phase: 3 },
  { icon: Slack, name: "SlackConnector", role: "postTriage to the sandbox on-call channel. Sandbox token scoped to one channel.", phase: 3 },
  { icon: Lock, name: "Guardrail", role: "PII refusal · no-merge · human-approval gate · structured tool-call inputs (PDF §9.3.5 + §12.3).", phase: 3 },
  { icon: Send, name: "WriteBackIngester", role: "Compose + submit DataHub GraphQL proposals. Dual path: Agent Context Kit primary, REST ingestion fallback (PDF §12.2).", phase: 4 },
  { icon: ScrollText, name: "AuditLog", role: "Persist every tool call, action, and write-back. SQLite + mirrored as a DataHub Assertion/Event (PDF §9.3.5).", phase: 2 },
  { icon: Terminal, name: "DemoDriver", role: "Inject nyc-taxi freshness failure; replay loop; dry-run mode. CLI: `sentinel demo --scenario nyc-taxi-freshness`.", phase: 5 },
] as const;

const PHASE1_DELIVERABLES = [
  { icon: FileCode2, label: "src/lib/datahub/types.ts", desc: "All shared DTOs + the 3 interfaces (McpClient, ContextKitClient, IngestionClient)" },
  { icon: Network, label: "src/lib/datahub/mock/mock-datahub.ts", desc: "Mock impl of all 3 interfaces against Prisma SQLite + getSeedOverview() + printLineage()" },
  { icon: Boxes, label: "src/lib/datahub/live/{live-mcp,live-contextkit,live-ingestion}.ts", desc: "Real HTTP/GraphQL clients — Phase 1 ships the structure, DATAHUB_MODE flips to them" },
  { icon: Database, label: "prisma/seed.ts", desc: "Deterministic idempotent seed: 3 scenarios, 9 assets, 6 edges, 4 assertions, 1 prior post-mortem" },
  { icon: Terminal, label: "prisma/print-lineage.ts", desc: "The Phase 1 deliverable — `bun run db:print-lineage <urn>` prints a lineage tree" },
  { icon: Radar, label: "src/app/api/datahub/*", desc: "7 API routes: status, seed/overview, search, lineage, asset, assertions, print-lineage" },
] as const;

// ---------------------------------------------------------------------------
// Phase 1 live demo types (mirror the API responses)
// ---------------------------------------------------------------------------

interface StatusResponse {
  mode: "demo" | "live";
  liveModeAvailable: boolean;
  seeded: boolean;
  counts?: {
    assets: number;
    lineageEdges: number;
    assertions: number;
    contextDocs: number;
    failingAssertions: number;
  };
  scenarios: string[];
  phase: number;
  message: string;
}

interface SeedOverview {
  mode: "demo";
  scenarios: Array<{
    id: string;
    name: string;
    description: string;
    assets: Array<{
      urn: string;
      name: string;
      type: string;
      platform?: string;
      description?: string;
      governanceTags: Array<{ name: string; level: string }>;
      lastModifiedAt?: number;
      scenarioId?: string;
    }>;
    lineageEdges: Array<{ fromUrn: string; toUrn: string; via?: string }>;
    assertions: Array<{
      urn: string;
      assetUrn: string;
      type: string;
      status: string;
      description: string;
      slaSeconds?: number;
      lastEvaluatedAt: string;
      failureReason?: string;
      scenarioId?: string;
    }>;
    contextDocs: Array<{
      urn: string;
      title: string;
      assetUrn: string;
      sentinelPostMortem: boolean;
      createdAt: string;
    }>;
  }>;
}

const PLATFORM_COLOR: Record<string, string> = {
  s3: "text-amber-600 dark:text-amber-400 border-amber-500/30 bg-amber-500/10",
  spark: "text-rose-600 dark:text-rose-400 border-rose-500/30 bg-rose-500/10",
  dbt: "text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
  snowflake: "text-cyan-600 dark:text-cyan-400 border-cyan-500/30 bg-cyan-500/10",
  looker: "text-violet-600 dark:text-violet-400 border-violet-500/30 bg-violet-500/10",
  postgres: "text-blue-600 dark:text-blue-400 border-blue-500/30 bg-blue-500/10",
};

function platformBadge(p?: string) {
  if (!p) return "border-border bg-muted/30 text-muted-foreground";
  return PLATFORM_COLOR[p] ?? "border-border bg-muted/30 text-muted-foreground";
}

function shortName(urn: string) {
  // urn:li:dataset:(urn:li:dataPlatform:s3,raw_s3_nyc_taxi_trips,PROD) → raw_s3_nyc_taxi_trips
  const m = urn.match(/,([^,()]+),(?:PROD|DEV|TEST|FULL_TABLES)/);
  return m?.[1] ?? urn.split(":").pop() ?? urn;
}

function relTime(epochMs: number) {
  const diffMs = Date.now() - epochMs;
  const hours = diffMs / 3.6e6;
  if (hours < 1) return `${Math.round(diffMs / 6e4)}m ago`;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// The interactive Phase 1 panel
// ---------------------------------------------------------------------------

function Phase1LivePanel() {
  const status = useQuery<StatusResponse>({
    queryKey: ["datahub", "status"],
    queryFn: async () => {
      const r = await fetch("/api/datahub/status", { cache: "no-store" });
      if (!r.ok) throw new Error(`status ${r.status}`);
      return r.json();
    },
    refetchOnWindowFocus: false,
  });

  const overview = useQuery<SeedOverview>({
    queryKey: ["datahub", "seed-overview"],
    queryFn: async () => {
      const r = await fetch("/api/datahub/seed/overview", { cache: "no-store" });
      if (!r.ok) throw new Error(`overview ${r.status}`);
      return r.json();
    },
    refetchOnWindowFocus: false,
  });

  // Interactive lineage printer
  const [selectedUrn, setSelectedUrn] = useState(
    "urn:li:dataset:(urn:li:dataPlatform:s3,raw_s3_nyc_taxi_trips,PROD)",
  );
  const [direction, setDirection] = useState<"downstream" | "upstream">("downstream");
  const [maxHops, setMaxHops] = useState(3);

  const lineage = useQuery<string>({
    queryKey: ["datahub", "print-lineage", selectedUrn, direction, maxHops],
    queryFn: async () => {
      const u = new URL("/api/datahub/print-lineage", window.location.origin);
      u.searchParams.set("urn", selectedUrn);
      u.searchParams.set("direction", direction);
      u.searchParams.set("maxHops", String(maxHops));
      const r = await fetch(u.toString(), { cache: "no-store" });
      if (!r.ok) throw new Error(`print-lineage ${r.status}`);
      return r.text();
    },
    refetchOnWindowFocus: false,
  });

  const isLoading = status.isLoading || overview.isLoading;
  const isError = status.isError || overview.isError;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-emerald-500" aria-hidden />
        <span className="ml-3 text-sm text-muted-foreground">
          Loading seeded DataHub graph from Prisma SQLite…
        </span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-rose-500/40 bg-rose-500/[0.05] p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-rose-500" aria-hidden />
          <div>
            <p className="font-mono text-sm font-semibold text-rose-600 dark:text-rose-400">
              Phase 1 mock unreachable
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {(status.error as Error)?.message ?? (overview.error as Error)?.message ??
                "The /api/datahub/* routes did not respond. Did `bun run db:seed` run?"}
            </p>
            <button
              type="button"
              onClick={() => {
                void status.refetch();
                void overview.refetch();
              }}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-500/20"
            >
              <RefreshCw className="h-3 w-3" aria-hidden /> Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  const s = status.data;
  const ov = overview.data;

  return (
    <div className="space-y-8">
      {/* Status strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Mode" value={s?.mode ?? "—"} mono />
        <MetricCard label="Seed assets" value={String(s?.counts?.assets ?? 0)} />
        <MetricCard label="Lineage edges" value={String(s?.counts?.lineageEdges ?? 0)} />
        <MetricCard
          label="Failing assertions"
          value={String(s?.counts?.failingAssertions ?? 0)}
          tone={s?.counts?.failingAssertions ? "danger" : "ok"}
        />
      </div>

      {/* Scenarios */}
      <div className="space-y-4">
        {ov?.scenarios.map((sc) => (
          <ScenarioCard key={sc.id} scenario={sc} />
        ))}
      </div>

      {/* Interactive lineage printer */}
      <div className="rounded-lg border border-border bg-card/50 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-emerald-500" aria-hidden />
            <h4 className="font-mono text-sm font-semibold">
              bun run db:print-lineage
            </h4>
            <span className="text-xs text-muted-foreground">
              · the Phase 1 deliverable, live via API
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
              <button
                type="button"
                onClick={() => setDirection("downstream")}
                className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                  direction === "downstream"
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <ArrowDown className="h-3 w-3" aria-hidden /> downstream
              </button>
              <button
                type="button"
                onClick={() => setDirection("upstream")}
                className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                  direction === "upstream"
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <ArrowUp className="h-3 w-3" aria-hidden /> upstream
              </button>
            </div>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              max hops
              <input
                type="number"
                min={1}
                max={6}
                value={maxHops}
                onChange={(e) => setMaxHops(Math.max(1, Math.min(6, Number(e.target.value))))}
                className="w-12 rounded border border-border bg-background px-1.5 py-0.5 text-xs"
              />
            </label>
            <button
              type="button"
              onClick={() => void lineage.refetch()}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs font-medium hover:bg-muted"
            >
              <RefreshCw className="h-3 w-3" aria-hidden /> re-run
            </button>
          </div>
        </div>

        {/* URN selector */}
        <div className="mt-4">
          <label htmlFor="urn-select" className="block text-xs font-medium text-muted-foreground">
            Asset URN
          </label>
          <select
            id="urn-select"
            value={selectedUrn}
            onChange={(e) => setSelectedUrn(e.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs"
          >
            {ov?.scenarios.flatMap((sc) =>
              sc.assets.map((a) => (
                <option key={a.urn} value={a.urn}>
                  [{sc.id}] {a.platform} · {a.name}
                </option>
              )),
            )}
          </select>
        </div>

        {/* Tree output */}
        <pre
          className="mt-4 max-h-72 overflow-auto rounded-md border border-border bg-zinc-950/60 p-4 font-mono text-xs leading-relaxed text-emerald-300 dark:text-emerald-300"
          aria-live="polite"
        >
          {lineage.isLoading ? (
            <span className="text-muted-foreground">Loading lineage…</span>
          ) : lineage.isError ? (
            <span className="text-rose-400">
              Error: {(lineage.error as Error)?.message}
            </span>
          ) : (
            lineage.data
          )}
        </pre>
        <p className="mt-2 text-xs text-muted-foreground">
          Renders via <span className="font-mono">MockMcpClient.get_lineage()</span> → the
          same code path the orchestrator (Phase 2) will call. Flipping
          <span className="font-mono"> DATAHUB_MODE=live</span> routes the call to
          <span className="font-mono"> LiveMcpClient</span> (HTTP to your DataHub MCP server).
        </p>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  tone = "default",
  mono = false,
}: {
  label: string;
  value: string;
  tone?: "default" | "ok" | "danger";
  mono?: boolean;
}) {
  const toneClass =
    tone === "danger"
      ? "text-rose-600 dark:text-rose-400 border-rose-500/30 bg-rose-500/10"
      : tone === "ok"
        ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
        : "text-foreground border-border bg-card/50";
  return (
    <div className={`rounded-lg border p-3 ${toneClass}`}>
      <p className="text-[10px] font-medium uppercase tracking-wider opacity-70">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function ScenarioCard({ scenario }: { scenario: SeedOverview["scenarios"][number] }) {
  const [open, setOpen] = useState(scenario.id === "nyc-taxi-freshness");
  const failing = scenario.assertions.filter((a) => a.status === "failing");
  return (
    <div className="rounded-lg border border-border bg-card/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-card/60"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3">
          {open ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden />
          )}
          <span className="font-mono text-sm font-semibold">{scenario.id}</span>
          <span className="text-xs text-muted-foreground">{scenario.name}</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-full border border-border bg-muted/30 px-2 py-0.5 text-muted-foreground">
            {scenario.assets.length} assets
          </span>
          <span className="rounded-full border border-border bg-muted/30 px-2 py-0.5 text-muted-foreground">
            {scenario.lineageEdges.length} edges
          </span>
          <span className="rounded-full border border-border bg-muted/30 px-2 py-0.5 text-muted-foreground">
            {scenario.assertions.length} assertions
          </span>
          {failing.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 font-medium text-rose-600 dark:text-rose-400">
              <AlertTriangle className="h-3 w-3" aria-hidden /> {failing.length} failing
            </span>
          )}
        </div>
      </button>
      {open && (
        <div className="border-t border-border/50 px-4 py-4 space-y-4">
          <p className="text-xs text-muted-foreground">{scenario.description}</p>

          {/* Assets */}
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Assets
            </p>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {scenario.assets.map((a) => (
                <div
                  key={a.urn}
                  className="rounded-md border border-border bg-background/40 p-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-mono font-medium ${platformBadge(a.platform)}`}
                    >
                      {a.platform}
                    </span>
                    <span className="font-mono text-xs font-semibold truncate">{a.name}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                    {a.description}
                  </p>
                  {a.governanceTags.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {a.governanceTags.map((t) => (
                        <span
                          key={t.name}
                          className="rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-400"
                        >
                          {t.name}
                        </span>
                      ))}
                    </div>
                  )}
                  {a.lastModifiedAt && (
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      last modified: {relTime(a.lastModifiedAt)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Lineage edges */}
          {scenario.lineageEdges.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Lineage edges
              </p>
              <div className="flex flex-wrap gap-2 text-[11px]">
                {scenario.lineageEdges.map((e, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/20 px-2 py-1 font-mono"
                  >
                    {shortName(e.fromUrn)}
                    <ArrowRight className="h-3 w-3 text-emerald-500" aria-hidden />
                    {shortName(e.toUrn)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Assertions */}
          {scenario.assertions.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Assertions
              </p>
              <div className="space-y-1.5">
                {scenario.assertions.map((a) => {
                  const isFailing = a.status === "failing";
                  return (
                    <div
                      key={a.urn}
                      className={`rounded-md border p-2.5 text-xs ${
                        isFailing
                          ? "border-rose-500/40 bg-rose-500/[0.05]"
                          : "border-emerald-500/30 bg-emerald-500/[0.03]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            isFailing
                              ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                              : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                          }`}
                        >
                          {isFailing ? (
                            <AlertTriangle className="h-2.5 w-2.5" aria-hidden />
                          ) : (
                            <CheckCircle2 className="h-2.5 w-2.5" aria-hidden />
                          )}
                          {a.status}
                        </span>
                        <span className="font-mono text-[11px] font-semibold uppercase">{a.type}</span>
                        <span className="font-mono text-[10px] text-muted-foreground truncate">
                          on {shortName(a.assetUrn)}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">{a.description}</p>
                      {isFailing && a.failureReason && (
                        <p className="mt-1 text-[11px] font-mono text-rose-600 dark:text-rose-400">
                          ⚠ {a.failureReason}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Context docs (post-mortems) */}
          {scenario.contextDocs.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Prior context docs (compounding evidence for Run 2)
              </p>
              {scenario.contextDocs.map((d) => (
                <div
                  key={d.urn}
                  className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.04] p-2.5"
                >
                  <div className="flex items-center gap-2">
                    <ScrollText className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
                    <span className="text-xs font-medium">{d.title}</span>
                    {d.sentinelPostMortem && (
                      <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-600 dark:text-emerald-400">
                        Sentinel-authored
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root page
// ---------------------------------------------------------------------------

export default function Home() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
      }),
  );

  return (
    <QueryClientProvider client={client}>
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
                PHASE 1 · MOCK + SEED ✓
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

        {/* Phase 1 status banner */}
        <section className="border-b border-border/40 bg-emerald-500/[0.03]">
          <div className="container mx-auto max-w-6xl px-4 py-10">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="flex items-start gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10">
                  <CheckCircle2 className="h-6 w-6 text-emerald-500" aria-hidden />
                </div>
                <div>
                  <h2 className="text-xl font-semibold">Phase 1 — DataHub Mock + Seed complete</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    3 client interfaces (McpClient, ContextKitClient, IngestionClient) · mock + live
                    impls · deterministic seed (3 scenarios) · 7 API routes ·{" "}
                    <span className="font-mono">bun run db:print-lineage</span> ✓ — the Phase 1
                    deliverable, verified live below.
                  </p>
                </div>
              </div>
              <div className="text-sm text-muted-foreground md:text-right">
                <p className="font-medium text-foreground">Next: Phase 2 — Orchestrator + ReAct Loop</p>
                <p className="text-xs">ReAct agent traversing lineage · 2 days</p>
              </div>
            </div>
          </div>
        </section>

        {/* Phase 1 LIVE panel — the key new section */}
        <section className="border-b border-border/40">
          <div className="container mx-auto max-w-6xl px-4 py-12">
            <div className="flex items-center gap-2">
              <LineChart className="h-5 w-5 text-emerald-500" aria-hidden />
              <h3 className="text-2xl font-semibold">Phase 1 — seeded DataHub graph (live)</h3>
            </div>
            <p className="mb-8 mt-1 text-sm text-muted-foreground">
              The mock DataHub client reads from the Prisma-seeded SQLite. Three deterministic
              scenarios: nyc-taxi freshness breach, showcase-ecommerce cross-platform lineage,
              and a PII-tagged customer table. This is exactly what the Phase 2 orchestrator will
              read from. The interactive lineage printer below is the Phase 1 deliverable.
            </p>
            <Phase1LivePanel />
          </div>
        </section>

        {/* Phase 1 deliverables grid */}
        <section className="border-b border-border/40 bg-muted/[0.02]">
          <div className="container mx-auto max-w-6xl px-4 py-12">
            <h3 className="mb-1 text-2xl font-semibold">Phase 1 deliverables</h3>
            <p className="mb-8 text-sm text-muted-foreground">
              Every artefact shipped in this commit. Awaiting your approval to start Phase 2.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {PHASE1_DELIVERABLES.map((d) => (
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
        <section className="border-b border-border/40">
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
                        c.phase <= 1
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      }`}
                    >
                      Phase {c.phase} {c.phase <= 1 ? "✓" : ""}
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
        <section className="border-b border-border/40 bg-muted/[0.02]">
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
                  Phase 1 · Mock + Seed ✓
                </span>
              </div>
            </div>
          </div>
        </footer>
      </main>
    </QueryClientProvider>
  );
}
