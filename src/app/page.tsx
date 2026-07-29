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
  Copy,
  Database,
  FileText,
  GitBranch,
  Github,
  GitFork,
  GitPullRequest,
  History,
  Layers,
  Loader2,
  Lock,
  PanelRightClose,
  PanelRightOpen,
  PlayCircle,
  Radar,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Slack,
  Sparkles,
  Terminal,
  User,
  Workflow,
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
  llmProvider?: "zai" | "nvidia" | "groq";
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
    mode: "live" | "trace";
    repo: string;
    dryRun: boolean;
    tokenPresent: boolean;
    reachable: boolean;
    defaultBranch?: string;
    error?: string;
  };
  slack: {
    mode: "live" | "trace";
    channel: string;
    tokenPresent: boolean;
    reachable: boolean;
    botUser?: string;
    team?: string;
    error?: string;
  };
}

// Resilience — LLM circuit + failover state from /api/llm/status.
interface LlmResilienceStatus {
  provider: "zai" | "nvidia" | "groq";
  model: string;
  failoverEnabled: boolean;
  hasNvidiaKey: boolean;
  circuit: {
    isOpen: boolean;
    consecutiveFailures: number;
    msUntilReset: number;
  } | null;
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

// LineageGraph — SVG lineage with real-time traversal highlight
interface LineageGraphNode {
  urn: string;
  name: string;
  type: string;
  platform: string;
  degree: number; // negative = upstream, 0 = root, positive = downstream
  scenarioId: string;
}
interface LineageGraphEdge {
  from: string;
  to: string;
  via: string | null;
}
interface LineageGraphResponse {
  root: string;
  rootScenario: string;
  nodes: LineageGraphNode[];
  edges: LineageGraphEdge[];
}

// IncidentHeader — on-call persona + failing asset
interface AssetEntity {
  urn: string;
  name: string;
  type: string;
  platform: string;
  description?: string;
  owners: Array<{ ownerUrn: string; ownerType: string; name: string }>;
  glossaryTerms: Array<{ urn: string; name: string; description?: string }>;
  governanceTags: Array<{ name: string; level?: string }>;
  lastModifiedAt?: number;
  platformNativeName?: string;
  scenarioId?: string;
}
interface AssetResponse {
  entity: AssetEntity | null;
  schemaFields: Array<{ name: string; type: string; nullable: boolean; nativeDataType?: string }>;
}

// ---------------------------------------------------------------------------
// Static: step metadata (icons + colors)
// ---------------------------------------------------------------------------

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
// Audit-event metadata — the full audit log (lifecycle + reasoning
// trace) is rendered as a vertical timeline. Each kind gets an icon, a
// group (for the filter tabs), and a color. NO indigo/blue — mission-control
// palette only (emerald/amber/rose/slate).
// ---------------------------------------------------------------------------

type AuditGroup = "lifecycle" | "reasoning" | "tool" | "action" | "writeback" | "error";

const AUDIT_KIND_META: Record<string, { icon: typeof Activity; group: AuditGroup; label: string; color: string; dot: string }> = {
  // lifecycle — emerald (the milestones a DataHub operator sees mirrored as Assertions)
  signal_received: { icon: Radar, group: "lifecycle", label: "SIGNAL RECEIVED", color: "text-emerald-300", dot: "bg-emerald-400" },
  incident_created: { icon: ShieldCheck, group: "lifecycle", label: "INCIDENT CREATED", color: "text-emerald-300", dot: "bg-emerald-400" },
  incident_resolved: { icon: CheckCircle2, group: "lifecycle", label: "INCIDENT RESOLVED", color: "text-emerald-300", dot: "bg-emerald-400" },
  incident_failed: { icon: XCircle, group: "error", label: "INCIDENT FAILED", color: "text-rose-400", dot: "bg-rose-500" },
  // reasoning — amber (the "watch the agent think" trace)
  plan: { icon: BrainCircuit, group: "reasoning", label: "PLAN", color: "text-amber-300", dot: "bg-amber-400" },
  observe: { icon: Activity, group: "reasoning", label: "OBSERVE", color: "text-amber-300", dot: "bg-amber-400" },
  reflect: { icon: CheckCircle2, group: "reasoning", label: "REFLECT", color: "text-amber-300", dot: "bg-amber-400" },
  // tool — slate (the DataHub MCP / ACK read+write calls)
  tool_call: { icon: Terminal, group: "tool", label: "TOOL CALL", color: "text-slate-300", dot: "bg-slate-400" },
  tool_result: { icon: Database, group: "tool", label: "TOOL RESULT", color: "text-slate-300", dot: "bg-slate-400" },
  // action — amber/orange (the GitHub + Slack connectors)
  action_proposed: { icon: Send, group: "action", label: "ACTION PROPOSED", color: "text-amber-300", dot: "bg-amber-400" },
  action_approved: { icon: ShieldCheck, group: "action", label: "ACTION APPROVED", color: "text-emerald-300", dot: "bg-emerald-400" },
  action_refused: { icon: Lock, group: "action", label: "ACTION REFUSED", color: "text-rose-300", dot: "bg-rose-400" },
  action_executed: { icon: Send, group: "action", label: "ACTION EXECUTED", color: "text-amber-300", dot: "bg-amber-400" },
  // writeback — rose (the dual-path compounding artefact)
  writeback_proposed: { icon: GitBranch, group: "writeback", label: "WRITEBACK PROPOSED", color: "text-rose-300", dot: "bg-rose-400" },
  writeback_succeeded: { icon: FileText, group: "writeback", label: "WRITEBACK SUCCEEDED", color: "text-rose-300", dot: "bg-rose-400" },
  writeback_failed: { icon: AlertTriangle, group: "writeback", label: "WRITEBACK FAILED", color: "text-rose-400", dot: "bg-rose-500" },
  write_back: { icon: FileText, group: "writeback", label: "WRITE-BACK", color: "text-rose-300", dot: "bg-rose-400" },
  write_back_succeeded: { icon: FileText, group: "writeback", label: "WRITE-BACK SUCCEEDED", color: "text-rose-300", dot: "bg-rose-400" },
  // error
  error: { icon: AlertTriangle, group: "error", label: "ERROR", color: "text-rose-400", dot: "bg-rose-500" },
};

const AUDIT_GROUP_META: Record<AuditGroup, { label: string; color: string }> = {
  lifecycle: { label: "Lifecycle", color: "text-emerald-300" },
  reasoning: { label: "Reasoning", color: "text-amber-300" },
  tool: { label: "Tools", color: "text-slate-300" },
  action: { label: "Actions", color: "text-amber-300" },
  writeback: { label: "Write-backs", color: "text-rose-300" },
  error: { label: "Errors", color: "text-rose-400" },
};

// ---------------------------------------------------------------------------
// QueryClient (inline)
// ---------------------------------------------------------------------------

// When deployed to Vercel, the dashboard auto-populates with a pre-recorded
// run on first load so a visitor lands on a fully-rendered incident console
// without clicking anything. The flag is set at build time by Vercel env
// vars and is inert in local dev (live agent runs unchanged).
const PREVIEW_MODE = process.env.NEXT_PUBLIC_VERCEL_DEMO_MODE === "true";

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
  // Audit log drawer (collapsible side drawer streaming every event).
  const [auditDrawerOpen, setAuditDrawerOpen] = useState(false);
  // Compounding-context loop — runs the agent twice on the same scenario;
  // Run 2 visibly reads Run 1's post-mortem (the structural learning beat).
  const [replayRun, setReplayRun] = useState<0 | 1 | 2>(0); // 0 = idle, 1 = run 1, 2 = run 2
  const [replayBusy, setReplayBusy] = useState(false);
  const [priorPostMortem, setPriorPostMortem] = useState<{ title: string; urn: string } | null>(null);
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

  // Connector status — live/trace + reachability chips.
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

  // Resilience — poll the LLM circuit state. Refetch every 5s while
  // a circuit is open (so the operator sees the cooldown tick down); every
  // 20s when healthy.
  const llmStatus = useQuery<LlmResilienceStatus>({
    queryKey: ["llm-status"],
    queryFn: async () => {
      const r = await fetch("/api/llm/status");
      if (!r.ok) throw new Error("Failed to load LLM status");
      return (await r.json()) as LlmResilienceStatus;
    },
    staleTime: 5_000,
    refetchInterval: (q) => {
      const data = q.state.data as LlmResilienceStatus | undefined;
      return data?.circuit?.isOpen ? 1_000 : 20_000;
    },
  });

  // Fetch the selected signal's asset entity (owners, glossary,
  // governance tags, schema) for the IncidentHeader persona card.
  const selectedSignalForAsset = useMemo(
    () => signals.data?.find((s) => s.id === selectedSignalId) ?? null,
    [signals.data, selectedSignalId],
  );
  const asset = useQuery<AssetResponse>({
    queryKey: ["asset", selectedSignalForAsset?.assetUrn ?? ""],
    queryFn: async () => {
      if (!selectedSignalForAsset?.assetUrn) return null as unknown as AssetResponse;
      const r = await fetch(`/api/datahub/asset?urn=${encodeURIComponent(selectedSignalForAsset.assetUrn)}`);
      if (!r.ok) throw new Error("Failed to load asset");
      return (await r.json()) as AssetResponse;
    },
    enabled: Boolean(selectedSignalForAsset?.assetUrn),
    staleTime: 120_000,
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

  // Preview auto-populate: when deployed to Vercel, the dashboard runs the
  // first signal once on mount so a visitor lands on a fully-rendered
  // incident console (reasoning stream, lineage, actions, write-back,
  // audit log) without clicking anything. Inert in local dev.
  useEffect(() => {
    if (!PREVIEW_MODE) return;
    if (result) return;
    if (run.isPending || run.isError) return;
    const first = signals.data?.[0];
    if (!first) return;
    run.mutate(first.id);
  }, [PREVIEW_MODE, signals.data, result, run.isPending, run.isError, run.mutate]);

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

  // Compounding-context loop: runs the agent twice on the same scenario.
  // Run 2 should visibly read Run 1's post-mortem via mcp.search_documents.
  // Between runs we surface a "prior incident found" highlight card.
  // Must run on the nyc-taxi-freshness scenario so the post-mortem is
  // findable in Run 2's reasoning trace.
  async function runReplayLoop() {
    if (replayBusy || !selectedSignalId) return;
    // Force the nyc-taxi scenario for the compounding-context beat (the
    // only one with a prior-post-mortem read that's visually obvious).
    const nycSignal = signals.data?.find((s) => s.scenarioId === "nyc-taxi-freshness");
    const sigId = nycSignal?.id ?? selectedSignalId;
    if (nycSignal) setSelectedSignalId(nycSignal.id);
    setReplayBusy(true);
    setReplayRun(1);
    setPriorPostMortem(null);
    setViewedIncident(null);
    setResult(null);
    setRunError(null);
    try {
      // Run 1 — investigate from scratch → write post-mortem.
      runStartRef.current = Date.now();
      const r1 = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signalId: sigId }),
      });
      const j1 = await r1.json();
      if (!r1.ok) throw new Error(j1.error ?? `Run 1 failed (HTTP ${r1.status})`);
      setResult(j1 as RunResult);
      runStartRef.current = 0;
      queryClient.invalidateQueries({ queryKey: ["agent-incidents"] });
      queryClient.invalidateQueries({ queryKey: ["guardrail-pending"] });
      // Capture Run 1's post-mortem write-back (if any) for the highlight card.
      const pm = (j1 as RunResult).steps.find(
        (s) => s.toolName === "ack.save_document" || s.kind === "write_back",
      );
      if (pm) {
        const tr = pm.toolResult as Record<string, unknown> | undefined;
        const urn = (tr?.urn as string) ?? (tr?.datahubUrn as string);
        const title = (tr?.title as string) ?? "Sentinel post-mortem context doc";
        if (urn) setPriorPostMortem({ title, urn });
      }
      // Brief pause between runs (so the operator can read Run 1's trace).
      await new Promise((res) => setTimeout(res, 1800));
      // Run 2 — investigate similar failure → visibly reads Run 1's post-mortem.
      setReplayRun(2);
      setResult(null);
      setRevealedCount(0);
      runStartRef.current = Date.now();
      const r2 = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signalId: sigId }),
      });
      const j2 = await r2.json();
      if (!r2.ok) throw new Error(j2.error ?? `Run 2 failed (HTTP ${r2.status})`);
      setResult(j2 as RunResult);
      runStartRef.current = 0;
      queryClient.invalidateQueries({ queryKey: ["agent-incidents"] });
      queryClient.invalidateQueries({ queryKey: ["guardrail-pending"] });
      queryClient.invalidateQueries({ queryKey: ["lineage-graph"] });
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      runStartRef.current = 0;
      setReplayBusy(false);
      setReplayRun(0);
    }
  }

  // Compounding-context beat — detect whether the visible trace read a
  // post-mortem (Run 2 of the replay loop, or any run that calls
  // mcp.search_documents and gets back a sentinelPostMortem doc).
  const priorPostMortemFromTrace = useMemo(() => {
    for (const s of displaySteps) {
      if (s.kind !== "tool_result" || s.toolName !== "mcp.search_documents") continue;
      const r = s.toolResult;
      if (!Array.isArray(r)) continue;
      for (const doc of r as Array<Record<string, unknown>>) {
        if (doc.sentinelPostMortem === true || /sentinel|post-mortem|prior incident/i.test(String(doc.title ?? ""))) {
          return { title: String(doc.title ?? "Sentinel post-mortem"), urn: String(doc.urn ?? "") };
        }
      }
    }
    return null;
  }, [displaySteps]);

  const running = run.isPending || replayBusy;
  const totalTokens = result?.totalTokens;

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100 sentinel-bg">
      {/* Header */}
      <header className="border-b border-slate-800/80 bg-slate-950/95 backdrop-blur supports-[backdrop-filter]:bg-slate-950/80 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center shadow-lg shadow-emerald-900/40 ring-1 ring-emerald-400/30">
              <Radar className="h-5 w-5 text-slate-950" />
            </div>
            <div className="leading-tight">
              <div className="font-mono text-base font-bold tracking-tight">SENTINEL</div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Autonomous Data Incident Response</div>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> Operational
          </span>
          <div className="ml-auto flex items-center gap-2 text-[11px]">
            <Chip icon={Zap} label="LLM" value={result?.llmModel ?? "llama-3.3-70b-versatile"} mono />
            <Chip icon={Database} label="Provider" value={result?.llmProvider ?? "groq"} mono />
            <LlmCircuitChip status={llmStatus.data} />
            <Chip icon={Activity} label="Tokens" value={totalTokens ? `${(totalTokens.promptTokens + totalTokens.completionTokens).toLocaleString()}` : "—"} />
            <Chip icon={BookOpen} label="Prompt" value={result?.promptVersion ?? "sentinel-v2-phase2-1"} mono />
            <button
              onClick={() => setAuditDrawerOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900/60 px-2 py-1 text-slate-300 hover:bg-slate-800/60 hover:border-emerald-500/40 transition-colors"
              title="Open audit log drawer"
            >
              <PanelRightOpen className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Audit</span>
              <span className="text-[10px] font-mono text-slate-500">{viewedIncident?.auditEvents?.length ?? result?.steps.filter(s => s.kind === 'tool_call' || s.kind === 'tool_result' || s.kind === 'write_back' || s.kind === 'plan' || s.kind === 'observe' || s.kind === 'reflect').length ?? 0}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 flex-1 pb-28">
        {/* Hero */}
        <section className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.15em] text-emerald-300">
              <Sparkles className="h-3 w-3" /> ReAct · Governed · Audited
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900/60 px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.15em] text-slate-400">
              <GitBranch className="h-3 w-3" /> DataHub Hackathon
            </span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-50">
            Watch Sentinel think — then act, governed.
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400 leading-relaxed">
            Inject a DataHub assertion-failure signal. Sentinel&apos;s ReAct loop investigates — fetches the asset,
            traverses lineage, reads prior post-mortems — then opens a <strong className="text-slate-200">GitHub issue</strong> in
            the demo pipeline repo and posts a <strong className="text-slate-200">Slack triage card</strong>. A
            code-level <strong className="text-amber-300">guardrail</strong> refuses writes to PII-tagged assets
            and surfaces an approval gate for ownership and glossary proposals. Every action is logged, audited,
            and rendered live below.
          </p>
        </section>

        {/* Incident header — on-call persona + failing asset */}
        <IncidentHeader
          signal={selectedSignal ?? null}
          asset={asset.data?.entity ?? null}
          running={running}
          elapsed={elapsed}
        />

        {/* Compounding-context banner — surfaces when the agent re-runs the
            same scenario and reads its own prior post-mortem. */}
        {(replayRun !== 0 || priorPostMortem || priorPostMortemFromTrace) && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-4 rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-500/10 to-rose-500/10 p-4"
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 h-8 w-8 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
                <RotateCw className={`h-4 w-4 text-amber-300 ${replayBusy ? "animate-spin" : ""}`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-amber-200">
                  Compounding context
                </div>
                <div className="text-xs text-amber-200/80 mt-0.5">
                  {replayRun === 1 && "Run 1 of 2 · investigating from scratch — will write a post-mortem to DataHub."}
                  {replayRun === 2 && "Run 2 of 2 · investigating the same failure — Sentinel reads Run 1's post-mortem, produces a shorter reasoning trace, resolves faster."}
                  {replayRun === 0 && (priorPostMortem || priorPostMortemFromTrace)
                    ? "Re-run complete — Run 2 read Run 1's post-mortem before reasoning. The agent learns from its own history."
                    : ""}
                </div>
                {(priorPostMortem || priorPostMortemFromTrace) && (
                  <div className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] font-mono text-emerald-300">
                    <FileText className="h-3 w-3" />
                    prior incident found: {(priorPostMortemFromTrace ?? priorPostMortem)?.title}
                    {(priorPostMortemFromTrace ?? priorPostMortem)?.urn && (
                      <span className="text-emerald-400/70 ml-1 truncate max-w-[220px]">· {(priorPostMortemFromTrace ?? priorPostMortem)!.urn}</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mt-5">
          {/* Left / main: injector + lineage + reasoning stream */}
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

            {/* Lineage graph — SVG lineage with real-time traversal highlight */}
            <LineageGraph
              rootUrn={selectedSignal?.assetUrn ?? null}
              steps={displaySteps}
              running={running}
            />

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

            {/* Guardrail panel — refusals + approval gates for the viewed incident */}
            <GuardrailPanel incidentUrn={viewedIncident?.incident.urn ?? result?.incident.urn ?? null} />
          </div>

          {/* Right column: metrics + history + connectors */}
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
          </div>
        </div>
      </main>

      {/* Sticky bottom control bar — connector trace toggle + connector test + compounding re-run */}
      <DemoControlBar
        status={connectors.data ?? null}
        running={running}
        replayRun={replayRun}
        onReplayLoop={runReplayLoop}
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
            queryClient.invalidateQueries({ queryKey: ["trace-log"] });
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
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" /> All systems operational
          </span>
          <span className="text-slate-700">·</span>
          <span className="inline-flex items-center gap-1.5">
            <Database className="h-3.5 w-3.5 text-slate-400" /> Turso (libSQL)
          </span>
          <span className="text-slate-700">·</span>
          <span>Apache 2.0 · Open source</span>
          <span className="text-slate-700">·</span>
          <Link href="https://github.com/sodiq-code/sentinel" className="inline-flex items-center gap-1 hover:text-emerald-300 transition-colors" target="_blank" rel="noreferrer">
            <Github className="h-3.5 w-3.5" /> sodiq-code/sentinel
          </Link>
          <span className="text-slate-700">·</span>
          <Link href="https://github.com/sodiq-code/sentinel-demo-pipeline" className="inline-flex items-center gap-1 hover:text-emerald-300 transition-colors" target="_blank" rel="noreferrer">
            <Github className="h-3.5 w-3.5" /> demo pipeline repo
          </Link>
          <span className="ml-auto hidden sm:inline text-[10px] text-slate-600">Autonomous Data Incident Response · DataHub MCP</span>
        </div>
      </footer>

      {/* AuditLogDrawer — collapsible side drawer streaming every event */}
      <AuditLogDrawer
        open={auditDrawerOpen}
        onClose={() => setAuditDrawerOpen(false)}
        events={viewedIncident?.auditEvents ?? []}
        incidentUrn={viewedIncident?.incident.urn ?? null}
      />
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
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 premium-card">
      <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
        <Radar className="h-4 w-4 text-emerald-400" /> Inject a DataHub signal
      </h2>
      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 rounded-md sentinel-shimmer" />
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
            : "Runs the full ReAct loop end-to-end. GitHub + Slack actions are logged by default (toggle below)."}
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
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 premium-card">
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
        {/* Artifacts + actions + write-backs + audit log (for viewed incidents) */}
        {(writebacks.length > 0 || actions.length > 0 || auditEvents.length > 0) && revealed >= steps.length && (
          <ArtifactsSummary
            writebacks={writebacks}
            actions={actions}
            auditEvents={auditEvents}
            incidentUrn={viewedIncidentUrn}
          />
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

  // Detect guardrail refusal/approval in tool_result to render with the right palette
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
  incidentUrn,
}: {
  writebacks: Array<{ id: string; kind: string; datahubUrn: string | null; status: string; path: string; dataJson: string }>;
  actions: Array<{ id: string; kind: string; target: string; payload: string; status: string; url: string | null; ts: string }>;
  auditEvents: Array<{ id: string; kind: string; summary: string; ts: string }>;
  incidentUrn?: string;
}) {
  // Actions + write-backs (dual path) + audit log (timeline).
  return (
    <div className="mt-4 space-y-3">
      {actions.length > 0 && <ActionsPanel actions={actions} />}
      {writebacks.length > 0 && (
        <WriteBackPanel writebacks={writebacks} incidentUrn={incidentUrn} />
      )}
      {auditEvents.length > 0 && (
        <AuditTimeline events={auditEvents} incidentUrn={incidentUrn} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WriteBackPanel — the dual write-back path.
// Each write-back card shows the path used (Agent Context Kit / REST
// ingestion), the fallback chain, the DataHub URN, and a re-attempt button
// for failed writes. The compounding artefact is the post-mortem context doc.
// ---------------------------------------------------------------------------

function WriteBackPanel({
  writebacks,
  incidentUrn,
}: {
  writebacks: Array<{ id: string; kind: string; datahubUrn: string | null; status: string; path: string; dataJson: string }>;
  incidentUrn?: string;
}) {
  const succeeded = writebacks.filter((w) => w.status === "succeeded").length;
  const failed = writebacks.filter((w) => w.status === "failed").length;
  const viaAck = writebacks.filter((w) => w.path === "agent_context_kit").length;
  const viaRest = writebacks.filter((w) => w.path === "rest_ingestion").length;

  return (
    <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3.5">
      <div className="flex items-center justify-between mb-2.5">
        <h3 className="text-xs font-semibold text-rose-300 flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5" /> Write-backs
          <span className="text-slate-500 font-normal">({writebacks.length})</span>
        </h3>
        <div className="flex items-center gap-1.5 text-[10px] font-mono">
          {succeeded > 0 && <span className="text-emerald-400">{succeeded} ok</span>}
          {failed > 0 && <span className="text-rose-400">{failed} failed</span>}
        </div>
      </div>
      {/* Dual-path indicator */}
      <div className="mb-3 flex items-center gap-2 rounded-md border border-rose-500/20 bg-rose-500/5 px-2.5 py-1.5 text-[10px] text-slate-400">
        <GitBranch className="h-3 w-3 text-rose-300 shrink-0" />
        <span className="font-mono">
          <span className="text-emerald-300">Agent Context Kit</span>
          <span className="text-slate-600 mx-1">→</span>
          <span className="text-amber-300">REST ingestion</span>
        </span>
        <span className="text-slate-600 mx-1">·</span>
        <span className="font-mono">
          {viaAck} ACK
          {viaRest > 0 && <span className="text-amber-300"> · {viaRest} fallback</span>}
        </span>
      </div>
      <div className="space-y-2">
        {writebacks.map((w) => (
          <WriteBackCard key={w.id} writeback={w} incidentUrn={incidentUrn} />
        ))}
      </div>
    </div>
  );
}

function WriteBackCard({
  writeback,
  incidentUrn,
}: {
  writeback: { id: string; kind: string; datahubUrn: string | null; status: string; path: string; dataJson: string };
  incidentUrn?: string;
}) {
  const data = safeParse(writeback.dataJson);
  const title = data?.title ? String(data.title) : "";
  const fallback = data?.fallback === true;
  const primaryError = data?.primaryError ? String(data.primaryError) : "";
  const isAck = writeback.path === "agent_context_kit";
  const isRest = writeback.path === "rest_ingestion";
  const succeeded = writeback.status === "succeeded";
  const failed = writeback.status === "failed";
  const [expanded, setExpanded] = useState(false);
  const [reattempting, setReattempting] = useState(false);
  const [reattemptError, setReattemptError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const queryClient = useQueryClient();

  async function reattempt() {
    setReattempting(true);
    setReattemptError(null);
    try {
      const r = await fetch("/api/agent/writeback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ writeBackId: writeback.id, incidentUrn }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Re-attempt failed (HTTP ${r.status})`);
      // Invalidate the incident view so the new write-back appears.
      if (incidentUrn) queryClient.invalidateQueries({ queryKey: ["agent-incidents"] });
    } catch (err) {
      setReattemptError((err as Error).message);
    } finally {
      setReattempting(false);
    }
  }

  function copyUrn() {
    if (!writeback.datahubUrn) return;
    navigator.clipboard?.writeText(writeback.datahubUrn).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div
      className={`rounded-md border p-2.5 ${
        failed
          ? "border-rose-500/40 bg-rose-500/5"
          : isRest
            ? "border-amber-500/30 bg-amber-500/5"
            : "border-emerald-500/20 bg-emerald-500/5"
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
        {/* Path badge */}
        <span
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${
            isAck
              ? "bg-emerald-500/15 text-emerald-300"
              : isRest
                ? "bg-amber-500/15 text-amber-300"
                : "bg-slate-700/40 text-slate-300"
          }`}
        >
          {isAck ? <ShieldCheck className="h-2.5 w-2.5" /> : <GitBranch className="h-2.5 w-2.5" />}
          {isAck ? "Agent Context Kit" : "REST ingestion"}
        </span>
        {fallback && (
          <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-amber-300">
            <RefreshCw className="h-2.5 w-2.5" /> fallback
          </span>
        )}
        {/* Status badge */}
        <span
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${
            succeeded
              ? "bg-emerald-500/15 text-emerald-300"
              : "bg-rose-500/15 text-rose-300"
          }`}
        >
          {succeeded ? <CheckCircle2 className="h-2.5 w-2.5" /> : <XCircle className="h-2.5 w-2.5" />}
          {writeback.status}
        </span>
        <span className="ml-auto text-[10px] text-slate-500 font-mono">{writeback.kind}</span>
      </div>

      {title && <div className="text-xs text-slate-200 font-medium truncate mb-1" title={title}>{title}</div>}

      {writeback.datahubUrn ? (
        <button
          onClick={copyUrn}
          className="flex items-center gap-1.5 text-[10px] text-slate-400 font-mono hover:text-slate-200 transition-colors w-full text-left"
          title="Click to copy"
        >
          <span className="truncate">{writeback.datahubUrn}</span>
          {copied ? <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" /> : <Copy className="h-3 w-3 shrink-0 opacity-50" />}
        </button>
      ) : (
        failed && <div className="text-[10px] text-rose-400 font-mono">no URN (write failed on both paths)</div>
      )}

      {fallback && primaryError && (
        <div className="mt-1.5 text-[10px] text-amber-300/80 font-mono bg-amber-950/30 rounded px-1.5 py-1">
          <span className="text-amber-400">ACK failed:</span> {primaryError}
        </div>
      )}

      {/* Expandable data payload */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300"
      >
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        {expanded ? "collapse" : "payload"}
      </button>
      {expanded && (
        <pre className="mt-1 text-[10px] text-slate-400 bg-slate-950/60 rounded p-2 overflow-x-auto font-mono max-h-32 overflow-y-auto custom-scroll">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}

      {/* Re-attempt for failed write-backs */}
      {failed && (
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={reattempt}
            disabled={reattempting}
            className="inline-flex items-center gap-1.5 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[10px] font-semibold text-rose-200 hover:bg-rose-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {reattempting ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {reattempting ? "Re-attempting…" : "Re-attempt"}
          </button>
          {reattemptError && <span className="text-[10px] text-rose-400 font-mono truncate">{reattemptError}</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AuditTimeline — the full audit log as a vertical timeline.
// Lifecycle milestones (signal/incident/writeback/resolution) are mirrored to
// DataHub Assertions in LIVE mode (seed in DEMO). The filter tabs let the
// operator focus on one phase of the incident.
// ---------------------------------------------------------------------------

function AuditTimeline({
  events,
  incidentUrn,
}: {
  events: Array<{ id: string; kind: string; summary: string; ts: string }>;
  incidentUrn?: string;
}) {
  const [filter, setFilter] = useState<AuditGroup | "all">("all");
  // Fetch the mirror mode + count from the dedicated audit endpoint.
  const mirrorInfo = useQuery<{ mode: "demo" | "live"; mirroredCount: number } | null>({
    queryKey: ["audit-mirror", incidentUrn ?? ""],
    queryFn: async () => {
      if (!incidentUrn) return null;
      const r = await fetch(`/api/agent/audit/${encodeURIComponent(incidentUrn)}`);
      if (!r.ok) return null;
      const j = await r.json();
      return { mode: j.mode as "demo" | "live", mirroredCount: j.mirroredCount as number };
    },
    staleTime: 10_000,
    enabled: Boolean(incidentUrn),
  });

  const filtered = filter === "all" ? events : events.filter((e) => AUDIT_KIND_META[e.kind]?.group === filter);
  const groups: AuditGroup[] = ["lifecycle", "reasoning", "tool", "action", "writeback", "error"];
  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of events) {
      const g = AUDIT_KIND_META[e.kind]?.group;
      if (g) counts[g] = (counts[g] ?? 0) + 1;
    }
    return counts;
  }, [events]);

  const mode = mirrorInfo.data?.mode;
  const mirroredCount = mirrorInfo.data?.mirroredCount ?? 0;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40">
      {/* Header */}
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-slate-800">
        <h3 className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
          <History className="h-3.5 w-3.5 text-slate-400" /> Audit log
          <span className="text-slate-500 font-normal">({events.length})</span>
        </h3>
        {/* Mirror badge */}
        <span
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${
            mode === "live"
              ? "bg-emerald-500/15 text-emerald-300"
              : "bg-slate-700/40 text-slate-300"
          }`}
          title={
            mode === "live"
              ? "Lifecycle events are mirrored as DataHub Assertions on the asset (LIVE DataHub)"
              : "Lifecycle events are mirrored into the SeedAssertion table (DEMO mode)"
          }
        >
          <Layers className="h-2.5 w-2.5" />
          {mode === "live" ? "Mirrored → DataHub" : "Mirrored → seed"}
          {mirroredCount > 0 && <span className="text-slate-500">·{mirroredCount}</span>}
        </span>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-slate-800 overflow-x-auto custom-scroll">
        <FilterTab active={filter === "all"} onClick={() => setFilter("all")} label="All" count={events.length} />
        {groups.map((g) => {
          const c = groupCounts[g] ?? 0;
          if (c === 0) return null;
          return (
            <FilterTab
              key={g}
              active={filter === g}
              onClick={() => setFilter(g)}
              label={AUDIT_GROUP_META[g].label}
              count={c}
              color={AUDIT_GROUP_META[g].color}
            />
          );
        })}
      </div>

      {/* Timeline */}
      <ul className="px-3.5 py-3 space-y-2.5 max-h-80 overflow-y-auto custom-scroll">
        {filtered.map((e, i) => {
          const meta = AUDIT_KIND_META[e.kind] ?? { icon: Activity, group: "reasoning" as AuditGroup, label: e.kind.toUpperCase(), color: "text-slate-400", dot: "bg-slate-500" };
          const Icon = meta.icon;
          const isLast = i === filtered.length - 1;
          return (
            <li key={e.id} className="flex gap-2.5">
              {/* Timeline rail */}
              <div className="flex flex-col items-center pt-0.5">
                <span className={`h-2 w-2 rounded-full ${meta.dot} ring-2 ring-slate-950 shrink-0`} />
                {!isLast && <span className="w-px flex-1 bg-slate-800 mt-1" />}
              </div>
              {/* Content */}
              <div className="flex-1 min-w-0 pb-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Icon className={`h-3 w-3 ${meta.color} shrink-0`} />
                  <span className={`text-[10px] font-mono uppercase tracking-wider ${meta.color}`}>{meta.label}</span>
                  <span className="ml-auto text-[10px] text-slate-600 font-mono shrink-0">
                    {new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-slate-300 break-words leading-relaxed">{e.summary}</div>
              </div>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li className="text-center py-4 text-xs text-slate-500">No events in this group.</li>
        )}
      </ul>
    </div>
  );
}

function FilterTab({
  active,
  onClick,
  label,
  count,
  color,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-mono whitespace-nowrap transition-colors ${
        active ? "bg-slate-700/60 text-slate-100" : "text-slate-500 hover:text-slate-300 hover:bg-slate-800/40"
      }`}
    >
      <span className={color}>{label}</span>
      <span className="text-slate-600">{count}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Actions panel — render GitHub issues + PRs + Slack posts as cards
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
  const trace = action.parsed?.trace === true;

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
      {action.url && !trace && (
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
// Guardrail panel — approval gates surfaced for human review
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
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 premium-card">
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
      <div className={`mt-1 font-mono text-lg font-bold tabular-nums ${highlight ? "text-emerald-300" : "text-slate-100"}`}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connector status card — live/trace + reachability
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
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 premium-card">
      <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
        <Terminal className="h-4 w-4 text-emerald-400" /> Connectors
        <span
          className={`ml-auto text-[10px] font-mono px-2 py-0.5 rounded ${
            status.dryRun
              ? "border border-amber-500/40 bg-amber-500/10 text-amber-300"
              : "border border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
          }`}
        >
          {status.dryRun ? "DRY-RUN" : "LIVE"}
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
          ? "Trace mode logs actions locally — safe. Toggle LIVE in the control bar to file real issues + posts."
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
  mode: "live" | "trace";
  reachable: boolean;
  tokenPresent: boolean;
  error?: string;
  hint?: string;
}) {
  const dotColor = !tokenPresent
    ? "bg-rose-400"
    : mode === "trace"
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
          {mode === "trace" ? "trace" : reachable ? "live · reachable" : tokenPresent ? "live · blocked" : "no token"}
        </span>
      </div>
      <div className="mt-1 text-[10px] font-mono text-slate-400 truncate">{target}</div>
      {hint && <div className="text-[10px] text-slate-500 font-mono">{hint}</div>}
      {error && <div className="text-[10px] text-rose-300 font-mono mt-0.5 truncate" title={error}>{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sticky bottom control bar — connector trace mode indicator, compounding
// re-run button, connector test button.
// ---------------------------------------------------------------------------

function DemoControlBar({
  status,
  running,
  replayRun,
  onReplayLoop,
  onTestConnectors,
}: {
  status: ConnectorStatus | null;
  running: boolean;
  replayRun: 0 | 1 | 2;
  onReplayLoop: () => void;
  onTestConnectors: (dryRun: boolean) => Promise<unknown>;
}) {
  const [testing, setTesting] = useState(false);
  const dryRun = status?.dryRun ?? true;
  const replayActive = replayRun !== 0;
  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-800 bg-slate-950/95 backdrop-blur supports-[backdrop-filter]:bg-slate-950/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5 flex flex-wrap items-center gap-3 text-xs">
        <span className="text-[11px] text-slate-500 font-mono">controls:</span>
        <div className="inline-flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-2.5 py-1">
          <span className={`h-2 w-2 rounded-full ${dryRun ? "bg-amber-400" : "bg-emerald-400"} animate-pulse`} />
          <span className="text-slate-400">actions</span>
          <span className={`font-mono ${dryRun ? "text-amber-300" : "text-emerald-300"}`}>
            {dryRun ? "DRY-RUN" : "LIVE"}
          </span>
          <span className="text-slate-600 text-[10px]">(SENTINEL_DRY_RUN={dryRun ? "true" : "false"})</span>
        </div>
        <button
          onClick={onReplayLoop}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-amber-300 hover:bg-amber-500/20 disabled:opacity-40 transition-colors"
          title="Run the ReAct loop twice on the nyc-taxi scenario. Run 2 reads Run 1's post-mortem before reasoning — the compounding-context beat."
        >
          {replayActive ? <RotateCw className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
          {replayActive ? `re-run · run ${replayRun} of 2` : "re-run with compounding context"}
        </button>
        <button
          onClick={() => onTestConnectors(dryRun)}
          disabled={testing || running}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-slate-300 hover:bg-slate-700/60 disabled:opacity-40 transition-colors"
          title="Open a test GitHub issue + post a test Slack card (uses the current mode)"
        >
          {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
          test connectors
        </button>
        <span className="ml-auto text-[10px] text-slate-600 hidden sm:inline">
          {dryRun
            ? "Trace mode logs actions locally — safe. Switch to LIVE in .env (SENTINEL_DRY_RUN=false) to file real issues + posts."
            : "LIVE mode: every Inject & run files real artifacts in your connected GitHub + Slack."}
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
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 premium-card">
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
    <div className="hidden md:inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1 tabular-nums">
      <Icon className="h-3 w-3 text-slate-500" />
      <span className="text-slate-500">{label}</span>
      <span className={`text-slate-300 max-w-[180px] truncate ${mono ? "font-mono" : ""}`} title={value}>{value}</span>
    </div>
  );
}

// Resilience — LLM circuit chip. Shows healthy (emerald) / throttled
// (rose, pulsing) / loading (slate) state, plus the cooldown countdown when
// the circuit is open. Surfaces the resilience state to the operator without
// masking it.
function LlmCircuitChip({ status }: { status?: LlmResilienceStatus }) {
  const loading = !status;
  const circuit = status?.circuit;
  const open = !!circuit?.isOpen;
  const secs = circuit ? Math.max(1, Math.ceil(circuit.msUntilReset / 1000)) : 0;

  if (loading) {
    return (
      <div className="hidden md:inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1">
        <Loader2 className="h-3 w-3 text-slate-500 animate-spin" />
        <span className="text-slate-500">Circuit</span>
        <span className="text-slate-400">…</span>
      </div>
    );
  }

  if (open) {
    return (
      <div
        className="hidden md:inline-flex items-center gap-1.5 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1"
        title={`Circuit open after ${circuit?.consecutiveFailures ?? 0} consecutive 429/5xx. Sentinel fails over to NVIDIA if a key is present, otherwise the orchestrator's fallback post-mortem path runs.`}
      >
        <span className="relative inline-flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500/60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
        </span>
        <ShieldAlert className="h-3 w-3 text-rose-400" />
        <span className="text-rose-300">Throttled</span>
        <span className="text-rose-400/80 font-mono">{secs}s</span>
      </div>
    );
  }

  return (
    <div
      className="hidden md:inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1"
      title={`LLM circuit healthy on provider '${status?.provider}'. Failover ${status?.failoverEnabled ? "armed (NVIDIA key present)" : "off"}.`}
    >
      <ShieldCheck className="h-3 w-3 text-emerald-500" />
      <span className="text-slate-500">Circuit</span>
      <span className="text-emerald-300">Healthy</span>
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

// ---------------------------------------------------------------------------
// IncidentHeader — on-call persona + failing asset + signal
// ---------------------------------------------------------------------------

const SCENARIO_META: Record<string, { label: string; color: string; bg: string; border: string; icon: typeof Radar }> = {
  "nyc-taxi-freshness": { label: "Freshness breach", color: "text-amber-300", bg: "bg-amber-500/10", border: "border-amber-500/40", icon: Clock },
  "showcase-ecommerce": { label: "Schema breakage", color: "text-emerald-300", bg: "bg-emerald-500/10", border: "border-emerald-500/40", icon: Database },
  "pii": { label: "PII governance", color: "text-rose-300", bg: "bg-rose-500/10", border: "border-rose-500/40", icon: Lock },
};

function IncidentHeader({ signal, asset, running, elapsed }: {
  signal: SeedSignal | null;
  asset: AssetEntity | null;
  running: boolean;
  elapsed: number;
}) {
  if (!signal) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <div className="flex items-center gap-3 text-slate-500">
          <User className="h-5 w-5" />
          <span className="text-sm">Select an injected signal to surface the on-call persona + failing asset.</span>
        </div>
      </section>
    );
  }
  const meta = SCENARIO_META[signal.scenarioId] ?? SCENARIO_META["nyc-taxi-freshness"];
  const Icon = meta.icon;
  const owner = asset?.owners?.[0];
  const ownerName = owner?.name ?? "Priya Patel";
  const initials = ownerName.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const lastMod = asset?.lastModifiedAt ? new Date(asset.lastModifiedAt).toISOString().slice(0, 16).replace("T", " ") + "Z" : null;

  return (
    <motion.section
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="rounded-xl border border-slate-800 bg-gradient-to-br from-slate-900/80 to-slate-900/40 p-5 premium-card"
    >
      <div className="flex flex-col sm:flex-row sm:items-start gap-4">
        {/* Persona card */}
        <div className="flex items-start gap-3 sm:w-64 shrink-0">
          <div className="h-12 w-12 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center text-slate-950 font-bold text-base shadow-lg shadow-emerald-900/40 ring-2 ring-emerald-500/30">
            {initials}
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">On-call data engineer</div>
            <div className="text-sm font-semibold text-slate-100 truncate">{ownerName}</div>
            <div className="text-[11px] font-mono text-slate-500 truncate">{owner?.ownerUrn ?? "urn:li:corpUser:priya.patel"}</div>
            <div className="mt-1 inline-flex items-center gap-1 rounded border border-rose-500/30 bg-rose-500/5 px-1.5 py-0.5 text-[10px] font-mono text-rose-300">
              <span className="h-1.5 w-1.5 rounded-full bg-rose-400 animate-pulse" /> paged · 03:14 UTC
            </div>
          </div>
        </div>

        {/* Failing asset + signal */}
        <div className="flex-1 min-w-0 border-l border-slate-800 sm:pl-4">
          <div className="flex items-center gap-2 mb-1.5">
            <span className={`inline-flex items-center gap-1.5 rounded-md border ${meta.border} ${meta.bg} px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider ${meta.color}`}>
              <Icon className="h-3 w-3" /> {meta.label}
            </span>
            <span className="text-[10px] font-mono text-slate-500">{signal.type} assertion</span>
            {running && (
              <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] font-mono text-emerald-300">
                <Loader2 className="h-3 w-3 animate-spin" /> investigating · {elapsed.toFixed(1)}s
              </span>
            )}
          </div>
          <h2 className="text-lg font-bold text-slate-50 truncate">{signal.label}</h2>
          <p className="text-sm text-slate-400 mt-1 leading-relaxed">{signal.description}</p>

          {/* Asset chip row */}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900/60 px-2 py-1 font-mono text-slate-300">
              <Database className="h-3 w-3 text-slate-500" />
              <span className="text-slate-500">asset:</span>
              <span className="text-slate-200">{asset?.name ?? signal.assetName}</span>
            </span>
            {asset?.platform && (
              <span className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900/60 px-2 py-1 font-mono text-slate-400">
                <Workflow className="h-3 w-3 text-slate-500" /> {asset.platform}
              </span>
            )}
            {asset?.governanceTags && asset.governanceTags.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 font-mono text-rose-300">
                <Lock className="h-3 w-3" /> {asset.governanceTags.map((t) => t.name).join(", ")}
              </span>
            )}
            {lastMod && (
              <span className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900/60 px-2 py-1 font-mono text-slate-400">
                <Clock className="h-3 w-3 text-slate-500" /> last_modified: {lastMod}
              </span>
            )}
          </div>

          {/* Assertion failure reason */}
          {signal.failureReason && (
            <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-200/90 leading-relaxed">
              <span className="font-mono text-[10px] uppercase tracking-wider text-rose-400">assertion failure · </span>
              {signal.failureReason}
            </div>
          )}
        </div>
      </div>
    </motion.section>
  );
}

// ---------------------------------------------------------------------------
// LineageGraph — SVG lineage with real-time traversal highlight
//
// Renders the asset's context graph (upstream + downstream) as a layered
// horizontal SVG. The root (failing asset) sits centre-left, highlighted.
// As the agent calls `mcp.get_lineage` in the reasoning trace, the traversed
// node is highlighted + its edge pulses.
// ---------------------------------------------------------------------------

const PLATFORM_COLOR: Record<string, string> = {
  s3: "#f59e0b",
  spark: "#10b981",
  dbt: "#10b981",
  snowflake: "#06b6d4",
  looker: "#f59e0b",
  airflow: "#f43f5e",
  postgres: "#10b981",
};

function platformColor(p: string): string {
  return PLATFORM_COLOR[p] ?? "#64748b";
}

function LineageGraph({ rootUrn, steps, running }: {
  rootUrn: string | null;
  steps: ReasoningStep[];
  running: boolean;
}) {
  const { data, isLoading } = useQuery<LineageGraphResponse>({
    queryKey: ["lineage-graph", rootUrn ?? ""],
    queryFn: async () => {
      if (!rootUrn) return null as unknown as LineageGraphResponse;
      const r = await fetch(`/api/datahub/lineage-graph?urn=${encodeURIComponent(rootUrn)}&maxHops=3`);
      if (!r.ok) throw new Error("Failed to load lineage graph");
      return (await r.json()) as LineageGraphResponse;
    },
    enabled: Boolean(rootUrn),
    staleTime: 120_000,
  });

  // Scan the reasoning trace for mcp.get_lineage tool calls — collect the URNs
  // the agent has traversed + the URN of the most recent call (the "active" node).
  const { traversedUrns, activeUrn, activeDirection } = useMemo(() => {
    const urns = new Set<string>();
    let active: string | null = null;
    let dir: "upstream" | "downstream" | null = null;
    for (const s of steps) {
      if (s.kind !== "tool_call" || !s.toolName) continue;
      if (s.toolName === "mcp.get_lineage" && s.toolArgs) {
        const urn = String(s.toolArgs.urn ?? "");
        if (urn) {
          urns.add(urn);
          active = urn;
          dir = (s.toolArgs.direction as "upstream" | "downstream") ?? "downstream";
        }
      }
    }
    return { traversedUrns: urns, activeUrn: active, activeDirection: dir };
  }, [steps]);

  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];

  if (!rootUrn) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <div className="flex items-center gap-3 text-slate-500">
          <Workflow className="h-5 w-5" />
          <span className="text-sm">Inject a signal to render the asset&apos;s lineage graph.</span>
        </div>
      </section>
    );
  }

  if (isLoading || nodes.length === 0) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <div className="flex items-center gap-3 text-slate-500">
          {running ? <Loader2 className="h-4 w-4 animate-spin text-emerald-400" /> : <Workflow className="h-5 w-5" />}
          <span className="text-sm">{running ? "Loading lineage graph…" : "No lineage edges seeded for this asset."}</span>
        </div>
      </section>
    );
  }

  // Layout: group nodes by degree, lay out columns left-to-right.
  const byDegree = new Map<number, LineageGraphNode[]>();
  for (const n of nodes) {
    const arr = byDegree.get(n.degree) ?? [];
    arr.push(n);
    byDegree.set(n.degree, arr);
  }
  const degrees = Array.from(byDegree.keys()).sort((a, b) => a - b);
  const minDeg = degrees[0];
  const maxDeg = degrees[degrees.length - 1];
  const colCount = maxDeg - minDeg + 1;
  const colWidth = 180;
  const nodeHeight = 56;
  const colGap = 60;
  const svgWidth = colCount * colWidth + (colCount - 1) * colGap + 40;
  // Compute per-column max stack to size the SVG height.
  const maxStack = Math.max(...degrees.map((d) => byDegree.get(d)!.length));
  const svgHeight = Math.max(maxStack * (nodeHeight + 16) + 40, 180);

  // Position each node.
  const pos = new Map<string, { x: number; y: number; node: LineageGraphNode }>();
  for (const deg of degrees) {
    const arr = byDegree.get(deg)!;
    const colX = 20 + (deg - minDeg) * (colWidth + colGap);
    const stackH = arr.length * (nodeHeight + 16);
    const startY = (svgHeight - stackH) / 2;
    arr.forEach((n, i) => {
      pos.set(n.urn, { x: colX, y: startY + i * (nodeHeight + 16), node: n });
    });
  }

  // Edge path generator — cubic bezier between node centres.
  function edgePath(fromUrn: string, toUrn: string): string {
    const a = pos.get(fromUrn);
    const b = pos.get(toUrn);
    if (!a || !b) return "";
    const x1 = a.x + colWidth;
    const y1 = a.y + nodeHeight / 2;
    const x2 = b.x;
    const y2 = b.y + nodeHeight / 2;
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  }

  const root = nodes.find((n) => n.degree === 0);
  const traversedArr = Array.from(traversedUrns);

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 premium-card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
          <Workflow className="h-4 w-4 text-emerald-400" /> Lineage graph
          <span className="text-[10px] font-mono text-slate-500">context · {nodes.length} nodes · {edges.length} edges</span>
        </h2>
        <div className="flex items-center gap-2 text-[10px] font-mono">
          {activeDirection && (
            <span className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">
              <GitFork className="h-3 w-3" /> traversing {activeDirection}
            </span>
          )}
          <span className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900/60 px-1.5 py-0.5 text-slate-400">
            <span className="h-2 w-2 rounded-full bg-emerald-400" /> root
          </span>
          <span className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-amber-300">
            <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" /> traversed
          </span>
        </div>
      </div>

      <div className="overflow-x-auto custom-scroll rounded-lg border border-slate-800 bg-slate-950/40">
        <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="w-full h-auto" style={{ minWidth: svgWidth }}>
          {/* Edges */}
          {edges.map((e, i) => {
            const isActiveEdge = (activeUrn && (e.from === activeUrn || e.to === activeUrn)) || false;
            const isTraversed = traversedArr.some((u) => e.from === u || e.to === u);
            const stroke = isActiveEdge ? "#f59e0b" : isTraversed ? "#fbbf24" : "#334155";
            const width = isActiveEdge ? 2.5 : isTraversed ? 2 : 1.25;
            return (
              <g key={`e-${i}`}>
                <path
                  d={edgePath(e.from, e.to)}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={width}
                  strokeDasharray={isActiveEdge ? "0" : isTraversed ? "0" : "4 4"}
                  opacity={isActiveEdge ? 1 : isTraversed ? 0.7 : 0.45}
                  markerEnd="url(#arrowhead)"
                  className={isActiveEdge ? "animate-pulse" : ""}
                />
              </g>
            );
          })}
          {/* Arrowhead marker */}
          <defs>
            <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L6,3 L0,6 Z" fill="#475569" />
            </marker>
            <marker id="arrowhead-active" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L6,3 L0,6 Z" fill="#f59e0b" />
            </marker>
          </defs>

          {/* Nodes */}
          {nodes.map((n) => {
            const p = pos.get(n.urn)!;
            const isRoot = n.degree === 0;
            const isActive = activeUrn === n.urn;
            const isTraversed = traversedUrns.has(n.urn) && !isRoot;
            const color = platformColor(n.platform);
            const fill = isRoot ? "#064e3b" : isActive ? "#78350f" : isTraversed ? "#422006" : "#0f172a";
            const strokeColor = isRoot ? "#10b981" : isActive ? "#f59e0b" : isTraversed ? "#fbbf24" : "#1e293b";
            const textColor = isRoot ? "#ecfdf5" : isActive ? "#fef3c7" : isTraversed ? "#fde68a" : "#cbd5e1";
            return (
              <g key={n.urn} transform={`translate(${p.x}, ${p.y})`}>
                {isActive && (
                  <rect
                    x={-3} y={-3}
                    width={colWidth + 6} height={nodeHeight + 6}
                    rx={10}
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth="1.5"
                    opacity="0.6"
                    className="animate-pulse"
                  />
                )}
                <rect
                  width={colWidth} height={nodeHeight}
                  rx={8}
                  fill={fill}
                  stroke={strokeColor}
                  strokeWidth={isRoot ? 2 : 1.5}
                />
                {/* Platform dot */}
                <circle cx={16} cy={18} r={5} fill={color} />
                {/* Name */}
                <text x={28} y={22} fill={textColor} fontSize="11" fontWeight="600" fontFamily="ui-monospace, monospace">
                  {n.name.length > 20 ? n.name.slice(0, 18) + "…" : n.name}
                </text>
                {/* Type + platform */}
                <text x={16} y={38} fill="#94a3b8" fontSize="9" fontFamily="ui-monospace, monospace">
                  {n.platform} · {n.type}
                </text>
                {/* Degree / role label */}
                <text x={16} y={50} fill={isRoot ? "#34d399" : "#64748b"} fontSize="8" fontFamily="ui-monospace, monospace" letterSpacing="0.05em">
                  {isRoot ? "FAILING ASSET" : n.degree < 0 ? `UPSTREAM ${n.degree}` : `DOWNSTREAM +${n.degree}`}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Legend / traversal summary */}
      {traversedArr.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] font-mono text-slate-500">
          <GitFork className="h-3 w-3 text-amber-400" />
          <span className="text-slate-400">agent traversed:</span>
          {traversedArr.map((u) => {
            const n = nodes.find((x) => x.urn === u);
            return (
              <span key={u} className={`rounded px-1.5 py-0.5 border ${activeUrn === u ? "border-amber-500/50 bg-amber-500/10 text-amber-300" : "border-slate-700 bg-slate-900/40 text-slate-400"}`}>
                {n?.name ?? u.slice(-20)}
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// AuditLogDrawer — collapsible side drawer streaming every event
// ---------------------------------------------------------------------------

function AuditLogDrawer({
  open,
  onClose,
  events,
  incidentUrn,
}: {
  open: boolean;
  onClose: () => void;
  events: Array<{ id: string; kind: string; summary: string; ts: string }>;
  incidentUrn: string | null;
}) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm"
          />
          <motion.aside
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 26, stiffness: 240 }}
            className="fixed top-0 right-0 z-50 h-full w-full sm:w-[420px] bg-slate-950 border-l border-slate-800 shadow-2xl flex flex-col"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-emerald-400" />
                <h2 className="text-sm font-semibold text-slate-200">Audit log drawer</h2>
                <span className="text-[10px] font-mono text-slate-500">({events.length})</span>
              </div>
              <button
                onClick={onClose}
                className="text-slate-500 hover:text-slate-200 transition-colors"
                title="Close drawer"
              >
                <PanelRightClose className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto custom-scroll">
              {events.length === 0 ? (
                <div className="text-center py-10 px-4 text-sm text-slate-500">
                  <History className="h-10 w-10 mx-auto mb-2 opacity-30" />
                  No audit events yet. Inject a signal + run Sentinel to stream the full lifecycle.
                </div>
              ) : (
                <AuditTimeline events={events} incidentUrn={incidentUrn ?? undefined} />
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

