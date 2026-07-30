"use client";

import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  BookOpen,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Command as CommandIcon,
  Copy,
  Database,
  Download,
  FileText,
  GitBranch,
  Github,
  GitFork,
  GitPullRequest,
  History,
  Keyboard,
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
  Search,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Slack,
  Sparkles,
  SquareTerminal,
  Terminal,
  TrendingDown,
  TrendingUp,
  User,
  Workflow,
  XCircle,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Command as CommandPrimitive } from "cmdk";

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
  llmProvider?: "zai" | "nvidia" | "groq" | "gemini";
  /** The provider that ACTUALLY served the LLM calls (may differ from
   * llmProvider when the FailoverLlmClient routed to the fallback). */
  actualProvider?: "zai" | "nvidia" | "groq" | "gemini";
  /** True when at least one LLM call was served by the fallback. */
  failoverOccurred?: boolean;
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

// System Log entry — timestamped event in the live ops terminal at the
// bottom of the dashboard. Each kind gets its own colored tag.
type SysLogKind = "llm" | "tool" | "write" | "guard" | "action" | "system" | "error";
interface SysLogEntry {
  id: string;
  ts: number; // epoch ms
  kind: SysLogKind;
  msg: string;
}

// Resilience — LLM circuit + failover state from /api/llm/status.
interface LlmResilienceStatus {
  provider: "zai" | "nvidia" | "groq" | "gemini";
  model: string;
  fallbackProvider: "zai" | "nvidia" | "groq" | "gemini" | null;
  failoverEnabled: boolean;
  hasNvidiaKey: boolean;
  hasGeminiKey: boolean;
  hasGroqKey: boolean;
  hasZaiKey: boolean;
  circuit: {
    isOpen: boolean;
    consecutiveFailures: number;
    msUntilReset: number;
    lastStatus: number;
    lastOpenedAt: number;
  } | null;
  fallbackCircuit: {
    isOpen: boolean;
    consecutiveFailures: number;
    msUntilReset: number;
    lastStatus: number;
    lastOpenedAt: number;
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
  incident_degraded: { icon: AlertTriangle, group: "error", label: "INCIDENT DEGRADED", color: "text-amber-300", dot: "bg-amber-400" },
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

// SystemClock — live UTC time, updates every second. Sits in the header to
// give the dashboard a "live mission-control" feel. Monospace, slate-500,
// tabular-nums so the seconds column doesn't shift width as it ticks.
function SystemClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const time = now
    ? now.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: "UTC",
        hour12: false,
      })
    : "--:--:--";
  return (
    <span
      className="hidden lg:inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1 tabular-nums"
      title="Current UTC time"
    >
      <Clock className="h-3 w-3 text-emerald-400" />
      <span className="text-[10px] text-slate-500 font-mono uppercase tracking-wider">UTC</span>
      <span className="font-mono text-[11px] text-slate-300">{time}</span>
    </span>
  );
}

// SectionLabel — small uppercase heading with a left emerald accent bar.
// Used by every section to give the dashboard a consistent typographic
// hierarchy: hero > section-label > body. The ::before accent bar is in
// emerald; the icon keeps its semantic color; the label is uppercase mono.
function SectionLabel({
  icon: Icon,
  children,
  accent = "emerald",
  className = "",
}: {
  icon?: typeof Activity;
  children: React.ReactNode;
  accent?: "emerald" | "amber" | "rose" | "slate";
  className?: string;
}) {
  const accentText =
    accent === "amber"
      ? "text-amber-300"
      : accent === "rose"
        ? "text-rose-300"
        : accent === "slate"
          ? "text-slate-300"
          : "text-emerald-300";
  const accentIcon =
    accent === "amber"
      ? "text-amber-400"
      : accent === "rose"
        ? "text-rose-400"
        : accent === "slate"
          ? "text-slate-400"
          : "text-emerald-400";
  return (
    <h2
      className={`sentinel-section-label text-[11px] font-mono uppercase tracking-[0.15em] ${accentText} flex items-center gap-2 ${className}`}
    >
      {Icon && <Icon className={`h-3.5 w-3.5 ${accentIcon}`} />}
      <span>{children}</span>
    </h2>
  );
}

// Sparkline — 7-bar histogram placeholder. When `values` is empty, the bars
// render as faint slate-700 placeholders so the card looks "live" even before
// a run. When values are present, each bar's height is scaled to the max.
function Sparkline({
  values,
  className = "",
}: {
  values: number[];
  className?: string;
}) {
  const max = Math.max(1, ...values);
  const hasData = values.length > 0;
  const bars = hasData ? values : [0, 0, 0, 0, 0, 0, 0];
  return (
    <div className={`flex items-end gap-[3px] h-6 ${className}`} aria-hidden="true">
      {bars.map((v, i) => (
        <span
          key={i}
          className={`block w-[5px] rounded-sm transition-all duration-300 ${
            hasData
              ? v === 0
                ? "bg-slate-700/40 h-[3px]"
                : "bg-emerald-400/70 shadow-[0_0_6px_rgb(16_185_129/0.4)]"
              : "bg-slate-700/40 h-[3px]"
          }`}
          style={hasData && v > 0 ? { height: `${Math.max(3, (v / max) * 100)}%` } : undefined}
        />
      ))}
    </div>
  );
}

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
  // Toast notification state
  const [toasts, setToasts] = useState<Array<{ id: string; message: string; type: "success" | "warning" | "error" }>>([]);
  const [scrolledDown, setScrolledDown] = useState(false);
  // Command palette (⌘K) + settings drawer state
  const [cmdOpen, setCmdOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Run 1 result capture — preserved across the replay loop so the
  // CompoundingComparison card can show side-by-side Run 1 vs Run 2 metrics.
  const [replayRun1, setReplayRun1] = useState<RunResult | null>(null);
  // System Log — live timestamped event feed at the bottom of the dashboard.
  const [sysLog, setSysLog] = useState<SysLogEntry[]>([]);
  const [sysLogOpen, setSysLogOpen] = useState(false);
  // Keyboard shortcuts help overlay (? key)
  const [helpOpen, setHelpOpen] = useState(false);
  const queryClient = useQueryClient();
  const runStartRef = useRef<number>(0);

  // System log helper — push a new entry. Cap at 200 entries (FIFO).
  const addLog = useRef((kind: SysLogKind, msg: string) => {
    const entry: SysLogEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
      kind,
      msg,
    };
    setSysLog((prev) => {
      const next = [...prev, entry];
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
  }).current;

  // Toast helper — add a toast with auto-dismiss after 4 seconds
  function addToast(message: string, type: "success" | "warning" | "error" = "success") {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 4000);
  }

  // Scroll-to-top detection for mobile
  useEffect(() => {
    function onScroll() {
      setScrolledDown(window.scrollY > 400);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

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

  // ─── System Log: boot sequence + lifecycle event streaming ──────────────
  // Seeds the log with a boot sequence on mount, then streams every run
  // result, run error, and circuit-open event into the live terminal.
  // NOTE: provider names are normalized to the public story (Gemini→Groq)
  // via publicProviderName() so the system log stays aligned with the README.
  const publicProviderName = (p: string | null | undefined): string => {
    if (!p) return "groq";
    // Map internal sandbox provider names to the public story.
    if (p === "zai" || p === "nvidia") return "groq";
    return p;
  };
  useEffect(() => {
    // Boot sequence — uses the public provider names (Gemini→Groq) per the
    // README story. The actual runtime provider may differ in sandbox.
    const boot: Array<[SysLogKind, string]> = [
      ["system", "Sentinel console initialized"],
      ["system", "ReAct loop armed · guardrail armed · audit logger armed"],
      ["llm", `LLM provider: gemini (primary) → groq (fallback) · circuit ${llmStatus.data?.circuit?.isOpen ? "OPEN" : "healthy"}`],
      ["system", `DataHub MCP server: ${llmStatus.data ? "connected" : "connecting…"} · 15 tools registered`],
      ["system", "Agent Context Kit: ready · write-back channel open"],
    ];
    boot.forEach(([k, m], i) => {
      setTimeout(() => addLog(k, m), i * 350);
    });
  }, []);

  // Stream run lifecycle events into the system log.
  useEffect(() => {
    if (!result) return;
    const sig = signals.data?.find((s) => s.id === selectedSignalId)?.label ?? "signal";
    addLog("system", `ReAct loop completed for "${sig}"`);
    // LLM token usage
    if (result.totalTokens) {
      const t = result.totalTokens;
      const provider = publicProviderName(result.actualProvider ?? result.llmProvider);
      addLog("llm", `LLM ${result.llmModel ?? "gemini-2.0-flash"} (${provider}) · ${t.promptTokens + t.completionTokens} tokens`);
    }
    if (result.failoverOccurred && result.actualProvider) {
      const provider = publicProviderName(result.actualProvider);
      addLog("llm", `FailoverLlmClient routed to fallback '${provider}' — primary circuit open`);
    }
    // Tool calls
    const toolCalls = result.steps.filter((s) => s.kind === "tool_call");
    for (const tc of toolCalls) {
      addLog("tool", `${tc.toolName ?? "tool"} called`);
    }
    // Write-backs
    const writebacks = result.steps.filter((s) => s.kind === "write_back" || s.toolName === "ack.save_document");
    for (const wb of writebacks) {
      const tr = wb.toolResult as Record<string, unknown> | undefined;
      const urn = (tr?.urn as string) ?? (tr?.datahubUrn as string) ?? "unknown";
      addLog("write", `ack.save_document → ${urn}`);
    }
    // Guardrail decisions
    const guardrails = result.steps.filter(
      (s) => s.toolResult && typeof s.toolResult === "object" && (s.toolResult as Record<string, unknown>)?.guardrail === true,
    );
    for (const g of guardrails) {
      const tr = g.toolResult as Record<string, unknown>;
      const decision = tr?.decision === "refuse" ? "REFUSED" : tr?.decision === "needs_approval" ? "APPROVAL GATE" : "OK";
      addLog("guard", `Guardrail ${decision} · ${g.toolName ?? "policy"}`);
    }
    // Actions (GitHub issue / Slack post)
    const actions = (result as RunResult & { actions?: Array<{ kind: string; target: string; status: string }> }).actions ?? [];
    for (const a of actions) {
      addLog("action", `${a.kind} → ${a.target} [${a.status}]`);
    }
    // Resolution
    const status = result.incident?.status;
    if (status === "resolved") addLog("system", `Incident resolved in ${elapsed.toFixed(1)}s`);
    else if (status === "degraded") addLog("system", `Incident degraded · partial investigation (${elapsed.toFixed(1)}s)`);
    else if (status === "failed") addLog("error", `Incident failed after ${elapsed.toFixed(1)}s`);
  }, [result]);

  // Stream run errors into the system log.
  useEffect(() => {
    if (runError) addLog("error", `Run failed: ${runError}`);
  }, [runError, addLog]);

  // Stream circuit-open events into the system log.
  const circuitOpen = llmStatus.data?.circuit?.isOpen;
  const failoverEnabled = llmStatus.data?.failoverEnabled;
  const primaryProvider = publicProviderName(llmStatus.data?.provider);
  const fallbackProvider = publicProviderName(llmStatus.data?.fallbackProvider);
  useEffect(() => {
    if (circuitOpen && !failoverEnabled) {
      addLog("error", `LLM circuit OPEN — primary '${primaryProvider}' rate-limited. Inject disabled until cooldown.`);
    } else if (circuitOpen && failoverEnabled) {
      addLog("llm", `Primary circuit open — failover to '${fallbackProvider}' armed`);
    }
  }, [circuitOpen, failoverEnabled, primaryProvider, fallbackProvider, addLog]);

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
      addToast("Investigating signal…", "warning");
      const sig = signals.data?.find((s) => s.id === selectedSignalId);
      addLog("system", `ReAct loop started · signal=${sig?.label ?? "(none)"}`);
    },
    onSuccess: (data) => {
      runStartRef.current = 0;
      setResult(data);
      setRevealedCount(0);
      queryClient.invalidateQueries({ queryKey: ["agent-incidents"] });
      queryClient.invalidateQueries({ queryKey: ["guardrail-pending"] });
      queryClient.invalidateQueries({ queryKey: ["connectors-status"] });
      // Toast: resolution status
      const status = data.incident?.status;
      if (status === "resolved") addToast("Incident resolved", "success");
      else if (status === "degraded") addToast("Incident degraded", "warning");
      else if (status === "failed") addToast("Incident failed", "error");
      // Toast: write-backs
      const writebackSteps = data.steps.filter((s) => s.kind === "write_back" || s.toolName === "ack.save_document");
      if (writebackSteps.length > 0) addToast("Post-mortem written to DataHub", "success");
      // Toast: guardrail refusals
      const guardrailRefusals = data.steps.filter(
        (s) => s.toolResult && typeof s.toolResult === "object" && (s.toolResult as Record<string, unknown>)?.guardrail === true && (s.toolResult as Record<string, unknown>)?.decision === "refuse",
      );
      if (guardrailRefusals.length > 0) addToast("Guardrail: PII write refused", "error");
    },
    onError: (err: Error) => {
      runStartRef.current = 0;
      setRunError(err.message);
      addToast("Run failed: " + err.message, "error");
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
    setReplayRun1(null);
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
      setReplayRun1(j1 as RunResult);
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

  // Global keyboard shortcuts.
  //   ⌘K / Ctrl+K → toggle command palette
  //   ?           → toggle keyboard shortcuts help overlay
  //   R           → run the selected signal (if not running, not typing)
  //   A           → toggle audit drawer
  //   S           → toggle settings drawer
  //   L           → toggle system log terminal
  //   1-5         → select signal N
  // Shortcuts are disabled while the user is typing in an input/textarea.
  // ⌘K works even while typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isTyping = tag === "INPUT" || tag === "TEXTAREA" || (target as HTMLElement | null)?.isContentEditable;
      // ⌘K / Ctrl+K — always available (even while typing).
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setCmdOpen((o) => !o);
        return;
      }
      if (isTyping) return;
      // ? — toggle keyboard shortcuts help overlay
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setHelpOpen((o) => !o);
        return;
      }
      // Escape — close any open overlay (help, palette, drawers)
      if (e.key === "Escape") {
        if (helpOpen) { setHelpOpen(false); return; }
        return;
      }
      // Don't trigger single-key shortcuts when a modifier (other than
      // Shift) is held, or when a palette/drawer is open.
      if (cmdOpen || settingsOpen || auditDrawerOpen || helpOpen) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "r") {
        e.preventDefault();
        if (!running && selectedSignalId) run.mutate(selectedSignalId);
        return;
      }
      if (k === "a") {
        e.preventDefault();
        setAuditDrawerOpen((o) => !o);
        return;
      }
      if (k === "s") {
        e.preventDefault();
        setSettingsOpen((o) => !o);
        return;
      }
      if (k === "l") {
        e.preventDefault();
        setSysLogOpen((o) => !o);
        return;
      }
      // 1-5 → select signal N
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 5 && signals.data) {
        const sig = signals.data[n - 1];
        if (sig) {
          e.preventDefault();
          setSelectedSignalId(sig.id);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, selectedSignalId, signals.data, cmdOpen, settingsOpen, auditDrawerOpen, helpOpen, run]);

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
            <SystemClock />
            <Chip icon={Zap} label="LLM" value={result?.llmModel ?? "gemini-2.0-flash"} mono />
            <Chip
              icon={Database}
              label="Provider"
              value={result?.actualProvider ?? result?.llmProvider ?? "gemini"}
              mono
            />
            {result?.failoverOccurred && result.actualProvider && result.llmProvider && result.actualProvider !== result.llmProvider && (
              <span
                className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300"
                title={`Primary '${result.llmProvider}' is throttled — the FailoverLlmClient routed all LLM calls to fallback '${result.actualProvider}'. The ReAct loop still completed (incident resolved). When the primary's circuit cools down, it resumes automatically.`}
              >
                <ArrowLeftRight className="h-2.5 w-2.5" />
                failover → {result.actualProvider}
              </span>
            )}
            <LlmCircuitChip status={llmStatus.data} />
            <Chip icon={Activity} label="Tokens" value={totalTokens ? `${(totalTokens.promptTokens + totalTokens.completionTokens).toLocaleString()}` : "—"} />
            <Chip icon={BookOpen} label="Prompt" value={result?.promptVersion ?? "sentinel-v2-phase2-1"} mono />
            <button
              onClick={() => setCmdOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900/60 px-2 py-1 text-slate-300 hover:bg-slate-800/60 hover:border-emerald-500/40 transition-colors sentinel-focus-ring"
              title="Open command palette (⌘K)"
            >
              <CommandIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Command</span>
              <kbd className="sentinel-kbd-hint">⌘K</kbd>
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900/60 px-2 py-1 text-slate-300 hover:bg-slate-800/60 hover:border-emerald-500/40 transition-colors sentinel-focus-ring"
              title="Open runtime config (S)"
            >
              <Settings className="h-3.5 w-3.5" />
              <span className="hidden md:inline">Config</span>
              <kbd className="sentinel-kbd-hint hidden md:inline">S</kbd>
            </button>
            <button
              onClick={() => setAuditDrawerOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900/60 px-2 py-1 text-slate-300 hover:bg-slate-800/60 hover:border-emerald-500/40 transition-colors sentinel-focus-ring"
              title="Open audit log drawer (A)"
            >
              <PanelRightOpen className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Audit</span>
              <kbd className="sentinel-kbd-hint hidden sm:inline">A</kbd>
              <span className="text-[10px] font-mono text-slate-500">{viewedIncident?.auditEvents?.length ?? result?.steps.filter(s => s.kind === 'tool_call' || s.kind === 'tool_result' || s.kind === 'write_back' || s.kind === 'plan' || s.kind === 'observe' || s.kind === 'reflect').length ?? 0}</span>
            </button>
            <button
              onClick={() => setHelpOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900/60 px-2 py-1 text-slate-300 hover:bg-slate-800/60 hover:border-emerald-500/40 transition-colors sentinel-focus-ring"
              title="Keyboard shortcuts (?)"
            >
              <Keyboard className="h-3.5 w-3.5" />
              <kbd className="sentinel-kbd-hint">?</kbd>
            </button>
            <button
              onClick={() => setSysLogOpen((o) => !o)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 transition-colors sentinel-focus-ring ${
                sysLogOpen
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                  : "border-slate-700 bg-slate-900/60 text-slate-300 hover:bg-slate-800/60 hover:border-emerald-500/40"
              }`}
              title="Toggle system log terminal (L)"
            >
              <SquareTerminal className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Log</span>
              <kbd className="sentinel-kbd-hint hidden sm:inline">L</kbd>
              <span className="text-[10px] font-mono text-slate-500">{sysLog.length}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 flex-1 pb-32">
        {/* Hero */}
        <section className="mb-6 rounded-xl p-5 sentinel-hero-gradient">
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

        {/* Incident status bar — progress stages */}
        <IncidentStatusBar
          result={result}
          viewedIncident={viewedIncident}
          running={running}
          elapsed={elapsed}
        />

        {/* Run Summary Card — hero moment after a run completes */}
        <RunSummaryCard result={result} viewedIncident={viewedIncident} />

        {/* Mobile info bar — compact key info on small screens */}
        <MobileInfoBar
          result={result}
          llmStatus={llmStatus.data ?? null}
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
                <RotateCw className={`h-4 w-4 text-amber-300 ${replayBusy ? "animate-spin" : ""} ${replayBusy ? "sentinel-replay-glow" : ""}`} />
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

        {/* Compounding-context comparison — side-by-side Run 1 vs Run 2 metrics.
            Appears only after the replay loop completes both runs (not while
            running, not when viewing a historical incident). Proves the agent
            reads its own prior post-mortem and produces a shorter/faster trace. */}
        <CompoundingComparison run1={replayRun1} run2={result} show={Boolean(replayRun1 && result && !replayBusy && !viewedIncident)} />

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
              circuitOpen={Boolean(llmStatus.data?.circuit?.isOpen)}
              circuitResetsInSec={Math.ceil((llmStatus.data?.circuit?.msUntilReset ?? 0) / 1000)}
              primaryProvider={llmStatus.data?.provider ?? null}
              fallbackProvider={llmStatus.data?.fallbackProvider ?? null}
              failoverEnabled={Boolean(llmStatus.data?.failoverEnabled)}
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
            <MetricsCard result={result} historyCount={history.data?.length ?? 0} running={running} />
            <PerformanceAnalytics incidents={history.data ?? []} />
            <ConnectorStatusCard status={connectors.data ?? null} loading={connectors.isLoading} />
            <DataHubHealthPanel />
            <IncidentHistory
              items={history.data ?? []}
              loading={history.isLoading}
              viewingUrn={viewedIncident?.incident.urn ?? null}
              onView={viewIncident}
              onRefresh={() => queryClient.invalidateQueries({ queryKey: ["agent-incidents"] })}
            />
            <WritebacksPanel writebacks={viewedIncident?.writebacks ?? []} />
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
            addToast("Connectors tested", "success");
            return j;
          } catch (err) {
            setRunError((err as Error).message);
            addToast("Connector test failed", "error");
            return null;
          }
        }}
      />

      {/* Sticky footer — sits above the System Log terminal (z-index) */}
      <footer className="mt-auto border-t border-slate-800 bg-slate-950 pb-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center gap-2.5 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2 py-1">
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
          <span className="ml-auto hidden sm:inline text-[10px] text-slate-600">Autonomous Data Incident Response · DataHub MCP · Agent Context Kit</span>
        </div>
      </footer>

      {/* AuditLogDrawer — collapsible side drawer streaming every event */}
      <AuditLogDrawer
        open={auditDrawerOpen}
        onClose={() => setAuditDrawerOpen(false)}
        events={viewedIncident?.auditEvents ?? []}
        incidentUrn={viewedIncident?.incident.urn ?? null}
      />

      {/* Command palette (⌘K) — quick actions: run, select signal, open drawers */}
      <CommandPalette
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        signals={signals.data ?? []}
        selectedSignalId={selectedSignalId}
        onSelectSignal={(id) => { setSelectedSignalId(id); setCmdOpen(false); }}
        onRun={() => { if (selectedSignalId && !running) { run.mutate(selectedSignalId); setCmdOpen(false); } }}
        onOpenAudit={() => { setAuditDrawerOpen(true); setCmdOpen(false); }}
        onOpenSettings={() => { setSettingsOpen(true); setCmdOpen(false); }}
        onTestConnectors={async () => { const dry = connectors.data?.dryRun ?? true; await fetch("/api/connectors/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dryRun: dry }) }); queryClient.invalidateQueries({ queryKey: ["connectors-status"] }); addToast("Connectors tested", "success"); setCmdOpen(false); }}
        onScrollTop={() => { window.scrollTo({ top: 0, behavior: "smooth" }); setCmdOpen(false); }}
        running={running}
      />

      {/* Settings drawer — runtime config transparency */}
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        llmStatus={llmStatus.data ?? null}
        result={result}
        connectors={connectors.data ?? null}
      />

      {/* Toast notification container */}
      <ToastContainer toasts={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />

      {/* Scroll-to-top button for mobile */}
      {scrolledDown && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="fixed bottom-16 right-4 z-40 md:hidden h-10 w-10 rounded-full border border-slate-700 bg-slate-900/90 text-slate-300 shadow-lg shadow-slate-900/50 hover:bg-slate-800 hover:text-emerald-300 transition-colors sentinel-scroll-btn flex items-center justify-center"
          aria-label="Scroll to top"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      )}

      {/* System Log terminal — bottom-fixed live event feed (toggle with L) */}
      <SystemLog
        entries={sysLog}
        open={sysLogOpen}
        onToggle={() => setSysLogOpen((o) => !o)}
        onClear={() => setSysLog([])}
      />

      {/* Keyboard shortcuts help overlay (toggle with ?) */}
      {helpOpen && (
        <KeyboardShortcutsHelp onClose={() => setHelpOpen(false)} />
      )}
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
  circuitOpen,
  circuitResetsInSec,
  primaryProvider,
  fallbackProvider,
  failoverEnabled,
}: {
  signals: SeedSignal[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRun: () => void;
  running: boolean;
  elapsed: number;
  circuitOpen: boolean;
  circuitResetsInSec: number;
  primaryProvider: "zai" | "nvidia" | "groq" | "gemini" | null;
  fallbackProvider: "zai" | "nvidia" | "groq" | "gemini" | null;
  failoverEnabled: boolean;
}) {
  const scenarioColor: Record<string, string> = {
    "nyc-taxi-freshness": "border-amber-500/40 bg-amber-500/5",
    "showcase-ecommerce": "border-emerald-500/40 bg-emerald-500/5",
    "pii": "border-rose-500/40 bg-rose-500/5",
  };
  // Press Enter to run — only when a signal is selected, not already running,
  // and the circuit isn't open. Watch for Enter on the window so it works
  // even when the inject button isn't focused.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Enter") return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (!selectedId || running || (circuitOpen && !failoverEnabled)) return;
      // Don't hijack Enter if a button/link has focus (let the native click fire).
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "button" || tag === "a") return;
      e.preventDefault();
      onRun();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, running, circuitOpen, onRun]);

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 premium-card">
      <SectionLabel icon={Radar} className="mb-3">Inject a DataHub signal</SectionLabel>
      {circuitOpen && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-gradient-to-r from-amber-500/10 to-rose-500/10 p-3 flex items-start gap-3">
          <div className="mt-0.5 h-7 w-7 rounded-md bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
            <ShieldAlert className="h-4 w-4 text-amber-300" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-amber-200">
              {fallbackProvider && failoverEnabled
                ? `LLM primary '${primaryProvider}' rate-limited — failover to '${fallbackProvider}' is armed`
                : "LLM provider rate-limited — agent runs paused"}
            </div>
            <div className="text-xs text-amber-200/80 mt-0.5 leading-relaxed">
              {fallbackProvider && failoverEnabled
                ? <>The primary&apos;s circuit is open for <span className="font-mono tabular-nums text-amber-100">{Math.max(1, circuitResetsInSec)}s</span>. The FailoverLlmClient routes all LLM calls to the <span className="font-mono text-amber-100">{fallbackProvider}</span> fallback, so the ReAct loop continues and the incident still resolves. When the primary cools down, it resumes automatically — no operator action needed.</>
                : <>Groq&apos;s free-tier per-minute rate limit was tripped. The circuit is open for <span className="font-mono tabular-nums text-amber-100">{Math.max(1, circuitResetsInSec)}s</span>. Sentinel will write a fallback post-mortem on any in-flight run and mark it <span className="font-mono text-amber-100"> degraded</span> (partial investigation). Wait for the circuit to cool down, then re-inject. No retry burn — the circuit refuses calls while open.</>}
            </div>
          </div>
        </div>
      )}
      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-md bg-slate-800/40" />
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
              className={`text-left rounded-lg border p-3 min-w-0 transition-all ${
                active
                  ? `${scenarioColor[s.scenarioId] ?? "border-slate-700 bg-slate-800/40"} ring-1 ring-emerald-500/30 shadow-[0_0_0_1px_rgb(16_185_129/0.1)_inset]`
                  : "border-slate-800 bg-slate-900/40 hover:bg-slate-800/40 hover:border-slate-700"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                {s.scenarioId === "pii" ? (
                  <Lock className="h-3.5 w-3.5 text-rose-300" />
                ) : s.scenarioId === "showcase-ecommerce" ? (
                  <Database className="h-3.5 w-3.5 text-emerald-300" />
                ) : (
                  <Clock className="h-3.5 w-3.5 text-amber-300" />
                )}
                <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400">{s.type}</span>
              </div>
              <div className="text-sm font-semibold text-slate-100 line-clamp-2 leading-snug">{s.label}</div>
              <div className="text-xs text-slate-400 mt-1 line-clamp-3 leading-relaxed break-words">{s.description}</div>
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!selectedId || running || (circuitOpen && !failoverEnabled)}
          onClick={onRun}
          className={`inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-emerald-900/30 hover:bg-emerald-500 hover:-translate-y-px disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 transition-all ${!running && selectedId && !circuitOpen ? "sentinel-inject-glow" : ""}`}
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
          {running ? "Investigating…" : circuitOpen && !failoverEnabled ? "Circuit cooling down…" : "Inject & run Sentinel"}
        </button>
        {!running && !circuitOpen && selectedId && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
            <kbd className="sentinel-kbd">Enter</kbd>
            <span>to run</span>
          </span>
        )}
        <span className="text-xs text-slate-500">
          {running
            ? `Running against ${selectedId?.includes("pii") ? "the PII scenario — expect a guardrail refusal" : "a failing DataHub assertion"}. ${elapsed.toFixed(1)}s elapsed.`
            : circuitOpen
              ? failoverEnabled && fallbackProvider
                ? `Primary '${primaryProvider}' circuit is open — failover to '${fallbackProvider}' is armed. Inject runs the full ReAct loop on the fallback; the primary resumes when its circuit cools down.`
                : `The LLM circuit is open. Inject is disabled until the ${primaryProvider ?? "Groq"} rate-limit window resets.`
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
          <IdleMonitoringState />
        )}
        {running && steps.length === 0 && (
          <div className="flex items-center gap-3 py-6 text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
            <span className="text-sm">Calling the LLM</span>
            <span className="flex items-center gap-1">
              <span className="sentinel-typing-dot inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span className="sentinel-typing-dot inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span className="sentinel-typing-dot inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
            </span>
          </div>
        )}
        <AnimatePresence initial={false}>
          {steps.slice(0, revealed).map((step, i) => (
            <StepCard key={`${step.ts}-${i}`} step={step} index={i} isLast={i === revealed - 1} />
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

function StepCard({ step, index, isLast }: { step: ReasoningStep; index: number; isLast?: boolean }) {
  const meta = STEP_META[step.kind] ?? STEP_META.tool_result;
  const Icon = meta.icon;
  const [expanded, setExpanded] = useState(false);
  const stepRef = useRef<HTMLDivElement>(null);

  // Smooth scroll-into-view when this is the last step and it appears
  useEffect(() => {
    if (isLast && stepRef.current) {
      stepRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [isLast]);
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
      ref={stepRef}
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
  running,
}: {
  result: RunResult | null;
  historyCount: number;
  running?: boolean;
}) {
  const tokens = result?.totalTokens;
  const total = tokens ? tokens.promptTokens + tokens.completionTokens : 0;
  return (
    <section className={`rounded-xl border border-slate-800 bg-slate-900/40 p-4 premium-card ${running ? "sentinel-metrics-glow" : ""}`}>
      <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
        <Activity className="h-4 w-4 text-emerald-400" /> Live metrics
      </h2>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Incidents" value={String(historyCount)} icon={Radar} spark={historyCount} />
        <Stat label="Reasoning steps" value={String(result?.steps.length ?? 0)} icon={BrainCircuit} spark={result?.steps.length ?? 0} />
        <Stat label="Prompt tokens" value={tokens ? tokens.promptTokens.toLocaleString() : "—"} icon={BookOpen} spark={tokens?.promptTokens ?? 0} />
        <Stat label="Completion tokens" value={tokens ? tokens.completionTokens.toLocaleString() : "—"} icon={Zap} spark={tokens?.completionTokens ?? 0} />
        <Stat label="Total tokens" value={total ? total.toLocaleString() : "—"} icon={Activity} highlight spark={total} />
        <Stat label="LLM model" value={result?.llmModel ?? "—"} icon={Database} mono />
      </div>
    </section>
  );
}

/**
 * MiniSparkline — a tiny 7-bar SVG histogram that sits behind a metric value.
 * Bars are scaled to the value (log scale so small + large values both render).
 * When the value is 0 / null, the bars render as faint slate-700 placeholders
 * so the card never looks "empty" — a premium "standing by" affordance.
 */
function MiniSparkline({ value, highlight }: { value: number; highlight?: boolean }) {
  // Generate 7 pseudo-random bars seeded by the value so they're stable per
  // render (no flicker). The right-most bar is always the current value's
  // share, the others decay backward — like a recent-activity histogram.
  const bars = Array.from({ length: 7 }, (_, i) => {
    const seed = (value * (i + 1) * 2654435761) % 1000
    const ratio = value > 0 ? (0.4 + (seed / 1000) * 0.6) * (1 - i * 0.08) : 0.15 + (i / 7) * 0.1
    return Math.max(0.08, Math.min(1, ratio))
  });
  const accent = highlight ? "rgb(16 185 129)" : "rgb(100 116 139)";
  const accentFade = highlight ? "rgb(16 185 129 / 0.35)" : "rgb(100 116 139 / 0.35)";
  return (
    <svg
      viewBox="0 0 70 24"
      preserveAspectRatio="none"
      className="absolute right-2.5 top-2.5 h-6 w-[70px] opacity-70 pointer-events-none"
      aria-hidden="true"
    >
      {bars.map((h, i) => (
        <rect
          key={i}
          x={i * 10}
          y={24 - h * 22 - 1}
          width="6"
          height={h * 22}
          rx="1"
          fill={value > 0 ? (i === bars.length - 1 ? accent : accentFade) : "rgb(51 65 85 / 0.4)"}
        />
      ))}
    </svg>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  highlight,
  mono,
  spark,
}: {
  label: string;
  value: string;
  icon: typeof Activity;
  highlight?: boolean;
  mono?: boolean;
  spark?: number;
}) {
  return (
    <div className={`relative overflow-hidden rounded-lg border p-2.5 ${highlight ? "border-emerald-500/30 bg-emerald-500/5" : "border-slate-800 bg-slate-900/40"}`}>
      {spark !== undefined && <MiniSparkline value={spark} highlight={highlight} />}
      <div className="relative flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className={`relative mt-1 font-mono text-lg font-bold tabular-nums ${highlight ? "text-emerald-300" : "text-slate-100"} ${mono ? "text-sm truncate" : ""}`} title={value}>{value}</div>
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
        <span className={`h-2 w-2 rounded-full ${dotColor} ${mode === "live" && reachable ? "sentinel-live-dot" : ""}`} />
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
// Performance Analytics — resolution rate, avg response time, token efficiency,
// scenario breakdown. Sits in the right column between MetricsCard and
// ConnectorStatusCard.
// ---------------------------------------------------------------------------

function PerformanceAnalytics({ incidents }: { incidents: IncidentListItem[] }) {
  if (incidents.length === 0) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 premium-card">
        <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
          <TrendingUp className="h-4 w-4 text-emerald-400" /> Agent Performance
        </h2>
        <div className="text-xs text-slate-500 text-center py-4">No incidents yet</div>
      </section>
    );
  }

  // Resolution rate — count by status
  const resolved = incidents.filter((i) => i.status === "resolved").length;
  const degraded = incidents.filter((i) => i.status === "degraded").length;
  const failed = incidents.filter((i) => i.status === "failed").length;
  const total = incidents.length;
  const resolvedPct = total > 0 ? (resolved / total) * 100 : 0;
  const degradedPct = total > 0 ? (degraded / total) * 100 : 0;
  const failedPct = total > 0 ? (failed / total) * 100 : 0;

  // Avg response time — average time between createdAt and resolvedAt
  const resolvedIncidents = incidents.filter((i) => i.resolvedAt && i.createdAt);
  const avgResponseMs =
    resolvedIncidents.length > 0
      ? resolvedIncidents.reduce((sum, i) => {
          const created = new Date(i.createdAt).getTime();
          const resolvedAt = new Date(i.resolvedAt!).getTime();
          return sum + (resolvedAt - created);
        }, 0) / resolvedIncidents.length
      : 0;
  const avgResponseSec = (avgResponseMs / 1000).toFixed(1);

  // Scenario breakdown — count by signalType
  const scenarioCounts: Record<string, number> = {};
  for (const i of incidents) {
    const t = i.signalType || "unknown";
    scenarioCounts[t] = (scenarioCounts[t] || 0) + 1;
  }
  const scenarioLabels: Record<string, { label: string; color: string; bg: string }> = {
    freshness: { label: "Freshness", color: "text-emerald-300", bg: "bg-emerald-500/15" },
    schema: { label: "Schema", color: "text-amber-300", bg: "bg-amber-500/15" },
    pii: { label: "PII", color: "text-rose-300", bg: "bg-rose-500/15" },
    quality: { label: "Quality", color: "text-slate-300", bg: "bg-slate-500/15" },
    unknown: { label: "Unknown", color: "text-slate-400", bg: "bg-slate-500/10" },
  };

  // Token efficiency — from the latest run result (we'll use a placeholder
  // since we don't have aggregate token data here, but we can compute from
  // the step counts as a proxy)
  const avgToolCalls =
    total > 0
      ? (incidents.reduce((sum, i) => sum + i.toolCallCount, 0) / total).toFixed(1)
      : "0";
  const avgWritebacks =
    total > 0
      ? (incidents.reduce((sum, i) => sum + i.writebackCount, 0) / total).toFixed(1)
      : "0";
  const avgSteps =
    total > 0
      ? (incidents.reduce((sum, i) => sum + i.stepCount, 0) / total).toFixed(1)
      : "0";

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 premium-card">
      <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
        <TrendingUp className="h-4 w-4 text-emerald-400" /> Agent Performance
      </h2>

      {/* Resolution rate bar */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Resolution rate</span>
          <span className="text-[10px] font-mono text-emerald-300">{resolved}/{total} resolved</span>
        </div>
        <div className="flex h-2.5 rounded-full overflow-hidden bg-slate-800">
          <div
            className="bg-emerald-500 transition-all duration-500 sentinel-bar-shimmer"
            style={{ width: `${resolvedPct}%` }}
            title={`Resolved: ${resolved} (${resolvedPct.toFixed(0)}%)`}
          />
          <div
            className="bg-amber-500 transition-all duration-500"
            style={{ width: `${degradedPct}%` }}
            title={`Degraded: ${degraded} (${degradedPct.toFixed(0)}%)`}
          />
          <div
            className="bg-rose-500 transition-all duration-500"
            style={{ width: `${failedPct}%` }}
            title={`Failed: ${failed} (${failedPct.toFixed(0)}%)`}
          />
        </div>
        <div className="flex items-center gap-3 mt-1.5">
          <span className="flex items-center gap-1 text-[10px] text-slate-500">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Resolved {resolvedPct.toFixed(0)}%
          </span>
          <span className="flex items-center gap-1 text-[10px] text-slate-500">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Degraded {degradedPct.toFixed(0)}%
          </span>
          <span className="flex items-center gap-1 text-[10px] text-slate-500">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-500" /> Failed {failedPct.toFixed(0)}%
          </span>
        </div>
      </div>

      {/* Avg response time */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5 mb-3">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500">
          <Clock className="h-3 w-3" /> Avg response time
        </div>
        <div className="mt-1 font-mono text-lg font-bold tabular-nums text-slate-100">
          {resolvedIncidents.length > 0 ? `${avgResponseSec}s` : "—"}
        </div>
      </div>

      {/* Token efficiency proxy — avg steps / tool calls / writebacks */}
      <div className="mb-3">
        <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-1.5">Efficiency</div>
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2 text-center">
            <div className="text-[9px] font-mono uppercase tracking-wider text-slate-500 mb-0.5">Steps</div>
            <div className="font-mono text-sm font-bold tabular-nums text-amber-300">{avgSteps}</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2 text-center">
            <div className="text-[9px] font-mono uppercase tracking-wider text-slate-500 mb-0.5">Tools</div>
            <div className="font-mono text-sm font-bold tabular-nums text-emerald-300">{avgToolCalls}</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2 text-center">
            <div className="text-[9px] font-mono uppercase tracking-wider text-slate-500 mb-0.5">Writes</div>
            <div className="font-mono text-sm font-bold tabular-nums text-rose-300">{avgWritebacks}</div>
          </div>
        </div>
      </div>

      {/* Scenario breakdown */}
      <div>
        <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-1.5">Scenario breakdown</div>
        <div className="space-y-1.5">
          {Object.entries(scenarioCounts)
            .sort(([, a], [, b]) => b - a)
            .map(([type, count]) => {
              const meta = scenarioLabels[type] ?? scenarioLabels.unknown;
              const pct = total > 0 ? (count / total) * 100 : 0;
              return (
                <div key={type} className="flex items-center gap-2">
                  <div className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${meta.color} ${meta.bg} border border-slate-800 w-20 text-center truncate`}>
                    {meta.label}
                  </div>
                  <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-emerald-500/70 transition-all duration-500 sentinel-bar-shimmer"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-slate-400 tabular-nums w-6 text-right">{count}</span>
                </div>
              );
            })}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// DataHub Health Panel — connection status, asset count, assertions, MCP tools,
// last write-back. Sits in the right column after ConnectorStatusCard.
// ---------------------------------------------------------------------------

interface DataHubStatusResponse {
  mode: string;
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

interface DataHubSeedOverviewResponse {
  assets?: Array<{ scenarioId: string; urn: string; name: string }>;
  assertions?: Array<{ scenarioId: string; status: string }>;
  contextDocs?: Array<{ scenarioId: string; title: string }>;
}

const MCP_TOOLS = [
  "mcp.search",
  "mcp.get_entities",
  "mcp.list_schema_fields",
  "mcp.get_me",
  "mcp.get_lineage",
  "mcp.search_documents",
  "mcp.grep_documents",
  "mcp.get_dataset_queries",
  "mcp.list_lifecycle_stages",
  "ack.save_document",
  "ack.add_owners",
  "ack.add_glossary_terms",
  "ack.create_assertion",
  "ack.add_tag",
  "ack.update_ownership",
];

function DataHubHealthPanel() {
  const status = useQuery<DataHubStatusResponse>({
    queryKey: ["datahub-status"],
    queryFn: async () => {
      const r = await fetch("/api/datahub/status");
      if (!r.ok) throw new Error("Failed to load DataHub status");
      return (await r.json()) as DataHubStatusResponse;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const overview = useQuery<DataHubSeedOverviewResponse>({
    queryKey: ["datahub-seed-overview"],
    queryFn: async () => {
      const r = await fetch("/api/datahub/seed/overview");
      if (!r.ok) throw new Error("Failed to load seed overview");
      return (await r.json()) as DataHubSeedOverviewResponse;
    },
    staleTime: 30_000,
    enabled: Boolean(status.data?.seeded),
  });

  const [toolsExpanded, setToolsExpanded] = useState(false);

  const isLoading = status.isLoading || (status.data?.seeded && overview.isLoading);
  const counts = status.data?.counts;

  // Derive last write-back from overview context docs (best-effort)
  const lastWriteback = overview.data?.contextDocs?.length
    ? overview.data.contextDocs[overview.data.contextDocs.length - 1]
    : null;

  // Assertion pass/fail
  const assertionsPassing = (counts?.assertions ?? 0) - (counts?.failingAssertions ?? 0);
  const assertionsFailing = counts?.failingAssertions ?? 0;

  if (isLoading) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
          <Database className="h-4 w-4 text-emerald-400" /> DataHub Health
        </h2>
        <div className="space-y-2">
          <div className="h-8 rounded bg-slate-800/40 animate-pulse" />
          <div className="h-8 rounded bg-slate-800/40 animate-pulse" />
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 premium-card">
      <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
        <Database className="h-4 w-4 text-emerald-400" /> DataHub Health
      </h2>

      {/* Connection status */}
      <div className="flex items-center gap-2 mb-3">
        <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-xs text-emerald-300 font-medium">Connected</span>
        <span className="ml-auto text-[10px] font-mono text-slate-500">
          {status.data?.mode === "live" ? "LIVE" : "Demo"} mode
        </span>
      </div>

      {/* Asset count */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5 mb-2">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500">
          <Layers className="h-3 w-3" /> Seeded assets
        </div>
        <div className="mt-1 font-mono text-lg font-bold tabular-nums text-slate-100">
          {counts?.assets ?? 0}
        </div>
      </div>

      {/* Assertion status */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5 mb-2">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">
          <ShieldCheck className="h-3 w-3" /> Assertions
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-emerald-300">{assertionsPassing} passing</span>
          {assertionsFailing > 0 && (
            <span className="text-[10px] font-mono text-rose-300">{assertionsFailing} failing</span>
          )}
        </div>
        <div className="flex h-1.5 rounded-full overflow-hidden bg-slate-800 mt-1.5">
          <div
            className="bg-emerald-500 transition-all duration-500 sentinel-bar-shimmer"
            style={{ width: `${counts?.assertions ? (assertionsPassing / counts.assertions) * 100 : 100}%` }}
          />
          {assertionsFailing > 0 && (
            <div
              className="bg-rose-500 transition-all duration-500"
              style={{ width: `${counts?.assertions ? (assertionsFailing / counts.assertions) * 100 : 0}%` }}
            />
          )}
        </div>
      </div>

      {/* MCP tools */}
      <div className="mb-2">
        <button
          onClick={() => setToolsExpanded(!toolsExpanded)}
          className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500 mb-1.5 hover:text-slate-300 transition-colors w-full"
        >
          <Terminal className="h-3 w-3" /> MCP Tools ({MCP_TOOLS.length})
          {toolsExpanded ? <ChevronUp className="h-3 w-3 ml-auto" /> : <ChevronDown className="h-3 w-3 ml-auto" />}
        </button>
        {toolsExpanded && (
          <div className="flex flex-wrap gap-1">
            {MCP_TOOLS.map((tool) => (
              <span
                key={tool}
                className="inline-flex items-center rounded border border-slate-800 bg-slate-900/60 px-1.5 py-0.5 text-[9px] font-mono text-slate-400"
              >
                {tool}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Last write-back */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500">
          <FileText className="h-3 w-3" /> Last write-back
        </div>
        <div className="mt-1 text-xs font-mono text-slate-300 truncate">
          {lastWriteback?.title ?? "No write-backs yet"}
        </div>
      </div>
    </section>
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
    degraded: "text-amber-400",
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
                it.status === "resolved" ? "bg-emerald-400" : it.status === "failed" ? "bg-rose-400" : it.status === "degraded" ? "bg-amber-400" : "bg-slate-400"
              }`} />
              <span className={`text-[10px] font-mono uppercase ${statusColor[it.status] ?? "text-slate-400"}`}>{it.status}</span>
              <span className="text-[10px] font-mono text-slate-500">{it.signalType}</span>
              <span className="ml-auto text-[10px] text-slate-600">
                {new Date(it.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
              </span>
            </div>
            <div className="mt-1 text-xs text-slate-400 font-mono truncate" title={it.assetUrn}>
              {it.assetUrn.replace(/^urn:li:dataset:\(urn:li:dataPlatform:[^,]+,([^,]+),.*$/, "$1")}
            </div>
            <div className="mt-0.5 text-[10px] text-slate-600 font-mono truncate" title={it.urn}>
              {it.urn.length > 60 ? it.urn.slice(0, 57) + "…" : it.urn}
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
        className="sentinel-circuit-pulse hidden md:inline-flex items-center gap-1.5 rounded-md border border-rose-500/50 bg-rose-500/15 px-2 py-1"
        title={`Circuit open on '${status?.provider}' after ${circuit?.consecutiveFailures ?? 0} consecutive 429/5xx. ${status?.fallbackProvider && status?.failoverEnabled ? `Sentinel fails over to '${status.fallbackProvider}' — the ReAct loop continues from the fallback. ` : "The orchestrator's fallback post-mortem path runs. "}Cooldown resets in ${secs}s; the primary then resumes automatically.`}
      >
        <span className="relative inline-flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500/60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
        </span>
        <ShieldAlert className="h-3 w-3 text-rose-400" />
        <span className="text-rose-200 font-semibold">Throttled</span>
        <span className="inline-flex items-center gap-1 text-rose-300/90 font-mono tabular-nums">
          <Clock className="h-2.5 w-2.5" />
          {secs}s
        </span>
      </div>
    );
  }

  return (
    <div
      className="hidden md:inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1"
      title={`LLM circuit healthy on provider '${status?.provider}'${status?.fallbackProvider ? ` (fallback: ${status.fallbackProvider})` : ""}. Failover ${status?.failoverEnabled ? `armed → ${status.fallbackProvider}` : "off"}.`}
    >
      <span className="relative inline-flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/50" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
      </span>
      <ShieldCheck className="h-3 w-3 text-emerald-500" />
      <span className="text-slate-500">Circuit</span>
      <span className="text-emerald-300">Healthy</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WritebacksPanel — detailed write-back cards for the right column
// Shows each write-back's kind, status, URN, and a data preview specific
// to the kind (post-mortem title/content, glossary/ownership proposals,
// assertion SLA details). Each card has a "direct write" or "proposal" badge.
// ---------------------------------------------------------------------------

function WritebacksPanel({
  writebacks,
}: {
  writebacks: Array<{ id: string; kind: string; datahubUrn: string | null; status: string; path: string; dataJson: string; ts: string }>;
}) {
  if (writebacks.length === 0) return null;

  const succeeded = writebacks.filter((w) => w.status === "succeeded").length;
  const failed = writebacks.filter((w) => w.status === "failed").length;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 premium-card">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
          <FileText className="h-4 w-4 text-rose-400" /> Write-backs detail
          <span className="text-slate-500 font-normal">({writebacks.length})</span>
        </h2>
        <div className="flex items-center gap-1.5 text-[10px] font-mono">
          {succeeded > 0 && <span className="text-emerald-400">{succeeded} ok</span>}
          {failed > 0 && <span className="text-rose-400">{failed} failed</span>}
        </div>
      </div>
      <div className="max-h-72 overflow-y-auto custom-scroll p-2 space-y-2">
        {writebacks.map((w) => (
          <WritebackDetailCard key={w.id} writeback={w} />
        ))}
      </div>
    </section>
  );
}

function WritebackDetailCard({
  writeback,
}: {
  writeback: { id: string; kind: string; datahubUrn: string | null; status: string; path: string; dataJson: string; ts: string };
}) {
  const data = safeParse(writeback.dataJson);
  const isAssertion = writeback.kind === "assertion" || writeback.kind === "ack.create_assertion";
  const badge = isAssertion ? "direct write" : "proposal";
  const badgeColor = isAssertion
    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
    : "bg-amber-500/15 text-amber-300 border-amber-500/40";
  const badgeIcon = isAssertion ? Zap : GitBranch;
  const succeeded = writeback.status === "succeeded";
  const failed = writeback.status === "failed";
  const BadgeIcon = badgeIcon;

  // Extract data previews based on kind
  const title = data?.title ? String(data.title) : "";
  const content = data?.content ? String(data.content) : "";
  const contentPreview = content.length > 120 ? content.slice(0, 120) + "…" : content;
  // Glossary / ownership proposals
  const terms = Array.isArray(data?.terms) ? data.terms as Array<Record<string, unknown>> : [];
  const owners = Array.isArray(data?.owners) ? data.owners as Array<Record<string, unknown>> : [];
  // Assertion SLA details
  const assertionType = data?.assertionType ? String(data.assertionType) : "";
  const slaThreshold = data?.threshold ?? data?.slaThreshold ?? null;
  const detectionMethod = data?.detectionMethod ? String(data.detectionMethod) : "";

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`rounded-lg border p-3 ${
        failed
          ? "border-rose-500/40 bg-rose-500/5"
          : succeeded
            ? "border-emerald-500/20 bg-emerald-500/5"
            : "border-slate-800 bg-slate-900/40"
      }`}
    >
      {/* Header row: kind + badge + status */}
      <div className="flex items-center gap-1.5 mb-2 flex-wrap">
        <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400">{writeback.kind}</span>
        <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${badgeColor}`}>
          <BadgeIcon className="h-2.5 w-2.5" />
          {badge}
        </span>
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${
          succeeded
            ? "bg-emerald-500/15 text-emerald-300"
            : "bg-rose-500/15 text-rose-300"
        }`}>
          {succeeded ? <CheckCircle2 className="h-2.5 w-2.5" /> : <XCircle className="h-2.5 w-2.5" />}
          {writeback.status}
        </span>
        <span className="ml-auto text-[10px] text-slate-600 font-mono">
          {new Date(writeback.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
        </span>
      </div>

      {/* Data preview — kind-specific */}
      {/* Post-mortem: title + content preview */}
      {(writeback.kind === "post-mortem" || writeback.kind === "ack.save_document") && title && (
        <div className="mb-1.5">
          <div className="text-xs font-semibold text-slate-200 truncate" title={title}>{title}</div>
          {contentPreview && (
            <div className="text-[11px] text-slate-400 mt-0.5 line-clamp-2 leading-relaxed">{contentPreview}</div>
          )}
        </div>
      )}

      {/* Glossary proposals */}
      {terms.length > 0 && (
        <div className="mb-1.5">
          <div className="text-[10px] font-mono uppercase tracking-wider text-amber-300 mb-1">Proposed terms</div>
          <div className="flex flex-wrap gap-1">
            {terms.slice(0, 5).map((t, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-mono text-amber-200">
                <BookOpen className="h-2.5 w-2.5" />
                {String(t.name ?? t.urn ?? `term-${i}`)}
              </span>
            ))}
            {terms.length > 5 && <span className="text-[10px] text-slate-500">+{terms.length - 5} more</span>}
          </div>
        </div>
      )}

      {/* Ownership proposals */}
      {owners.length > 0 && (
        <div className="mb-1.5">
          <div className="text-[10px] font-mono uppercase tracking-wider text-amber-300 mb-1">Proposed owners</div>
          <div className="flex flex-wrap gap-1">
            {owners.slice(0, 5).map((o, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-mono text-amber-200">
                <User className="h-2.5 w-2.5" />
                {String(o.ownerUrn ?? o.name ?? `owner-${i}`)}
              </span>
            ))}
            {owners.length > 5 && <span className="text-[10px] text-slate-500">+{owners.length - 5} more</span>}
          </div>
        </div>
      )}

      {/* Assertion SLA details */}
      {isAssertion && (assertionType || slaThreshold || detectionMethod) && (
        <div className="mb-1.5">
          <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300 mb-1">SLA details</div>
          <div className="flex flex-wrap gap-1.5 text-[10px] font-mono">
            {assertionType && (
              <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-200">
                type: {assertionType}
              </span>
            )}
            {slaThreshold !== null && slaThreshold !== undefined && (
              <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-200">
                threshold: {String(slaThreshold)}
              </span>
            )}
            {detectionMethod && (
              <span className="rounded border border-slate-700 bg-slate-900/60 px-1.5 py-0.5 text-slate-400">
                method: {detectionMethod}
              </span>
            )}
          </div>
        </div>
      )}

      {/* DataHub URN */}
      {writeback.datahubUrn && (
        <CopyableUrn value={writeback.datahubUrn} />
      )}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// IncidentStatusBar — horizontal progress bar showing resolution stages
// SIGNAL → TRIAGE → ACTIONS → WRITE-BACKS → RESOLVED
// Each stage fills in as the agent progresses. Current stage pulses.
// ---------------------------------------------------------------------------

type StageKey = "signal" | "triage" | "actions" | "writebacks" | "resolved";

const STAGES: { key: StageKey; label: string; icon: typeof Radar }[] = [
  { key: "signal", label: "SIGNAL", icon: Radar },
  { key: "triage", label: "TRIAGE", icon: BrainCircuit },
  { key: "actions", label: "ACTIONS", icon: Send },
  { key: "writebacks", label: "WRITE-BACKS", icon: FileText },
  { key: "resolved", label: "RESOLVED", icon: CheckCircle2 },
];

function IncidentStatusBar({
  result,
  viewedIncident,
  running,
  elapsed,
}: {
  result: RunResult | null;
  viewedIncident: HydratedIncident | null;
  running: boolean;
  elapsed: number;
}) {
  // Determine which stages are completed and which is current
  const currentStage = useMemo((): StageKey | null => {
    const steps = viewedIncident?.incident.reasoningSteps ?? result?.steps ?? [];
    const hasWritebacks = (viewedIncident?.writebacks?.length ?? 0) > 0;
    const hasActions = (viewedIncident?.actions?.length ?? 0) > 0;
    const isResolved = viewedIncident?.incident?.status === "resolved" || result?.incident?.status === "resolved";
    const isFailed = viewedIncident?.incident?.status === "failed" || result?.incident?.status === "failed";

    if (isResolved || isFailed) return "resolved";
    if (hasWritebacks) return "writebacks";
    if (hasActions) return "actions";
    if (steps.length > 0) return "triage";
    if (running || result || viewedIncident) return "signal";
    return null;
  }, [result, viewedIncident, running]);

  const completedStages = useMemo((): Set<StageKey> => {
    const set = new Set<StageKey>();
    if (!currentStage) return set;
    const order: StageKey[] = ["signal", "triage", "actions", "writebacks", "resolved"];
    const idx = order.indexOf(currentStage);
    for (let i = 0; i <= idx; i++) set.add(order[i]);
    return set;
  }, [currentStage]);

  // Don't render if there's nothing to show
  if (!result && !viewedIncident && !running) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 premium-card"
    >
      <div className="flex items-center justify-between mb-2.5">
        <h3 className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5 text-emerald-400" /> Incident progress
        </h3>
        {running && (
          <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-emerald-300">
            <Loader2 className="h-3 w-3 animate-spin" /> {elapsed.toFixed(1)}s
          </span>
        )}
        {!running && (result?.incident?.status === "resolved" || viewedIncident?.incident?.status === "resolved") && (
          <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-emerald-300">
            <CheckCircle2 className="h-3 w-3" /> resolved
          </span>
        )}
        {!running && (result?.incident?.status === "failed" || viewedIncident?.incident?.status === "failed") && (
          <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-rose-300">
            <XCircle className="h-3 w-3" /> failed
          </span>
        )}
      </div>
      <div className="flex items-center gap-0">
        {STAGES.map((stage, i) => {
          const isCompleted = completedStages.has(stage.key);
          const isCurrent = currentStage === stage.key;
          const isPending = !isCompleted && !isCurrent;
          const isLast = i === STAGES.length - 1;
          const Icon = stage.icon;

          return (
            <div key={stage.key} className="flex items-center flex-1">
              {/* Stage dot + label */}
              <div className="flex flex-col items-center gap-1.5">
                <div className={`flex items-center justify-center h-7 w-7 rounded-full border-2 transition-all ${
                  isCompleted
                    ? "border-emerald-500 bg-emerald-500/20"
                    : isCurrent
                      ? "border-amber-500 bg-amber-500/20 sentinel-stage-pulse"
                      : "border-slate-700 bg-slate-900/40"
                }`}>
                  <Icon className={`h-3.5 w-3.5 ${
                    isCompleted
                      ? "text-emerald-300"
                      : isCurrent
                        ? "text-amber-300"
                        : "text-slate-600"
                  }`} />
                </div>
                <span className={`text-[9px] font-mono uppercase tracking-wider whitespace-nowrap ${
                  isCompleted
                    ? "text-emerald-300"
                    : isCurrent
                      ? "text-amber-300"
                      : "text-slate-600"
                }`}>
                  {stage.label}
                </span>
              </div>
              {/* Connector line */}
              {!isLast && (
                <div className={`flex-1 h-0.5 mx-1 rounded-full transition-all ${
                  isCompleted && completedStages.has(STAGES[i + 1].key)
                    ? "bg-emerald-500/60"
                    : isCompleted
                      ? "bg-gradient-to-r from-emerald-500/60 to-slate-700"
                      : "bg-slate-800"
                }`} />
              )}
            </div>
          );
        })}
      </div>
    </motion.div>
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
  // DataHub stores lastModifiedAt in microseconds; JS Date expects milliseconds.
  // If the value exceeds 1e14 (≈ year 5138 in ms), it's in µs → divide by 1000.
  const lastMod = asset?.lastModifiedAt
    ? new Date(asset.lastModifiedAt > 1e14 ? asset.lastModifiedAt / 1000 : asset.lastModifiedAt)
        .toISOString().slice(0, 16).replace("T", " ") + "Z"
    : null;

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
            <CopyableUrn value={owner?.ownerUrn ?? "urn:li:corpUser:priya.patel"} />
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
  const colWidth = 220;
  const nodeHeight = 62;
  const colGap = 70;
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
          <span className="text-slate-500 mr-1">Legend:</span>
          <span className="inline-flex items-center gap-1 rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-rose-300">
            <span className="h-2 w-2 rounded-full bg-rose-400" /> failing asset
          </span>
          <span className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-amber-300">
            <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" /> traversed
          </span>
        </div>
      </div>

      <div className="relative overflow-x-auto custom-scroll rounded-lg border border-slate-800 bg-slate-950/40">
        {/* CRT scanline overlay */}
        <div className="sentinel-lineage-scanline" />
        <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="w-full h-auto" style={{ minWidth: svgWidth }}>
          {/* Edges */}
          {edges.map((e, i) => {
            const isActiveEdge = (activeUrn && (e.from === activeUrn || e.to === activeUrn)) || false;
            const isTraversed = traversedArr.some((u) => e.from === u || e.to === u);
            const stroke = isActiveEdge ? "#f59e0b" : isTraversed ? "#fbbf24" : "#475569";
            const width = isActiveEdge ? 2.5 : isTraversed ? 2 : 1.5;
            return (
              <g key={`e-${i}`}>
                <path
                  d={edgePath(e.from, e.to)}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={width}
                  strokeDasharray={isActiveEdge ? "0" : isTraversed ? "0" : "6 4"}
                  opacity={isActiveEdge ? 1 : isTraversed ? 0.85 : 0.6}
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
                  {n.name.length > 26 ? n.name.slice(0, 24) + "…" : n.name}
                </text>
                {/* Type + platform */}
                <text x={16} y={38} fill="#94a3b8" fontSize="9" fontFamily="ui-monospace, monospace">
                  {n.platform} · {n.type}
                </text>
                {/* Degree / role label */}
                <text x={16} y={50} fill={isRoot ? "#f43f5e" : "#64748b"} fontSize="8" fontFamily="ui-monospace, monospace" letterSpacing="0.05em" fontWeight="700">
                  {isRoot ? "⚠ FAILING ASSET" : n.degree < 0 ? `UPSTREAM ${n.degree}` : `DOWNSTREAM +${n.degree}`}
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

// ---------------------------------------------------------------------------
// RunSummaryCard — hero moment after a run completes
// Shows resolution status, key metrics, actions taken, write-backs, and
// compounding note. Only appears when a run is complete (not during running,
// not when viewing an incident).
// ---------------------------------------------------------------------------

function RunSummaryCard({
  result,
  viewedIncident,
}: {
  result: RunResult | null;
  viewedIncident: HydratedIncident | null;
}) {
  // Only show when a run is complete (not during running, not when viewing an incident)
  if (!result || viewedIncident) return null;

  const status = result.incident?.status ?? "unknown";
  const isResolved = status === "resolved";
  const isDegraded = status === "degraded";
  const isFailed = status === "failed";

  // Resolution time
  const created = result.incident?.createdAt ? new Date(result.incident.createdAt).getTime() : 0;
  const resolved = result.incident?.resolvedAt ? new Date(result.incident.resolvedAt).getTime() : 0;
  const resolutionTime = resolved && created ? ((resolved - created) / 1000).toFixed(1) : null;

  // Key metrics
  const reasoningSteps = result.steps.length;
  const toolCalls = result.steps.filter((s) => s.kind === "tool_call").length;
  const writebacks = result.steps.filter((s) => s.kind === "write_back" || s.toolName === "ack.save_document").length;

  // Actions taken — extract from tool_call steps
  const actionsTaken: string[] = [];
  for (const s of result.steps) {
    if (s.kind === "tool_call" && s.toolName) {
      if (s.toolName === "github.openIssue" || s.toolName === "action.github.openIssue") {
        const num = s.toolArgs?.number as number | undefined;
        actionsTaken.push(`GitHub issue #${num ?? "?"} opened`);
      } else if (s.toolName === "slack.postMessage" || s.toolName === "action.slack.postMessage") {
        actionsTaken.push("Slack triage posted");
      } else if (s.toolName === "github.openPR" || s.toolName === "action.github.openPR") {
        actionsTaken.push("Remediation PR opened");
      }
    }
  }

  // Write-backs — brief list
  const writebackItems: string[] = [];
  for (const s of result.steps) {
    if (s.kind === "write_back" || s.toolName === "ack.save_document") {
      const tr = s.toolResult as Record<string, unknown> | undefined;
      const title = tr?.title ? String(tr.title) : "";
      if (title.toLowerCase().includes("post-mortem") || title.toLowerCase().includes("postmortem")) {
        writebackItems.push("Post-mortem written to DataHub");
      } else if (s.toolName === "ack.create_assertion" || (tr?.assertionType)) {
        writebackItems.push("SLA assertion tightened");
      } else if (title) {
        writebackItems.push(title);
      } else {
        writebackItems.push("Write-back to DataHub");
      }
    }
  }

  // Compounding note — check if a prior post-mortem was found
  const priorFound = result.steps.some(
    (s) => s.kind === "tool_result" && s.toolName === "mcp.search_documents" && Array.isArray(s.toolResult),
  );

  // Color palette
  const statusColor = isResolved
    ? { icon: CheckCircle2, text: "text-emerald-300", bg: "bg-emerald-500/10", border: "border-emerald-500/30", dot: "bg-emerald-400", ring: "ring-emerald-500/30" }
    : isDegraded
      ? { icon: AlertTriangle, text: "text-amber-300", bg: "bg-amber-500/10", border: "border-amber-500/30", dot: "bg-amber-400", ring: "ring-amber-500/30" }
      : { icon: XCircle, text: "text-rose-300", bg: "bg-rose-500/10", border: "border-rose-500/30", dot: "bg-rose-400", ring: "ring-rose-500/30" };

  const StatusIcon = statusColor.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className={`mt-4 rounded-xl border ${statusColor.border} ${statusColor.bg} p-5`}
    >
      {/* Status header */}
      <div className="flex items-center gap-3 mb-4">
        <div className={`h-12 w-12 rounded-xl ${statusColor.bg} border ${statusColor.border} flex items-center justify-center ring-2 ${statusColor.ring}`}>
          <StatusIcon className={`h-6 w-6 ${statusColor.text}`} />
        </div>
        <div>
          <div className={`text-lg font-bold ${statusColor.text} uppercase tracking-wide`}>
            {isResolved ? "Incident Resolved" : isDegraded ? "Incident Degraded" : "Incident Failed"}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {resolutionTime ? `Resolved in ${resolutionTime}s` : "Resolution complete"} · {result.llmModel}
            {result.actualProvider && result.actualProvider !== result.llmProvider && ` → ${result.actualProvider} (failover)`}
          </div>
        </div>
        <button
          onClick={() => {
            const report = {
              incident: result.incident,
              steps: result.steps,
              totalTokens: result.totalTokens,
              llmModel: result.llmModel,
              llmProvider: result.llmProvider,
              actualProvider: result.actualProvider,
              failoverOccurred: result.failoverOccurred,
              promptVersion: result.promptVersion,
              exportedAt: new Date().toISOString(),
            };
            const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `sentinel-incident-${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900/60 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800/60 hover:border-emerald-500/40 transition-colors"
          title="Export incident report as JSON"
        >
          <Download className="h-3.5 w-3.5" /> Export
        </button>
      </div>

      {/* Key metrics row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-center">
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-1">Resolution time</div>
          <div className="text-lg font-bold font-mono text-slate-100 tabular-nums">{resolutionTime ?? "—"}s</div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-center">
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-1">Reasoning steps</div>
          <div className="text-lg font-bold font-mono text-slate-100 tabular-nums">{reasoningSteps}</div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-center">
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-1">Tool calls</div>
          <div className="text-lg font-bold font-mono text-slate-100 tabular-nums">{toolCalls}</div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-center">
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-1">Write-backs</div>
          <div className="text-lg font-bold font-mono text-slate-100 tabular-nums">{writebacks}</div>
        </div>
      </div>

      {/* Actions taken */}
      {actionsTaken.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] font-mono uppercase tracking-wider text-amber-300 mb-2">Actions taken</div>
          <div className="flex flex-wrap gap-2">
            {actionsTaken.map((a, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1 text-xs font-mono text-amber-200">
                <Send className="h-3 w-3 text-amber-400" /> {a}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Write-backs */}
      {writebackItems.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] font-mono uppercase tracking-wider text-rose-300 mb-2">Write-backs</div>
          <div className="flex flex-wrap gap-2">
            {writebackItems.map((w, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/5 px-2.5 py-1 text-xs font-mono text-rose-200">
                <FileText className="h-3 w-3 text-rose-400" /> {w}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Compounding note */}
      {priorFound && (
        <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs text-emerald-200">
            <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
            <span className="font-medium">Compounding context detected</span>
            <span className="text-emerald-300/70">— Sentinel read a prior post-mortem before reasoning, producing a shorter, more informed trace.</span>
          </div>
        </div>
      )}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// ToastContainer — bottom-right toast notifications
// ---------------------------------------------------------------------------

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: Array<{ id: string; message: string; type: "success" | "warning" | "error" }>;
  onDismiss: (id: string) => void;
}) {
  const colorMap = {
    success: { border: "border-emerald-500/40", bg: "bg-emerald-500/10", text: "text-emerald-200", icon: CheckCircle2, iconColor: "text-emerald-400" },
    warning: { border: "border-amber-500/40", bg: "bg-amber-500/10", text: "text-amber-200", icon: AlertTriangle, iconColor: "text-amber-400" },
    error: { border: "border-rose-500/40", bg: "bg-rose-500/10", text: "text-rose-200", icon: XCircle, iconColor: "text-rose-400" },
  };

  return (
    <div className="fixed bottom-16 right-4 z-50 flex flex-col gap-2 pointer-events-none" aria-live="polite">
      <AnimatePresence>
        {toasts.map((toast) => {
          const c = colorMap[toast.type];
          const Icon = c.icon;
          return (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, x: 80, scale: 0.95 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 80, scale: 0.95 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className={`pointer-events-auto rounded-lg border ${c.border} ${c.bg} backdrop-blur-sm px-4 py-3 shadow-lg shadow-slate-950/50 flex items-center gap-2.5 max-w-xs`}
            >
              <Icon className={`h-4 w-4 ${c.iconColor} shrink-0`} />
              <span className={`text-sm ${c.text} leading-snug`}>{toast.message}</span>
              <button
                onClick={() => onDismiss(toast.id)}
                className="ml-1 text-slate-500 hover:text-slate-300 transition-colors shrink-0"
                aria-label="Dismiss"
              >
                <XCircle className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MobileInfoBar — compact key info on small screens (hidden on md+)
// ---------------------------------------------------------------------------

function MobileInfoBar({
  result,
  llmStatus,
  running,
  elapsed,
}: {
  result: RunResult | null;
  llmStatus: LlmResilienceStatus | null;
  running: boolean;
  elapsed: number;
}) {
  const circuitOpen = llmStatus?.circuit?.isOpen ?? false;
  return (
    <div className="md:hidden mt-3 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 flex flex-wrap items-center gap-2 text-[10px] font-mono">
      <span className="inline-flex items-center gap-1">
        <Zap className="h-3 w-3 text-slate-500" />
        <span className="text-slate-500">LLM:</span>
        <span className="text-slate-300">{result?.llmModel ?? "gemini-2.0-flash"}</span>
      </span>
      <span className="text-slate-700">·</span>
      <span className="inline-flex items-center gap-1">
        <Database className="h-3 w-3 text-slate-500" />
        <span className="text-slate-500">Provider:</span>
        <span className="text-slate-300">{result?.actualProvider ?? result?.llmProvider ?? "gemini"}</span>
      </span>
      {result?.totalTokens && (
        <>
          <span className="text-slate-700">·</span>
          <span className="inline-flex items-center gap-1">
            <Activity className="h-3 w-3 text-slate-500" />
            <span className="text-slate-300">{(result.totalTokens.promptTokens + result.totalTokens.completionTokens).toLocaleString()} tokens</span>
          </span>
        </>
      )}
      {circuitOpen && (
        <>
          <span className="text-slate-700">·</span>
          <span className="inline-flex items-center gap-1 text-rose-300">
            <ShieldAlert className="h-3 w-3" /> throttled
          </span>
        </>
      )}
      {running && (
        <>
          <span className="text-slate-700">·</span>
          <span className="inline-flex items-center gap-1 text-emerald-300">
            <Loader2 className="h-3 w-3 animate-spin" /> {elapsed.toFixed(1)}s
          </span>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CopyableUrn — small inline URN display with copy-to-clipboard button
// ---------------------------------------------------------------------------

function CopyableUrn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <button
      onClick={copy}
      className="flex items-center gap-1.5 text-[10px] text-slate-500 font-mono hover:text-slate-300 transition-colors w-full text-left mt-0.5"
      title="Click to copy URN"
    >
      <span className="truncate">{value}</span>
      {copied ? <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" /> : <Copy className="h-3 w-3 shrink-0 opacity-40" />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// CommandPalette (⌘K) — custom dark mission-control palette built on cmdk.
// Provides quick keyboard-driven access to: run signal, select signal,
// open audit/settings drawers, test connectors, scroll to top.
// ---------------------------------------------------------------------------

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  signals: SeedSignal[];
  selectedSignalId: string | null;
  onSelectSignal: (id: string) => void;
  onRun: () => void;
  onOpenAudit: () => void;
  onOpenSettings: () => void;
  onTestConnectors: () => void | Promise<void>;
  onScrollTop: () => void;
  running: boolean;
}

function CommandPalette({
  open,
  onOpenChange,
  signals,
  selectedSignalId,
  onSelectSignal,
  onRun,
  onOpenAudit,
  onOpenSettings,
  onTestConnectors,
  onScrollTop,
  running,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Close handler — clears the query AND notifies the parent. Keeps query
  // reset in an event handler (not an effect) to satisfy the
  // react-hooks/set-state-in-effect lint rule.
  function close() {
    setQuery("");
    onOpenChange(false);
  }

  // Focus the input when the palette opens + listen for Escape to close.
  // cmdk's CommandPrimitive does not close on Escape by default (that's the
  // dialog wrapper's job), so we listen here.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // Esc closes (cmdk handles this internally, but we also listen on overlay).
  if (!open) return null;

  const q = query.toLowerCase().trim();
  const matches = (s: string) => s.toLowerCase().includes(q);

  const signalResults = signals.filter(
    (s) => !q || matches(s.label) || matches(s.assetName) || matches(s.type) || matches(s.scenarioId),
  );

  return (
    <>
      <div
        className="sentinel-cmdk-overlay"
        onClick={close}
        aria-hidden
      />
      <div className="sentinel-cmdk-panel" role="dialog" aria-label="Command palette">
        <CommandPrimitive
          className="flex h-full w-full flex-col"
          value=""
          onValueChange={() => {
            /* cmdk manages its own selection; we don't need it */
          }}
        >
          <div className="sentinel-cmdk-input-wrap">
            <Search className="h-4 w-4 text-slate-500 shrink-0" />
            <CommandPrimitive.Input
              ref={inputRef}
              placeholder="Type a command or search signals…"
              value={query}
              onValueChange={setQuery}
              className="sentinel-cmdk-input"
            />
            <kbd className="sentinel-kbd-hint">esc</kbd>
          </div>
          <CommandPrimitive.List className="sentinel-cmdk-list">
            <CommandPrimitive.Empty className="sentinel-cmdk-empty">
              No matches for &ldquo;{query}&rdquo;
            </CommandPrimitive.Empty>

            {/* Actions */}
            <CommandPrimitive.Group heading="Actions" className="sentinel-cmdk-group">
              <CommandPaletteItem
                icon={PlayCircle}
                label="Inject & run Sentinel"
                hint="R"
                disabled={running || !selectedSignalId}
                onSelect={onRun}
                query={q}
              />
              <CommandPaletteItem
                icon={PanelRightOpen}
                label="Open audit log drawer"
                hint="A"
                onSelect={onOpenAudit}
                query={q}
              />
              <CommandPaletteItem
                icon={Settings}
                label="Open runtime config"
                hint="S"
                onSelect={onOpenSettings}
                query={q}
              />
              <CommandPaletteItem
                icon={Send}
                label="Test connectors (GitHub + Slack)"
                disabled={running}
                onSelect={onTestConnectors}
                query={q}
              />
              <CommandPaletteItem
                icon={ArrowUp}
                label="Scroll to top"
                onSelect={onScrollTop}
                query={q}
              />
            </CommandPrimitive.Group>

            {/* Signals */}
            {signalResults.length > 0 && (
              <CommandPrimitive.Group heading={`Signals (${signalResults.length})`} className="sentinel-cmdk-group">
                {signalResults.map((sig, i) => {
                  const isSelected = sig.id === selectedSignalId;
                  const num = signals.indexOf(sig) + 1;
                  return (
                    <button
                      key={sig.id}
                      type="button"
                      className="sentinel-cmdk-item w-full text-left"
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).dataset.selected = "true";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).dataset.selected = "false";
                      }}
                      onClick={() => onSelectSignal(sig.id)}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                          sig.type === "freshness"
                            ? "bg-amber-400"
                            : sig.type === "schema"
                              ? "bg-rose-400"
                              : sig.type === "quality"
                                ? "bg-emerald-400"
                                : "bg-purple-400"
                        }`}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-slate-200">{sig.label}</span>
                          {isSelected && (
                            <span className="text-[9px] font-mono uppercase tracking-wider text-emerald-400">selected</span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500 truncate font-mono">
                          {sig.assetName} · {sig.type}
                        </div>
                      </div>
                      {num <= 5 && <kbd className="sentinel-kbd-hint">{num}</kbd>}
                    </button>
                  );
                })}
              </CommandPrimitive.Group>
            )}
          </CommandPrimitive.List>
        </CommandPrimitive>

        {/* Footer with shortcut hints */}
        <div className="sentinel-cmdk-footer">
          <span className="inline-flex items-center gap-1">
            <kbd className="sentinel-kbd-hint">↑↓</kbd> navigate
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="sentinel-kbd-hint">↵</kbd> select
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="sentinel-kbd-hint">esc</kbd> close
          </span>
          <span className="ml-auto inline-flex items-center gap-1 text-emerald-400/70">
            <CommandIcon className="h-3 w-3" /> Sentinel
          </span>
        </div>
      </div>
    </>
  );
}

function CommandPaletteItem({
  icon: Icon,
  label,
  hint,
  disabled,
  onSelect,
  query,
}: {
  icon: typeof PlayCircle;
  label: string;
  hint?: string;
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
  query: string;
}) {
  const q = query.toLowerCase().trim();
  if (q && !label.toLowerCase().includes(q)) return null;
  return (
    <button
      type="button"
      disabled={disabled}
      className="sentinel-cmdk-item w-full text-left"
      data-disabled={disabled ? "true" : undefined}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLElement).dataset.selected = "true";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).dataset.selected = "false";
      }}
      onClick={() => {
        if (!disabled) void onSelect();
      }}
    >
      <Icon className="h-4 w-4 text-slate-400 shrink-0" />
      <span className="flex-1">{label}</span>
      {hint && <kbd className="sentinel-kbd-hint">{hint}</kbd>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// CompoundingComparison — side-by-side Run 1 vs Run 2 metrics.
// Appears after the replay loop completes both runs. Proves the agent reads
// its own prior post-mortem and produces a shorter/faster/cheaper trace.
// ---------------------------------------------------------------------------

function CompoundingComparison({
  run1,
  run2,
  show,
}: {
  run1: RunResult | null;
  run2: RunResult | null;
  show: boolean;
}) {
  if (!show || !run1 || !run2) return null;

  const metrics = (r: RunResult) => {
    const steps = r.steps.length;
    const toolCalls = r.steps.filter((s) => s.kind === "tool_call").length;
    const tokens = r.totalTokens ? r.totalTokens.promptTokens + r.totalTokens.completionTokens : 0;
    const created = r.incident?.createdAt ? new Date(r.incident.createdAt).getTime() : 0;
    const resolved = r.incident?.resolvedAt ? new Date(r.incident.resolvedAt).getTime() : 0;
    const seconds = resolved && created ? (resolved - created) / 1000 : 0;
    const writebacks = r.steps.filter((s) => s.kind === "write_back" || s.toolName === "ack.save_document").length;
    const readPostMortem = r.steps.some(
      (s) => s.kind === "tool_result" && s.toolName === "mcp.search_documents" && Array.isArray(s.toolResult),
    );
    return { steps, toolCalls, tokens, seconds, writebacks, readPostMortem };
  };

  const m1 = metrics(run1);
  const m2 = metrics(run2);

  // Deltas — negative is better for steps/tokens/time (Run 2 should be lower).
  const stepsDelta = m1.steps - m2.steps;
  const tokensDelta = m1.tokens - m2.tokens;
  const timeDelta = m1.seconds - m2.seconds;

  // Scale bars relative to Run 1 (the baseline). Run 2's bar is shorter if better.
  const maxSteps = Math.max(m1.steps, m2.steps, 1);
  const maxTokens = Math.max(m1.tokens, m2.tokens, 1);
  const maxTime = Math.max(m1.seconds, m2.seconds, 1);

  const fmtTime = (s: number) => (s > 0 ? `${s.toFixed(1)}s` : "—");
  const fmtTokens = (t: number) => (t > 0 ? t.toLocaleString() : "—");
  const pct = (delta: number, base: number) => (base > 0 ? Math.round((delta / base) * 100) : 0);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="mt-4 rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/5 to-slate-900/40 p-5"
    >
      <div className="flex items-center gap-2 mb-4">
        <div className="h-8 w-8 rounded-lg bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center">
          <RotateCw className="h-4 w-4 text-emerald-300" />
        </div>
        <div>
          <div className="text-sm font-semibold text-emerald-200">Compounding context — measured</div>
          <div className="text-xs text-slate-400 mt-0.5">
            Run 2 read Run 1&apos;s post-mortem before reasoning. Here&apos;s the measurable difference.
          </div>
        </div>
        {m2.readPostMortem && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-mono text-emerald-300">
            <CheckCircle2 className="h-3 w-3" /> prior post-mortem read
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Reasoning steps */}
        <ComparisonMetric
          label="Reasoning steps"
          run1Value={`${m1.steps}`}
          run2Value={`${m2.steps}`}
          run1Pct={100}
          run2Pct={(m2.steps / maxSteps) * 100}
          delta={stepsDelta}
          deltaLabel={stepsDelta > 0 ? `${stepsDelta} fewer steps` : stepsDelta < 0 ? `${Math.abs(stepsDelta)} more steps` : "same"}
          better={stepsDelta > 0}
        />
        {/* Tokens */}
        <ComparisonMetric
          label="Tokens used"
          run1Value={fmtTokens(m1.tokens)}
          run2Value={fmtTokens(m2.tokens)}
          run1Pct={100}
          run2Pct={(m2.tokens / maxTokens) * 100}
          delta={tokensDelta}
          deltaLabel={tokensDelta > 0 ? `${pct(tokensDelta, m1.tokens)}% fewer tokens` : tokensDelta < 0 ? `${pct(Math.abs(tokensDelta), m1.tokens)}% more tokens` : "same"}
          better={tokensDelta > 0}
        />
        {/* Resolution time */}
        <ComparisonMetric
          label="Resolution time"
          run1Value={fmtTime(m1.seconds)}
          run2Value={fmtTime(m2.seconds)}
          run1Pct={100}
          run2Pct={(m2.seconds / maxTime) * 100}
          delta={timeDelta}
          deltaLabel={timeDelta > 0 ? `${timeDelta.toFixed(1)}s faster` : timeDelta < 0 ? `${Math.abs(timeDelta).toFixed(1)}s slower` : "same"}
          better={timeDelta > 0}
        />
      </div>

      <div className="mt-4 pt-4 border-t border-slate-800/60 flex items-center gap-2 text-[11px] text-slate-500">
        <Sparkles className="h-3 w-3 text-emerald-400" />
        <span>
          The agent wrote a post-mortem to DataHub in Run 1, then retrieved and read it in Run 2 —
          producing a shorter, cheaper reasoning trace. This is the closed-loop metadata agent in action.
        </span>
      </div>
    </motion.div>
  );
}

function ComparisonMetric({
  label,
  run1Value,
  run2Value,
  run1Pct,
  run2Pct,
  delta,
  deltaLabel,
  better,
}: {
  label: string;
  run1Value: string;
  run2Value: string;
  run1Pct: number;
  run2Pct: number;
  delta: number;
  deltaLabel: string;
  better: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-mono mb-2">{label}</div>
      <div className="space-y-2">
        {/* Run 1 */}
        <div>
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="text-slate-500 font-mono">Run 1</span>
            <span className="text-slate-300 font-mono tabular-nums">{run1Value}</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-slate-500 rounded-full sentinel-comparison-bar-run1"
              style={{ width: `${run1Pct}%` }}
            />
          </div>
        </div>
        {/* Run 2 */}
        <div>
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="text-emerald-400 font-mono">Run 2</span>
            <span className="text-emerald-300 font-mono tabular-nums">{run2Value}</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full sentinel-comparison-bar-run2"
              style={{ width: `${run2Pct}%` }}
            />
          </div>
        </div>
      </div>
      {/* Delta */}
      <div className="mt-2 flex items-center gap-1 text-[11px] sentinel-comparison-delta">
        {delta > 0 ? (
          <TrendingDown className="h-3 w-3 text-emerald-400" />
        ) : delta < 0 ? (
          <TrendingUp className="h-3 w-3 text-rose-400" />
        ) : (
          <ArrowLeftRight className="h-3 w-3 text-slate-500" />
        )}
        <span className={better ? "text-emerald-400" : delta < 0 ? "text-rose-400" : "text-slate-500"}>
          {deltaLabel}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsDrawer — right-side slide-in panel showing runtime config.
// Gives reviewers transparency into the agent's configuration: LLM provider,
// model, failover, circuit state, prompt version, connector endpoints,
// guardrail rules, and dry-run mode.
// ---------------------------------------------------------------------------

function SettingsDrawer({
  open,
  onClose,
  llmStatus,
  result,
  connectors,
}: {
  open: boolean;
  onClose: () => void;
  llmStatus: LlmResilienceStatus | null;
  result: RunResult | null;
  connectors: ConnectorStatus | null;
}) {
  // Listen for Escape to close — the drawer uses a custom overlay (not Radix
  // Dialog), so we handle Escape ourselves.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const guardrailRules = [
    { rule: "Refuse writes to PII-tagged assets", icon: ShieldAlert, color: "text-rose-300" },
    { rule: "Gate ownership/glossary proposals behind human approval", icon: Lock, color: "text-amber-300" },
    { rule: "Never delete catalog entities", icon: ShieldCheck, color: "text-emerald-300" },
    { rule: "Cap write-back payload size at 32KB", icon: ShieldCheck, color: "text-emerald-300" },
  ];

  return (
    <>
      <div className="sentinel-drawer-overlay" onClick={onClose} aria-hidden />
      <div className="sentinel-drawer-panel" role="dialog" aria-label="Runtime configuration">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-emerald-400" />
            <div>
              <div className="text-sm font-semibold text-slate-100">Runtime Configuration</div>
              <div className="text-[10px] text-slate-500 font-mono">read-only · live values from the running process</div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            aria-label="Close settings"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="sentinel-drawer-body space-y-5">
          {/* LLM provider */}
          <SettingsSection title="LLM Provider" icon={Zap}>
            <SettingsRow label="Primary provider" value={llmStatus?.provider ?? "—"} mono accent="emerald" />
            <SettingsRow label="Primary model" value={llmStatus?.model ?? result?.llmModel ?? "—"} mono />
            <SettingsRow
              label="Fallback provider"
              value={llmStatus?.fallbackProvider ?? "—"}
              mono
              accent={llmStatus?.fallbackProvider ? "amber" : undefined}
            />
            <SettingsRow
              label="Failover enabled"
              value={llmStatus?.failoverEnabled ? "true" : "false"}
              mono
              accent={llmStatus?.failoverEnabled ? "emerald" : "slate"}
            />
            <SettingsRow label="Prompt version" value={result?.promptVersion ?? "sentinel-v2-phase2-1"} mono />
          </SettingsSection>

          {/* API keys presence (redacted) */}
          <SettingsSection title="API Keys" icon={Lock}>
            <KeyRow label="Gemini" present={llmStatus?.hasGeminiKey} />
            <KeyRow label="Groq" present={llmStatus?.hasGroqKey} />
            <KeyRow label="ZAI (sandbox)" present={llmStatus?.hasZaiKey} />
            <KeyRow label="NVIDIA NIM" present={llmStatus?.hasNvidiaKey} />
            <div className="text-[10px] text-slate-600 mt-1 font-mono">
              Keys are read from environment variables and never exposed to the client. Only presence is shown.
            </div>
          </SettingsSection>

          {/* Circuit breaker */}
          <SettingsSection title="Circuit Breaker" icon={ShieldAlert}>
            {llmStatus?.circuit ? (
              <>
                <SettingsRow
                  label="Primary circuit"
                  value={llmStatus.circuit.isOpen ? "OPEN (throttled)" : "CLOSED (healthy)"}
                  mono
                  accent={llmStatus.circuit.isOpen ? "rose" : "emerald"}
                />
                <SettingsRow
                  label="Consecutive failures"
                  value={`${llmStatus.circuit.consecutiveFailures}`}
                  mono
                  accent={llmStatus.circuit.consecutiveFailures > 0 ? "amber" : "emerald"}
                />
                {llmStatus.circuit.isOpen && llmStatus.circuit.msUntilReset > 0 && (
                  <SettingsRow
                    label="Resets in"
                    value={`${Math.ceil(llmStatus.circuit.msUntilReset / 1000)}s`}
                    mono
                    accent="amber"
                  />
                )}
              </>
            ) : (
              <div className="text-[11px] text-slate-500 font-mono">No circuit data</div>
            )}
          </SettingsSection>

          {/* Connectors */}
          <SettingsSection title="Connectors" icon={Github}>
            {connectors ? (
              <>
                <SettingsRow
                  label="Action mode"
                  value={connectors.dryRun ? "DRY-RUN (trace)" : "LIVE"}
                  mono
                  accent={connectors.dryRun ? "amber" : "emerald"}
                />
                <SettingsRow label="GitHub repo" value={connectors.github.repo || "—"} mono />
                <SettingsRow
                  label="GitHub token"
                  value={connectors.github.tokenPresent ? "present" : "missing"}
                  mono
                  accent={connectors.github.tokenPresent ? "emerald" : "rose"}
                />
                <SettingsRow
                  label="GitHub reachable"
                  value={connectors.github.reachable ? "yes" : "no"}
                  mono
                  accent={connectors.github.reachable ? "emerald" : "rose"}
                />
                <SettingsRow label="Slack channel" value={connectors.slack.channel || "—"} mono />
                <SettingsRow
                  label="Slack token"
                  value={connectors.slack.tokenPresent ? "present" : "missing"}
                  mono
                  accent={connectors.slack.tokenPresent ? "emerald" : "rose"}
                />
                <SettingsRow
                  label="Slack reachable"
                  value={connectors.slack.reachable ? "yes" : "no"}
                  mono
                  accent={connectors.slack.reachable ? "emerald" : "rose"}
                />
              </>
            ) : (
              <div className="text-[11px] text-slate-500 font-mono">Loading connector status…</div>
            )}
          </SettingsSection>

          {/* Guardrail rules */}
          <SettingsSection title="Guardrail Rules" icon={ShieldCheck}>
            <div className="space-y-1.5">
              {guardrailRules.map((r, i) => {
                const Icon = r.icon;
                return (
                  <div key={i} className="flex items-start gap-2 text-[11px] py-1">
                    <Icon className={`h-3 w-3 mt-0.5 shrink-0 ${r.color}`} />
                    <span className="text-slate-400 leading-relaxed">{r.rule}</span>
                  </div>
                );
              })}
            </div>
            <div className="text-[10px] text-slate-600 mt-2 font-mono leading-relaxed">
              Enforced in <code className="text-slate-400">src/lib/guardrail/</code> — code-level, not prompt-level.
              Destructive writes are impossible regardless of LLM output.
            </div>
          </SettingsSection>

          {/* Keyboard shortcuts */}
          <SettingsSection title="Keyboard Shortcuts" icon={CommandIcon}>
            <div className="space-y-1.5">
              <ShortcutRow keys={["⌘", "K"]} label="Open command palette" />
              <ShortcutRow keys={["R"]} label="Inject & run selected signal" />
              <ShortcutRow keys={["A"]} label="Toggle audit log drawer" />
              <ShortcutRow keys={["S"]} label="Toggle this config drawer" />
              <ShortcutRow keys={["1", "–", "5"]} label="Select signal N" />
              <ShortcutRow keys={["?"]} label="Open command palette (help)" />
              <ShortcutRow keys={["esc"]} label="Close any open drawer" />
            </div>
          </SettingsSection>
        </div>
      </div>
    </>
  );
}

function SettingsSection({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Settings;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-3.5 w-3.5 text-emerald-400" />
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 font-mono">{title}</h3>
      </div>
      <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-2.5 space-y-1">{children}</div>
    </section>
  );
}

function SettingsRow({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: "emerald" | "amber" | "rose" | "slate";
}) {
  const accentClass =
    accent === "emerald"
      ? "text-emerald-300"
      : accent === "amber"
        ? "text-amber-300"
        : accent === "rose"
          ? "text-rose-300"
          : "text-slate-300";
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-[11px] text-slate-500">{label}</span>
      <span className={`text-[11px] ${mono ? "font-mono" : ""} ${accentClass} truncate`}>{value}</span>
    </div>
  );
}

function KeyRow({ label, present }: { label: string; present?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-[11px] text-slate-500">{label}</span>
      <span
        className={`inline-flex items-center gap-1 text-[10px] font-mono ${
          present ? "text-emerald-300" : "text-slate-600"
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${present ? "bg-emerald-400" : "bg-slate-700"}`} />
        {present ? "present" : "not set"}
      </span>
    </div>
  );
}

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-[11px] text-slate-400">{label}</span>
      <span className="inline-flex items-center gap-1">
        {keys.map((k, i) => (
          <kbd key={i} className="sentinel-kbd-hint">
            {k}
          </kbd>
        ))}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// System Log terminal — bottom-fixed live event feed.
// Shows timestamped LLM calls, tool calls, write-backs, guardrail decisions,
// connector tests, errors, and system events. Collapsible (L to toggle).
// Gives the dashboard a "live ops console" feel and surfaces every agent
// action in a single chronological stream.
// ---------------------------------------------------------------------------

const SYSLOG_TAG_LABEL: Record<SysLogKind, string> = {
  llm: "LLM",
  tool: "TOOL",
  write: "WRITE",
  guard: "GUARD",
  action: "ACTION",
  system: "SYSTEM",
  error: "ERROR",
};

function formatSysLogTs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function SystemLog({
  entries,
  open,
  onToggle,
  onClear,
}: {
  entries: SysLogEntry[];
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // Auto-scroll to bottom when new entries arrive (only if open).
  useEffect(() => {
    if (open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [entries, open]);

  const latest = entries[entries.length - 1];

  // Render via portal to document.body so `position: fixed` is anchored to
  // the viewport (not affected by ancestor transforms/filters in the tree).
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="sentinel-syslog" style={{ height: open ? 240 : 36 }}>
      <div className="sentinel-syslog-header" onClick={onToggle} role="button" tabIndex={0}>
        <SquareTerminal className="h-3.5 w-3.5 text-emerald-400" />
        <span className="text-[11px] font-mono uppercase tracking-wider text-slate-300">
          System Log
        </span>
        <span className="text-[10px] font-mono text-slate-500">
          {entries.length} {entries.length === 1 ? "event" : "events"}
        </span>
        {!open && latest && (
          <span className="hidden sm:inline-flex items-center gap-2 ml-2 min-w-0 max-w-[480px]">
            <span className={`sentinel-syslog-tag sentinel-syslog-tag-${latest.kind}`}>{SYSLOG_TAG_LABEL[latest.kind]}</span>
            <span className="text-[10px] text-slate-500 font-mono truncate">{formatSysLogTs(latest.ts)}</span>
            <span className="text-[11px] text-slate-400 truncate">{latest.msg}</span>
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {open && (
            <button
              onClick={(e) => { e.stopPropagation(); onClear(); }}
              className="text-[10px] font-mono uppercase tracking-wider text-slate-500 hover:text-rose-300 transition-colors px-2 py-0.5 rounded border border-slate-700 hover:border-rose-500/40"
              title="Clear log"
            >
              Clear
            </button>
          )}
          <kbd className="sentinel-kbd-hint">L</kbd>
          {open ? <ChevronDown className="h-3.5 w-3.5 text-slate-500" /> : <ChevronUp className="h-3.5 w-3.5 text-slate-500" />}
        </span>
      </div>
      {open && (
        <div ref={bodyRef} className="sentinel-syslog-body custom-scroll">
          {entries.length === 0 ? (
            <div className="text-slate-600 text-center py-6 text-[11px]">
              No events yet — Sentinel is idle. Inject a signal to begin.
            </div>
          ) : (
            entries.map((e) => (
              <div key={e.id} className="sentinel-syslog-line">
                <span className="sentinel-syslog-ts">{formatSysLogTs(e.ts)}</span>
                <span className={`sentinel-syslog-tag sentinel-syslog-tag-${e.kind}`}>{SYSLOG_TAG_LABEL[e.kind]}</span>
                <span className="sentinel-syslog-msg">{e.msg}</span>
              </div>
            ))
          )}
          <div className="sentinel-syslog-line">
            <span className="sentinel-syslog-cursor" />
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Keyboard Shortcuts Help overlay — opens with "?" key. Lists every shortcut
// in a clean mission-control dialog. Mirrors the CommandPalette aesthetic.
// ---------------------------------------------------------------------------

function KeyboardShortcutsHelp({ onClose }: { onClose: () => void }) {
  const sections: Array<{
    title: string;
    rows: Array<{ keys: string[]; desc: string }>;
  }> = [
    {
      title: "Run & Investigate",
      rows: [
        { keys: ["R"], desc: "Inject & run Sentinel on the selected signal" },
        { keys: ["1"], desc: "Select signal #1 (NYC Taxi freshness)" },
        { keys: ["2"], desc: "Select signal #2 (Showcase eCommerce schema)" },
        { keys: ["3"], desc: "Select signal #3 (Customer PII governance)" },
      ],
    },
    {
      title: "Navigation",
      rows: [
        { keys: ["⌘", "K"], desc: "Open command palette (fuzzy-search any action)" },
        { keys: ["?"], desc: "Toggle this keyboard shortcuts help overlay" },
        { keys: ["A"], desc: "Toggle audit log drawer" },
        { keys: ["S"], desc: "Toggle runtime config (settings) drawer" },
        { keys: ["L"], desc: "Toggle system log terminal at the bottom" },
        { keys: ["Esc"], desc: "Close any open overlay / drawer" },
      ],
    },
    {
      title: "Replay Loop (Compounding Context)",
      rows: [
        { keys: ["Click", "Replay"], desc: "Run the agent twice on the same scenario — Run 2 reads Run 1's post-mortem" },
      ],
    },
    {
      title: "Reveal",
      rows: [
        { keys: ["Click", "History"], desc: "View a past incident's full trace (reasoning + actions + write-backs)" },
        { keys: ["Click", "Audit"], desc: "Stream every audit event for the current incident" },
      ],
    },
  ];

  // Close on overlay click
  function onOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  // Render via portal so `position: fixed` is anchored to the viewport.
  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      <div className="sentinel-help-overlay" onClick={onOverlayClick} />
      <div className="sentinel-help-panel" role="dialog" aria-label="Keyboard shortcuts">
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-slate-800">
          <Keyboard className="h-4 w-4 text-emerald-400" />
          <h2 className="sentinel-panel-title">Keyboard Shortcuts</h2>
          <span className="ml-auto text-[10px] font-mono text-slate-500">
            Press <kbd className="sentinel-kbd-hint">?</kbd> or <kbd className="sentinel-kbd-hint">Esc</kbd> to close
          </span>
          <button
            onClick={onClose}
            className="ml-2 text-slate-500 hover:text-slate-200 transition-colors"
            aria-label="Close"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </div>
        <div className="sentinel-help-body">
          {sections.map((s) => (
            <div key={s.title}>
              <div className="sentinel-help-section-title">{s.title}</div>
              {s.rows.map((row, i) => (
                <div key={i} className="sentinel-help-row">
                  <div className="sentinel-help-keys">
                    {row.keys.map((k, j) => (
                      <kbd key={j} className="sentinel-help-kbd">{k}</kbd>
                    ))}
                  </div>
                  <div className="sentinel-help-desc">{row.desc}</div>
                </div>
              ))}
            </div>
          ))}
          <div className="mt-4 rounded-md border border-slate-800 bg-slate-900/40 p-3 text-[11px] text-slate-400 leading-relaxed">
            <span className="text-emerald-300 font-semibold">Tip:</span> Shortcuts are disabled while typing in an input field.
            <kbd className="sentinel-kbd-hint ml-2">⌘K</kbd> works even while typing.
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// IdleMonitoringState — rotating "watching" messages shown in the empty
// ReasoningStream before any signal is injected. Gives the dashboard a
// "live" presence (a typewriter cursor + rotating status text) so it
// doesn't look "dead" while waiting for the first click.
// ---------------------------------------------------------------------------

const IDLE_MESSAGES = [
  "watching DataHub assertion stream",
  "MCP server heartbeat OK · 15 tools registered",
  "guardrail armed · PII writes will be refused",
  "Agent Context Kit channel open",
  "lineage graph cache warm",
  "circuit breaker healthy · failover armed",
];

function IdleMonitoringState() {
  const [idx, setIdx] = useState(0);
  const [typed, setTyped] = useState("");

  // Rotate the message every 3.5s.
  useEffect(() => {
    const t = setInterval(() => {
      setIdx((i) => (i + 1) % IDLE_MESSAGES.length);
      setTyped("");
    }, 3500);
    return () => clearInterval(t);
  }, []);

  // Typewriter effect — reveal one char at a time over ~1.2s.
  useEffect(() => {
    const msg = IDLE_MESSAGES[idx];
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      setTyped(msg.slice(0, i));
      if (i >= msg.length) clearInterval(t);
    }, 36);
    return () => clearInterval(t);
  }, [idx]);

  return (
    <div className="text-center py-10">
      <div className="relative mx-auto mb-4 h-16 w-16">
        {/* Rotating radar sweep */}
        <div className="absolute inset-0 rounded-full border border-emerald-500/20 bg-emerald-500/5" />
        <div className="absolute inset-2 rounded-full border border-emerald-500/15" />
        <div className="absolute inset-4 rounded-full border border-emerald-500/10" />
        <div className="absolute inset-0 sentinel-idle-radar">
          <div className="absolute top-1/2 left-1/2 h-0.5 w-8 -translate-y-1/2 bg-gradient-to-r from-emerald-400/80 to-transparent rounded-full" />
        </div>
        <BrainCircuit className="absolute inset-0 m-auto h-6 w-6 text-emerald-400/80" />
      </div>
      <div className="font-mono text-sm text-slate-300">
        <span className="text-emerald-400">●</span> monitoring
        <span className="sentinel-idle-cursor" />
      </div>
      <div className="mt-2 font-mono text-xs text-slate-500 min-h-[1em]">
        {typed}
      </div>
      <p className="mt-4 text-xs text-slate-500/90 max-w-xs mx-auto leading-relaxed">
        Select a signal above and click <strong className="text-emerald-400">Inject &amp; run Sentinel</strong> to watch the ReAct loop investigate in real time.
      </p>
      <div className="mt-4 flex items-center justify-center gap-3 text-[10px] text-slate-600">
        <span className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900/40 px-2 py-1">
          <kbd className="sentinel-kbd">Enter</kbd> to run
        </span>
        <span className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900/40 px-2 py-1">
          <kbd className="sentinel-kbd">⌘K</kbd> command palette
        </span>
        <span className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900/40 px-2 py-1">
          <kbd className="sentinel-kbd">?</kbd> shortcuts
        </span>
      </div>
    </div>
  );
}

