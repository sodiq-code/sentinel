"use client";

import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Database,
  FileText,
  Github,
  GitPullRequest,
  Loader2,
  Lock,
  PlayCircle,
  Radar,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Slack,
  Terminal,
  XCircle,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Types (mirror the API responses)
// ---------------------------------------------------------------------------

type SignalType = "freshness" | "schema" | "quality" | "pii";
type StepKind = "plan" | "tool_call" | "tool_result" | "observe" | "reflect" | "write_back" | "error";

interface SeedSignal {
  id: string;
  scenarioId: string;
  label: string;
  description: string;
  assetUrn: string;
  assetName: string;
  type: SignalType;
  status: string;
  assertionDescription: string;
  failureReason?: string;
}

interface ReasoningStep {
  step: number;
  kind: StepKind;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  reasoning?: string;
  ts: string;
  error?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

interface RunResult {
  incident: {
    urn: string;
    status: string;
    createdAt: string;
    resolvedAt?: string;
    signal: { id: string; assetUrn: string; type: SignalType; firedAt: string };
  };
  steps: ReasoningStep[];
  totalTokens: { promptTokens: number; completionTokens: number };
  llmModel: string;
  llmProvider?: "zai" | "nvidia";
  promptVersion: string;
}

interface IncidentListItem {
  urn: string;
  signalType: string;
  assetUrn: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  stepCount: number;
  toolCallCount: number;
  writebackCount: number;
}

interface HydratedIncident {
  incident: {
    urn: string;
    status: string;
    createdAt: string;
    resolvedAt?: string;
    signal: { id: string; assetUrn: string; type: SignalType; firedAt: string };
    reasoningSteps: ReasoningStep[];
  };
  toolCalls: Array<{ id: string; tool: string; argsJson: string; resultJson: string | null; status: string; durationMs: number | null; ts: string }>;
  actions: Array<{ id: string; kind: string; target: string; payload: string; status: string; url: string | null; ts: string }>;
  writebacks: Array<{ id: string; kind: string; datahubUrn: string | null; status: string; path: string; dataJson: string; ts: string }>;
  auditEvents: Array<{ id: string; kind: string; summary: string; ts: string }>;
}

interface ConnectorStatus {
  dryRun: boolean;
  github: {
    mode: "live" | "sandbox";
    repo: string;
    dryRun: boolean;
    tokenPresent: boolean;
    reachable: boolean;
    defaultBranch?: string;
    error?: string;
  };
  slack: {
    mode: "live" | "sandbox";
    channel: string;
    tokenPresent: boolean;
    reachable: boolean;
    botUser?: string;
    team?: string;
    error?: string;
  };
}

interface PendingApproval {
  id: string;
  incidentUrn: string | null;
  kind: string;
  reason: string;
  proposedAction: Record<string, unknown>;
  approver: string;
  status: "pending" | "approved" | "denied";
  approverUrn: string | null;
  decidedAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Static: phase roadmap
// ---------------------------------------------------------------------------

const PHASES = [
  { id: 0, name: "Foundation & Repo Hygiene", status: "DONE" as const },
  { id: 1, name: "DataHub Mock + Seed", status: "DONE" as const },
  { id: 2, name: "Orchestrator + ReAct Loop", status: "DONE" as const },
  { id: 3, name: "Action Connectors + Guardrails", status: "NEXT" as const },
  { id: 4, name: "Write-Back + Audit Log", status: "PENDING" as const },
  { id: 5, name: "Incident Console UI (demo surface)", status: "PENDING" as const },
  { id: 6, name: "DataHub Skill + RFC + README", status: "PENDING" as const },
  { id: 7, name: "CI+ Hardening + Submission", status: "PENDING" as const },
];

const STEP_META: Record<StepKind, { icon: typeof BrainCircuit; color: string; label: string; bg: string; border: string }> = {
  plan: { icon: BrainCircuit, color: "text-amber-300", label: "PLAN", bg: "bg-amber-500/10", border: "border-amber-500/30" },
  tool_call: { icon: Terminal, color: "text-emerald-300", label: "TOOL CALL", bg: "bg-emerald-500/10", border: "border-emerald-500/30" },
  tool_result: { icon: Database, color: "text-slate-300", label: "TOOL RESULT", bg: "bg-slate-500/10", border: "border-slate-500/30" },
  observe: { icon: Activity, color: "text-sky-300", label: "OBSERVE", bg: "bg-sky-500/10", border: "border-sky-500/30" },
  reflect: { icon: CheckCircle2, color: "text-emerald-300", label: "REFLECT", bg: "bg-emerald-500/10", border: "border-emerald-500/30" },
  write_back: { icon: FileText, color: "text-rose-300", label: "WRITE-BACK", bg: "bg-rose-500/10", border: "border-rose-500/30" },
  error: { icon: AlertTriangle, color: "text-rose-400", label: "ERROR", bg: "bg-rose-500/15", border: "border-rose-500/40" },
};

// ---------------------------------------------------------------------------
// QueryClient (inline, like Phase 1)
// ---------------------------------------------------------------------------

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

export default function Page() {
  return (
    <QueryClientProvider client={queryClient}>
      <Console />
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

function Console() {
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [revealedCount, setRevealedCount] = useState(0);
  const [runError, setRunError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [viewedIncident, setViewedIncident] = useState<HydratedIncident | null>(null);
  const queryClient = useQueryClient();
  const runStartRef = useRef<number>(0);

  const signals = useQuery<SeedSignal[]>({
    queryKey: ["agent-signals"],
    queryFn: async () => {
      const r = await fetch("/api/agent/signals");
      if (!r.ok) throw new Error("Failed to load signals");
      const j = await r.json();
      return j.signals as SeedSignal[];
    },
    staleTime: 60_000,
  });

  const history = useQuery<IncidentListItem[]>({
    queryKey: ["agent-incidents"],
    queryFn: async () => {
      const r = await fetch("/api/agent/incidents?limit=15");
      if (!r.ok) throw new Error("Failed to load incidents");
      const j = await r.json();
      return j.incidents as IncidentListItem[];
    },
    staleTime: 10_000,
  });

  // Phase 3: connector status (live/sandbox + reachability chips).
  const connectors = useQuery<ConnectorStatus>({
    queryKey: ["connectors-status"],
    queryFn: async () => {
      const r = await fetch("/api/connectors/status");
      if (!r.ok) throw new Error("Failed to load connectors");
      return (await r.json()) as ConnectorStatus;
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  // Auto-select the first signal once loaded.
  useEffect(() => {
    if (signals.data && !selectedSignalId && signals.data.length > 0) {
      setSelectedSignalId(signals.data[0].id);
    }
  }, [signals.data, selectedSignalId]);

  // Elapsed-time ticker while a run is in flight.
  useEffect(() => {
    if (runStartRef.current === 0) return;
    const t = setInterval(() => setElapsed((Date.now() - runStartRef.current) / 1000), 100);
    return () => clearInterval(t);
  }, [runStartRef.current === 0]);

  const run = useMutation({
    mutationFn: async (signalId: string) => {
      const r = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signalId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Run failed (HTTP ${r.status})`);
      return j as RunResult;
    },
    onMutate: () => {
      setResult(null);
      setRunError(null);
      setRevealedCount(0);
      setElapsed(0);
      setViewedIncident(null);
      runStartRef.current = Date.now();
    },
    onSuccess: (data) => {
      runStartRef.current = 0;
      setResult(data);
      setRevealedCount(0);
      queryClient.invalidateQueries({ queryKey: ["agent-incidents"] });
      queryClient.invalidateQueries({ queryKey: ["guardrail-pending"] });
      queryClient.invalidateQueries({ queryKey: ["connectors-status"] });
    },
    onError: (err: Error) => {
      runStartRef.current = 0;
      setRunError(err.message);
    },
  });

  // Progressive reveal of reasoning steps — the "watch the agent think" effect.
  useEffect(() => {
    if (!result) return;
    if (revealedCount >= result.steps.length) return;
    const t = setTimeout(() => setRevealedCount((c) => c + 1), 260);
    return () => clearTimeout(t);
  }, [result, revealedCount]);

  const selectedSignal = useMemo(
    () => signals.data?.find((s) => s.id === selectedSignalId) ?? null,
    [signals.data, selectedSignalId],
  );

  // The steps to show: either the live run result or the viewed incident's trace.
  const displaySteps: ReasoningStep[] = useMemo(() => {
    if (viewedIncident) return viewedIncident.incident.reasoningSteps;
    return result?.steps ?? [];
  }, [result, viewedIncident]);

  const displayRevealed = viewedIncident ? displaySteps.length : Math.min(revealedCount, displaySteps.length);

  async function viewIncident(urn: string) {
    setViewedIncident(null);
    try {
      const r = await fetch(`/api/agent/incident/${encodeURIComponent(urn)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Failed to load incident");
      setViewedIncident(j as HydratedIncident);
    } catch (err) {
      setRunError((err as Error).message);
    }
  }

  const running = run.isPending;
  const totalTokens = result?.totalTokens;

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-800/80 bg-slate-950/95 backdrop-blur supports-[backdrop-filter]:bg-slate-950/80 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center shadow-lg shadow-emerald-900/40">
              <Radar className="h-5 w-5 text-slate-950" />
            </div>
            <div className="leading-tight">
              <div className="font-mono text-base font-bold tracking-tight">SENTINEL</div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Autonomous Data Incident Response</div>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" /> Phase 3 · Connectors + Guardrails ✓
          </span>
          <div className="ml-auto flex items-center gap-2 text-[11px]">
            <Chip icon={Zap} label="LLM" value={result?.llmModel ?? "gpt-4o"} mono />
            <Chip icon={Database} label="Provider" value={result?.llmProvider ?? "zai"} mono />
            <Chip icon={Activity} label="Tokens" value={totalTokens ? `${(totalTokens.promptTokens + totalTokens.completionTokens).toLocaleString()}` : "—"} />
            <Chip icon={BookOpen} label="Prompt" value={result?.promptVersion ?? "sentinel-v2-phase2-1"} mono />
          </div>
        </div>
      </header>

      <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 flex-1 pb-28">
        {/* Hero */}
        <section className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-50">
            Watch Sentinel think — then act, governed.
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Inject a DataHub assertion-failure signal. Sentinel&apos;s ReAct loop investigates — fetches the asset,
            traverses lineage, reads prior post-mortems — then opens a <strong className="text-slate-200">real GitHub issue</strong> in
            the sandbox repo and posts a <strong className="text-slate-200">real Slack triage card</strong>. A
            code-level <strong className="text-amber-300">guardrail</strong> refuses writes to PII-tagged assets
            and surfaces an approval gate for ownership/glossary proposals. Every action is sandboxed, audited,
            and rendered live below.
          </p>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Left / main: injector + reasoning stream */}
          <div className="lg:col-span-2 space-y-5">
            <SignalInjector
              signals={signals.data ?? []}
              loading={signals.isLoading}
              selectedId={selectedSignalId}
              onSelect={setSelectedSignalId}
              onRun={() => selectedSignalId && run.mutate(selectedSignalId)}
              running={running}
              elapsed={elapsed}
            />

            {runError && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-300 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold">Run failed</div>
                  <div className="text-rose-300/80 mt-1 font-mono text-xs">{runError}</div>
                </div>
              </div>
            )}

            <ReasoningStream
              steps={displaySteps}
              revealed={displayRevealed}
              running={running}
              hasResult={Boolean(result) || Boolean(viewedIncident)}
              viewedIncidentUrn={viewedIncident?.incident.urn}
              onClearView={() => setViewedIncident(null)}
              writebacks={viewedIncident?.writebacks ?? []}
              actions={viewedIncident?.actions ?? []}
              auditEvents={viewedIncident?.auditEvents ?? []}
            />

            {/* Phase 3: Guardrail panel — refusals + approval gates for the viewed incident */}
            <GuardrailPanel incidentUrn={viewedIncident?.incident.urn ?? result?.incident.urn ?? null} />
          </div>

          {/* Right: metrics + history + connectors + roadmap */}
          <div className="space-y-5">
            <MetricsCard result={result} historyCount={history.data?.length ?? 0} />
            <ConnectorStatusCard status={connectors.data ?? null} loading={connectors.isLoading} />
            <IncidentHistory
              items={history.data ?? []}
              loading={history.isLoading}
              viewingUrn={viewedIncident?.incident.urn ?? null}
              onView={viewIncident}
              onRefresh={() => queryClient.invalidateQueries({ queryKey: ["agent-incidents"] })}
            />
            <RoadmapCard />
          </div>
        </div>
      </main>

      {/* Phase 3: Demo control bar (sticky bottom) — dry-run toggle + connector test + sandbox log */}
      <DemoControlBar
        status={connectors.data ?? null}
        onTestConnectors={async (dryRun) => {
          try {
            const r = await fetch("/api/connectors/test", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ dryRun }),
            });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error ?? "Test failed");
            queryClient.invalidateQueries({ queryKey: ["connectors-status"] });
            queryClient.invalidateQueries({ queryKey: ["sandbox-log"] });
            return j;
          } catch (err) {
            setRunError((err as Error).message);
            return null;
          }
        }}
      />

      {/* Sticky footer */}
      <footer className="mt-auto border-t border-slate-800/80 bg-slate-950">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-wrap items-center gap-3 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> Phase 3 · Connectors + Guardrails ✓
          </span>
          <span className="text-slate-700">·</span>
          <span>Apache 2.0 · Open source</span>
          <span className="text-slate-700">·</span>
          <Link href="https://github.com/sodiq-code/sentinel" className="inline-flex items-center gap-1 hover:text-emerald-300 transition-colors" target="_blank" rel="noreferrer">
            <Github className="h-3.5 w-3.5" /> sodiq-code/sentinel
          </Link>
          <span className="text-slate-700">·</span>
          <Link href="https://github.com/sodiq-code/sentinel-demo-pipeline" className="inline-flex items-center gap-1 hover:text-emerald-300 transition-colors" target="_blank" rel="noreferrer">
            <Github className="h-3.5 w-3.5" /> sandbox repo
          </Link>
          <span className="text-slate-700">·</span>
          <Link href="https://datahub.devpost.com" className="inline-flex items-center gap-1 hover:text-emerald-300 transition-colors" target="_blank" rel="noreferrer">
            Build with DataHub Hackathon
          </Link>
          <span className="ml-auto hidden sm:inline text-[10px] text-slate-600">New DataHub Skill · Agent Context Kit · MCP Server</span>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signal injector
// ---------------------------------------------------------------------------

function SignalInjector({
  signals,
  loading,
  selectedId,
  onSelect,
  onRun,
  running,
  elapsed,
}: {
  signals: SeedSignal[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRun: () => void;
  running: boolean;
  elapsed: number;
}) {
  const scenarioColor: Record<string, string> = {
    "nyc-taxi-freshness": "border-amber-500/40 bg-amber-500/5",
    "showcase-ecommerce": "border-emerald-500/40 bg-emerald-500/5",
    "pii": "border-rose-500/40 bg-rose-500/5",
  };
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
        <Radar className="h-4 w-4 text-emerald-400" /> Inject a DataHub signal
      </h2>
      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 rounded-md bg-slate-800/40 animate-pulse" />
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {signals.map((s) => {
          const active = s.id === selectedId;
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={`text-left rounded-lg border p-3 transition-all ${
                active
                  ? `${scenarioColor[s.scenarioId] ?? "border-slate-700 bg-slate-800/40"} ring-1 ring-emerald-500/30`
                  : "border-slate-800 bg-slate-900/40 hover:bg-slate-800/40"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                {s.scenarioId === "pii" ? (
                  <Lock className="h-3.5 w-3.5 text-rose-400" />
                ) : s.scenarioId === "showcase-ecommerce" ? (
                  <Database className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Clock className="h-3.5 w-3.5 text-amber-400" />
                )}
                <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400">{s.type}</span>
              </div>
              <div className="text-sm font-semibold text-slate-100">{s.label}</div>
              <div className="text-xs text-slate-400 mt-1 line-clamp-3">{s.description}</div>
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!selectedId || running}
          onClick={onRun}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-emerald-900/30 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
          {running ? "Investigating…" : "Inject & run Sentinel"}
        </button>
        <span className="text-xs text-slate-500">
          {running
            ? `Running against ${selectedId?.includes("pii") ? "the PII scenario — expect a guardrail refusal" : "a failing DataHub assertion"}. ${elapsed.toFixed(1)}s elapsed.`
            : "Runs the full ReAct loop. Live GitHub + Slack actions are sandboxed by default (toggle below)."}
        </span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Reasoning stream (the "watch the agent think" view)
// ---------------------------------------------------------------------------

function ReasoningStream({
  steps,
  revealed,
  running,
  hasResult,
  viewedIncidentUrn,
  onClearView,
  writebacks,
  actions,
  auditEvents,
}: {
  steps: ReasoningStep[];
  revealed: number;
  running: boolean;
  hasResult: boolean;
  viewedIncidentUrn?: string;
  onClearView: () => void;
  writebacks: Array<{ id: string; kind: string; datahubUrn: string | null; status: string; path: string; dataJson: string }>;
  actions: Array<{ id: string; kind: string; target: string; payload: string; status: string; url: string | null; ts: string }>;
  auditEvents: Array<{ id: string; kind: string; summary: string; ts: string }>;
}) {
  const empty = steps.length === 0 && !running;
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40">
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
        <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
          <BrainCircuit className="h-4 w-4 text-amber-400" /> Reasoning stream
          {viewedIncidentUrn && (
            <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400 font-mono">
              history
              <button onClick={onClearView} className="ml-1 text-slate-500 hover:text-slate-300">×</button>
            </span>
          )}
        </h2>
        <span className="text-[11px] text-slate-500">{steps.length} steps</span>
      </div>
      <div className="max-h-[640px] overflow-y-auto p-4 space-y-3 custom-scroll">
        {empty && (
          <div className="text-center py-10 text-slate-500">
            <BrainCircuit className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">No reasoning yet.</p>
            <p className="text-xs mt-1">Inject a signal to watch Sentinel&apos;s ReAct loop.</p>
          </div>
        )}
        {running && steps.length === 0 && (
          <div className="flex items-center gap-3 py-6 text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
            <span className="text-sm">Calling the LLM…</span>
          </div>
        )}
        <AnimatePresence initial={false}>
          {steps.slice(0, revealed).map((step, i) => (
            <StepCard key={`${step.ts}-${i}`} step={step} index={i} />
          ))}
        </AnimatePresence>
        {revealed < steps.length && !running && (
          <div className="flex items-center gap-2 text-xs text-slate-500 py-1">
            <Loader2 className="h-3 w-3 animate-spin" /> revealing trace…
          </div>
        )}
        {/* Phase 3: artifacts + actions + guardrail events (for viewed incidents) */}
        {(writebacks.length > 0 || actions.length > 0) && revealed >= steps.length && (
          <ArtifactsSummary writebacks={writebacks} actions={actions} auditEvents={auditEvents} />
        )}
      </div>
    </section>
  );
}

function StepCard({ step, index }: { step: ReasoningStep; index: number }) {
  const meta = STEP_META[step.kind] ?? STEP_META.tool_result;
  const Icon = meta.icon;
  const [expanded, setExpanded] = useState(false);
  const isWrite = step.toolName?.startsWith("ack.") || step.toolName?.startsWith("action.");
  const isGuardrail = step.toolResult && typeof step.toolResult === "object" && (step.toolResult as Record<string, unknown>)?.guardrail === true;
  const resultJson = step.toolResult ? JSON.stringify(step.toolResult, null, 2) : "";
  const resultIsLong = resultJson.length > 240;

  // Phase 3: detect guardrail refusal/approval in tool_result to render with the right palette
  const guardrailDecision = isGuardrail
    ? ((step.toolResult as Record<string, unknown>)?.decision as "refuse" | "needs_approval" | undefined)
    : undefined;
  const isRefusal = guardrailDecision === "refuse";
  const isApproval = guardrailDecision === "needs_approval";
  const overrideBorder = isRefusal
    ? "border-rose-500/50 bg-rose-500/10"
    : isApproval
      ? "border-amber-500/50 bg-amber-500/10"
      : meta.border;
  const overrideBg = isRefusal || isApproval ? "" : meta.bg;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className={`rounded-lg border ${overrideBorder} ${overrideBg} p-3`}
    >
      <div className="flex items-start gap-2.5">
        <div className={`mt-0.5 shrink-0 ${isRefusal ? "text-rose-400" : isApproval ? "text-amber-300" : meta.color}`}>
          {isRefusal ? <ShieldAlert className="h-4 w-4" /> : isApproval ? <Lock className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-[10px] font-mono font-bold tracking-wider ${isRefusal ? "text-rose-300" : isApproval ? "text-amber-300" : meta.color}`}>
              {isRefusal ? "GUARDRAIL REFUSED" : isApproval ? "NEEDS APPROVAL" : meta.label}
            </span>
            {step.toolName && (
              <span className="text-xs font-mono text-slate-300 bg-slate-800/70 rounded px-1.5 py-0.5">
                {step.toolName}
              </span>
            )}
            {isWrite && step.kind === "tool_result" && !isGuardrail && (
              <span className="text-[10px] text-rose-300/80">→ write-back</span>
            )}
            <span className="ml-auto text-[10px] text-slate-600 font-mono">
              {new Date(step.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
            </span>
          </div>

          {step.reasoning && (
            <pre className="whitespace-pre-wrap break-words text-sm text-slate-200 font-sans leading-relaxed">
              {step.reasoning}
            </pre>
          )}

          {step.kind === "tool_call" && step.toolArgs && (
            <pre className="mt-1 text-xs text-slate-400 bg-slate-950/60 rounded p-2 overflow-x-auto font-mono">
              {JSON.stringify(step.toolArgs, null, 2)}
            </pre>
          )}

          {step.kind === "tool_result" && (
            <div className="mt-1">
              <pre className={`text-xs text-slate-300 bg-slate-950/60 rounded p-2 overflow-x-auto font-mono ${expanded ? "" : "max-h-24"}`}>
                {resultJson}
              </pre>
              {resultIsLong && (
                <button
                  onClick={() => setExpanded((e) => !e)}
                  className="mt-1 inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200"
                >
                  {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  {expanded ? "collapse" : `expand (${resultJson.length.toLocaleString()} chars)`}
                </button>
              )}
            </div>
          )}

          {step.error && (
            <div className="mt-1 text-xs text-rose-300 font-mono bg-rose-950/30 rounded p-2">{step.error}</div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function ArtifactsSummary({
  writebacks,
  actions,
  auditEvents,
}: {
  writebacks: Array<{ id: string; kind: string; datahubUrn: string | null; status: string; path: string; dataJson: string }>;
  actions: Array<{ id: string; kind: string; target: string; payload: string; status: string; url: string | null; ts: string }>;
  auditEvents: Array<{ id: string; kind: string; summary: string; ts: string }>;
}) {
  // Phase 3: render actions as cards (GitHub issue / PR / Slack post) with URLs
  return (
    <div className="mt-4 space-y-3">
      {actions.length > 0 && <ActionsPanel actions={actions} />}
      {writebacks.length > 0 && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3">
          <div className="flex items-center gap-2 mb-2 text-xs font-semibold text-rose-300">
            <FileText className="h-3.5 w-3.5" /> Write-backs ({writebacks.length})
          </div>
          <ul className="space-y-1.5 text-xs text-slate-300">
            {writebacks.map((w) => {
              const data = safeParse(w.dataJson);
              return (
                <li key={w.id} className="font-mono">
                  <span className="text-rose-300">●</span> {w.kind}{" "}
                  <span className="text-slate-500">via {w.path}</span>{" "}
                  <span className={`text-[10px] ${w.status === "succeeded" ? "text-emerald-400" : "text-amber-400"}`}>
                    {w.status}
                  </span>
                  {w.datahubUrn && <div className="text-slate-500 text-[10px] pl-3">{w.datahubUrn}</div>}
                  {data?.title && <div className="text-slate-400 pl-3">{String(data.title)}</div>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {/* Audit events (compact timeline) */}
      {auditEvents.length > 0 && (
        <details className="rounded-lg border border-slate-800 bg-slate-900/40">
          <summary className="px-3 py-2 text-xs font-semibold text-slate-300 cursor-pointer hover:bg-slate-800/40 rounded-lg">
            Audit log ({auditEvents.length} events)
          </summary>
          <ul className="px-3 py-2 space-y-1 text-[11px] font-mono text-slate-400 max-h-48 overflow-y-auto custom-scroll">
            {auditEvents.map((e) => (
              <li key={e.id} className="flex gap-2">
                <span className="text-slate-600 shrink-0">
                  {new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
                </span>
                <span className="text-slate-500 uppercase tracking-wider shrink-0">{e.kind}</span>
                <span className="text-slate-300 truncate">{e.summary}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 3: Actions panel — render GitHub issues + PRs + Slack posts as cards
// ---------------------------------------------------------------------------

function ActionsPanel({ actions }: { actions: Array<{ id: string; kind: string; target: string; payload: string; status: string; url: string | null; ts: string }> }) {
  const cards = actions.map((a) => {
    const p = safeParse(a.payload) ?? {};
    return { ...a, parsed: p };
  });
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="flex items-center gap-2 mb-3 text-xs font-semibold text-amber-300">
        <Send className="h-3.5 w-3.5" /> Executed actions ({cards.length})
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {cards.map((a) => (
          <ActionCard key={a.id} action={a} />
        ))}
      </div>
    </div>
  );
}

function ActionCard({
  action,
}: {
  action: {
    kind: string;
    target: string;
    payload: string;
    status: string;
    url: string | null;
    ts: string;
    parsed: Record<string, unknown>;
  };
}) {
  const isIssue = action.kind === "github.openIssue";
  const isPR = action.kind === "github.openPR";
  const isSlack = action.kind === "slack.postMessage";
  const Icon = isIssue ? Github : isPR ? GitPullRequest : Slack;
  const accent = isIssue ? "text-slate-300" : isPR ? "text-emerald-300" : "text-slate-300";
  const accentBg = isIssue ? "bg-slate-700/40" : isPR ? "bg-emerald-700/40" : "bg-amber-700/40";
  const executed = action.status === "executed";
  const refused = action.status === "refused";
  const neverMerged = isPR && action.parsed?.neverMerged === true;
  const number = typeof action.parsed?.number === "number" ? action.parsed.number : null;
  const title = typeof action.parsed?.title === "string" ? action.parsed.title : "";
  const sandbox = action.parsed?.sandbox === true;

  return (
    <div
      className={`rounded-md border p-2.5 ${
        refused
          ? "border-rose-500/40 bg-rose-500/5"
          : executed
            ? "border-slate-700 bg-slate-800/40"
            : "border-slate-800 bg-slate-900/40"
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <div className={`h-6 w-6 rounded ${accentBg} flex items-center justify-center shrink-0`}>
          <Icon className={`h-3.5 w-3.5 ${accent}`} />
        </div>
        <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400">{action.kind}</span>
        <span
          className={`ml-auto text-[10px] font-mono ${
            refused ? "text-rose-400" : executed ? "text-emerald-400" : "text-amber-400"
          }`}
        >
          {action.status}
          {sandbox && executed && " · sandbox"}
        </span>
      </div>
      <div className="text-xs font-mono text-slate-200 truncate" title={title}>
        {number && number > 0 ? `#${number}` : ""} {title}
      </div>
      <div className="text-[10px] text-slate-500 mt-1 font-mono truncate">{action.target}</div>
      {neverMerged && (
        <div className="mt-1.5 inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-emerald-300">
          <ShieldCheck className="h-3 w-3" /> Never merged
        </div>
      )}
      {action.url && !sandbox && (
        <Link
          href={action.url}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-emerald-300 hover:text-emerald-200 transition-colors"
        >
          view <ArrowRight className="h-3 w-3" />
        </Link>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 3: Guardrail panel — approval gates surfaced for human review
// ---------------------------------------------------------------------------

function GuardrailPanel({ incidentUrn }: { incidentUrn: string | null }) {
  const queryClient = useQueryClient();
  const [approverUrn, setApproverUrn] = useState("urn:li:corpUser:operator");
  const approvals = useQuery<PendingApproval[]>({
    queryKey: ["guardrail-pending", incidentUrn ?? ""],
    queryFn: async () => {
      const url = incidentUrn
        ? `/api/guardrail/pending?incidentUrn=${encodeURIComponent(incidentUrn)}&limit=20`
        : "/api/guardrail/pending?limit=20";
      const r = await fetch(url);
      if (!r.ok) throw new Error("Failed to load guardrail approvals");
      const j = await r.json();
      return j.approvals as PendingApproval[];
    },
    staleTime: 5_000,
    refetchInterval: 10_000,
  });

  const items = approvals.data ?? [];
  if (items.length === 0 && !approvals.isLoading) return null;

  return (
    <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-amber-300 flex items-center gap-2">
          <ShieldAlert className="h-4 w-4" /> Guardrail — approval gates
        </h2>
        <span className="text-[10px] text-slate-500">{items.length} event{items.length !== 1 ? "s" : ""}</span>
      </div>
      {approvals.isLoading && <div className="text-xs text-slate-500">Loading guardrail events…</div>}
      <div className="space-y-2 max-h-72 overflow-y-auto custom-scroll">
        {items.map((a) => (
          <GuardrailCard key={a.id} approval={a} approverUrn={approverUrn} onDecided={() => queryClient.invalidateQueries({ queryKey: ["guardrail-pending"] })} />
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 text-[11px] text-slate-500">
        <label className="font-mono">approver:</label>
        <input
          value={approverUrn}
          onChange={(e) => setApproverUrn(e.target.value)}
          className="flex-1 rounded border border-slate-700 bg-slate-900/60 px-2 py-1 font-mono text-[11px] text-slate-300 focus:outline-none focus:border-emerald-500/40"
        />
      </div>
    </section>
  );
}

function GuardrailCard({
  approval,
  approverUrn,
  onDecided,
}: {
  approval: PendingApproval;
  approverUrn: string;
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const isPending = approval.status === "pending";
  const isApproved = approval.status === "approved";
  const isDenied = approval.status === "denied";

  async function decide(decision: "approve" | "deny") {
    setBusy(decision);
    try {
      const r = await fetch(`/api/guardrail/${decision}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: approval.id, approverUrn }),
      });
      if (!r.ok) throw new Error("Decision failed");
      onDecided();
    } catch {
      setBusy(null);
    }
  }

  return (
    <div
      className={`rounded-lg border p-3 ${
        isPending
          ? "border-amber-500/40 bg-amber-500/5"
          : isApproved
            ? "border-emerald-500/40 bg-emerald-500/5"
            : "border-rose-500/40 bg-rose-500/5"
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <Lock className={`h-3.5 w-3.5 ${isPending ? "text-amber-300" : isApproved ? "text-emerald-300" : "text-rose-300"}`} />
        <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400">{approval.kind}</span>
        <span
          className={`ml-auto text-[10px] font-mono ${
            isPending ? "text-amber-300" : isApproved ? "text-emerald-300" : "text-rose-300"
          }`}
        >
          {approval.status}
        </span>
      </div>
      <div className="text-xs text-slate-300 leading-relaxed">{approval.reason}</div>
      <div className="mt-2 text-[10px] text-slate-500 font-mono">
        approver: {approval.approver} · {new Date(approval.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
      </div>
      {isPending && (
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => decide("approve")}
            disabled={busy !== null}
            className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40 transition-colors"
          >
            {busy === "approve" ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />} approve
          </button>
          <button
            onClick={() => decide("deny")}
            disabled={busy !== null}
            className="inline-flex items-center gap-1 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/20 disabled:opacity-40 transition-colors"
          >
            {busy === "deny" ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />} deny
          </button>
        </div>
      )}
      {approval.decidedAt && (
        <div className="mt-1.5 text-[10px] text-slate-500 font-mono">
          decided by {approval.approverUrn ?? "(unknown)"} at {new Date(approval.decidedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metrics card
// ---------------------------------------------------------------------------

function MetricsCard({
  result,
  historyCount,
}: {
  result: RunResult | null;
  historyCount: number;
}) {
  const tokens = result?.totalTokens;
  const total = tokens ? tokens.promptTokens + tokens.completionTokens : 0;
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
        <Activity className="h-4 w-4 text-emerald-400" /> Live metrics
      </h2>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Incidents" value={String(historyCount)} icon={Radar} />
        <Stat label="Reasoning steps" value={String(result?.steps.length ?? 0)} icon={BrainCircuit} />
        <Stat label="Prompt tokens" value={tokens ? tokens.promptTokens.toLocaleString() : "—"} icon={BookOpen} />
        <Stat label="Completion tokens" value={tokens ? tokens.completionTokens.toLocaleString() : "—"} icon={Zap} />
        <Stat label="Total tokens" value={total ? total.toLocaleString() : "—"} icon={Activity} highlight />
        <Stat label="LLM model" value={result ? "gpt-4o" : "—"} icon={Database} />
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  highlight,
}: {
  label: string;
  value: string;
  icon: typeof Activity;
  highlight?: boolean;
}) {
  return (
    <div className={`rounded-lg border p-2.5 ${highlight ? "border-emerald-500/30 bg-emerald-500/5" : "border-slate-800 bg-slate-900/40"}`}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className={`mt-1 font-mono text-lg font-bold ${highlight ? "text-emerald-300" : "text-slate-100"}`}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 3: Connector status card — live/sandbox + reachability
// ---------------------------------------------------------------------------

function ConnectorStatusCard({ status, loading }: { status: ConnectorStatus | null; loading: boolean }) {
  if (loading && !status) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
          <Terminal className="h-4 w-4 text-emerald-400" /> Connectors
        </h2>
        <div className="space-y-2">
          <div className="h-10 rounded bg-slate-800/40 animate-pulse" />
          <div className="h-10 rounded bg-slate-800/40 animate-pulse" />
        </div>
      </section>
    );
  }
  if (!status) return null;
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
        <Terminal className="h-4 w-4 text-emerald-400" /> Connectors
        <span
          className={`ml-auto text-[10px] font-mono px-2 py-0.5 rounded ${
            status.dryRun
              ? "border border-amber-500/40 bg-amber-500/10 text-amber-300"
              : "border border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
          }`}
        >
          {status.dryRun ? "SANDBOX" : "LIVE"}
        </span>
      </h2>
      <div className="space-y-2">
        <ConnectorRow
          icon={Github}
          name="GitHub"
          target={status.github.repo}
          mode={status.github.mode}
          reachable={status.github.reachable}
          tokenPresent={status.github.tokenPresent}
          error={status.github.error}
        />
        <ConnectorRow
          icon={Slack}
          name="Slack"
          target={`#${status.slack.channel}`}
          mode={status.slack.mode}
          reachable={status.slack.reachable}
          tokenPresent={status.slack.tokenPresent}
          error={status.slack.error}
          hint={status.slack.botUser ? `bot: ${status.slack.botUser}` : undefined}
        />
      </div>
      <div className="mt-2 text-[10px] text-slate-500">
        {status.dryRun
          ? "Sandbox mode writes to examples/sandbox/*.log. Toggle LIVE in the control bar to file real issues + posts."
          : "LIVE mode: each Sentinel run opens a real GitHub issue + posts a real Slack message. Use sparingly."}
      </div>
    </section>
  );
}

function ConnectorRow({
  icon: Icon,
  name,
  target,
  mode,
  reachable,
  tokenPresent,
  error,
  hint,
}: {
  icon: typeof Github;
  name: string;
  target: string;
  mode: "live" | "sandbox";
  reachable: boolean;
  tokenPresent: boolean;
  error?: string;
  hint?: string;
}) {
  const dotColor = !tokenPresent
    ? "bg-rose-400"
    : mode === "sandbox"
      ? "bg-amber-400"
      : reachable
        ? "bg-emerald-400"
        : "bg-rose-400";
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2.5">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-slate-400" />
        <span className="text-xs font-semibold text-slate-200">{name}</span>
        <span className={`h-2 w-2 rounded-full ${dotColor}`} />
        <span className="ml-auto text-[10px] font-mono text-slate-500">
          {mode === "sandbox" ? "sandbox" : reachable ? "live · reachable" : tokenPresent ? "live · blocked" : "no token"}
        </span>
      </div>
      <div className="mt-1 text-[10px] font-mono text-slate-400 truncate">{target}</div>
      {hint && <div className="text-[10px] text-slate-500 font-mono">{hint}</div>}
      {error && <div className="text-[10px] text-rose-300 font-mono mt-0.5 truncate" title={error}>{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 3: Demo control bar (sticky bottom) — dry-run toggle + test button
// ---------------------------------------------------------------------------

function DemoControlBar({
  status,
  onTestConnectors,
}: {
  status: ConnectorStatus | null;
  onTestConnectors: (dryRun: boolean) => Promise<unknown>;
}) {
  const [testing, setTesting] = useState(false);
  const dryRun = status?.dryRun ?? true;
  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-800 bg-slate-950/95 backdrop-blur supports-[backdrop-filter]:bg-slate-950/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5 flex flex-wrap items-center gap-3 text-xs">
        <span className="text-[11px] text-slate-500 font-mono">demo controls:</span>
        <div className="inline-flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-2.5 py-1">
          <span className={`h-2 w-2 rounded-full ${dryRun ? "bg-amber-400" : "bg-emerald-400"} animate-pulse`} />
          <span className="text-slate-400">mode</span>
          <span className={`font-mono ${dryRun ? "text-amber-300" : "text-emerald-300"}`}>
            {dryRun ? "SANDBOX" : "LIVE"}
          </span>
          <span className="text-slate-600 text-[10px]">(SENTINEL_DRY_RUN={dryRun ? "true" : "false"})</span>
        </div>
        <button
          onClick={() => onTestConnectors(dryRun)}
          disabled={testing}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-slate-300 hover:bg-slate-700/60 disabled:opacity-40 transition-colors"
          title="Open a test GitHub issue + post a test Slack card (uses the current mode)"
        >
          {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
          test connectors
        </button>
        <span className="ml-auto text-[10px] text-slate-600 hidden sm:inline">
          {dryRun
            ? "Sandbox writes to examples/sandbox/*.log — safe. Switch to LIVE in .env (SENTINEL_DRY_RUN=false) to file real issues + posts."
            : "LIVE mode: every Inject & run files real artifacts in your sandbox GitHub + Slack."}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Incident history
// ---------------------------------------------------------------------------

function IncidentHistory({
  items,
  loading,
  viewingUrn,
  onView,
  onRefresh,
}: {
  items: IncidentListItem[];
  loading: boolean;
  viewingUrn: string | null;
  onView: (urn: string) => void;
  onRefresh: () => void;
}) {
  const statusColor: Record<string, string> = {
    resolved: "text-emerald-400",
    failed: "text-rose-400",
    investigating: "text-amber-400",
    open: "text-slate-400",
  };
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
          <Radar className="h-4 w-4 text-emerald-400" /> Incident history
        </h2>
        <button
          onClick={onRefresh}
          className="text-slate-500 hover:text-slate-200 transition-colors"
          title="Refresh"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto custom-scroll p-2">
        {loading && items.length === 0 && (
          <div className="space-y-2 p-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-12 rounded-md bg-slate-800/40 animate-pulse" />
            ))}
          </div>
        )}
        {!loading && items.length === 0 && (
          <div className="text-center py-6 text-xs text-slate-500">
            No incidents yet. Inject a signal to create the first.
          </div>
        )}
        {items.map((it) => (
          <button
            key={it.urn}
            onClick={() => onView(it.urn)}
            className={`w-full text-left rounded-md p-2.5 mb-1 transition-colors border ${
              viewingUrn === it.urn
                ? "border-emerald-500/40 bg-emerald-500/5"
                : "border-transparent hover:bg-slate-800/40"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${
                it.status === "resolved" ? "bg-emerald-400" : it.status === "failed" ? "bg-rose-400" : "bg-amber-400"
              }`} />
              <span className={`text-[10px] font-mono uppercase ${statusColor[it.status] ?? "text-slate-400"}`}>{it.status}</span>
              <span className="text-[10px] font-mono text-slate-500">{it.signalType}</span>
              <span className="ml-auto text-[10px] text-slate-600">
                {new Date(it.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
              </span>
            </div>
            <div className="mt-1 text-xs text-slate-400 font-mono truncate">
              {it.assetUrn.replace(/^urn:li:dataset:\(urn:li:dataPlatform:[^,]+,([^,]+),.*$/, "$1")}
            </div>
            <div className="mt-0.5 text-[10px] text-slate-500 flex gap-2">
              <span>{it.stepCount} steps</span>
              <span>·</span>
              <span>{it.toolCallCount} tools</span>
              <span>·</span>
              <span>{it.writebackCount} writebacks</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Roadmap
// ---------------------------------------------------------------------------

function RoadmapCard() {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="text-sm font-semibold text-slate-200 mb-3 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-emerald-400" /> Phase roadmap
      </h2>
      <ol className="space-y-1.5">
        {PHASES.map((p) => (
          <li key={p.id} className="flex items-center gap-2.5 text-xs">
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                p.status === "DONE"
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                  : p.status === "NEXT"
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                  : "bg-slate-800 text-slate-500 border border-slate-700"
              }`}
            >
              {p.status === "DONE" ? <CheckCircle2 className="h-3 w-3" /> : p.id}
            </span>
            <span className={p.status === "DONE" ? "text-slate-300" : p.status === "NEXT" ? "text-amber-300 font-medium" : "text-slate-500"}>
              {p.name}
            </span>
            {p.status === "NEXT" && (
              <span className="ml-auto text-[9px] font-mono uppercase text-amber-400/80">next</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function Chip({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="hidden md:inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1">
      <Icon className="h-3 w-3 text-slate-500" />
      <span className="text-slate-500">{label}</span>
      <span className={`text-slate-300 max-w-[180px] truncate ${mono ? "font-mono" : ""}`} title={value}>{value}</span>
    </div>
  );
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}
