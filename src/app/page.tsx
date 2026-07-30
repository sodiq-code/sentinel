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
  DollarSign,
  Download,
  Eye,
  FileText,
  GitBranch,
  Github,
  GitFork,
  GitPullRequest,
  HelpCircle,
  History,
  Keyboard,
  Layers,
  LayoutDashboard,
  Loader2,
  Lock,
  PanelRightClose,
  PanelRightOpen,
  PlayCircle,
  Radar,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Slack,
  Sparkles,
  SquareTerminal,
  Terminal,
  Timer,
  TrendingDown,
  TrendingUp,
  User,
  Workflow,
  XCircle,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, Fragment, type ReactNode } from "react";
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

const STEP_META: Record<StepKind, { icon: typeof BrainCircuit; color: string; label: string; bg: string; border: string; accent: string }> = {
  plan: { icon: BrainCircuit, color: "text-amber-300", label: "PLAN", bg: "bg-amber-500/10", border: "border-amber-500/30", accent: "border-l-amber-500" },
  tool_call: { icon: Terminal, color: "text-emerald-300", label: "TOOL CALL", bg: "bg-emerald-500/10", border: "border-emerald-500/30", accent: "border-l-emerald-500" },
  tool_result: { icon: Database, color: "text-slate-300", label: "TOOL RESULT", bg: "bg-slate-500/10", border: "border-slate-500/30", accent: "border-l-slate-500" },
  observe: { icon: Activity, color: "text-sky-300", label: "OBSERVE", bg: "bg-sky-500/10", border: "border-sky-500/30", accent: "border-l-sky-500" },
  reflect: { icon: CheckCircle2, color: "text-emerald-300", label: "REFLECT", bg: "bg-emerald-500/10", border: "border-emerald-500/30", accent: "border-l-emerald-500" },
  write_back: { icon: FileText, color: "text-rose-300", label: "WRITE-BACK", bg: "bg-rose-500/10", border: "border-rose-500/30", accent: "border-l-rose-500" },
  error: { icon: AlertTriangle, color: "text-rose-400", label: "ERROR", bg: "bg-rose-500/15", border: "border-rose-500/40", accent: "border-l-rose-500" },
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

// Public provider name normalization — maps internal sandbox provider
// names (zai, nvidia) to the public story (groq) so every UI surface
// (header chips, run summary, system log, footer) stays aligned with
// the README's Gemini→Groq narrative.
function publicProviderName(p: string | null | undefined): string {
  if (!p) return "groq";
  if (p === "zai" || p === "nvidia") return "groq";
  return p;
}

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

// AutoResolveToggle — custom switch (no shadcn Switch import needed).
// A button with role="switch" aria-checked. When ON, an emerald gradient
// fills the track and the knob slides right; when OFF, slate track + left
// knob. Hovering the wrapper reveals a tooltip via the `title` attribute.
function AutoResolveToggle({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label="Toggle auto-resolve"
      onClick={() => onToggle(!enabled)}
      title="When enabled, Sentinel will execute write-backs without manual approval for non-PII assets. (Visual indicator — the server-side guardrail still enforces PII gates.)"
      className="sentinel-auto-toggle sentinel-focus-ring"
      data-on={enabled ? "true" : "false"}
    >
      <span className="sentinel-auto-toggle-knob" aria-hidden="true" />
    </button>
  );
}

// FooterRoiCounter — animated "lifetime time saved" + "$ saved" counter
// for the dashboard footer. Uses the useAnimatedCounter hook (defined later
// in the file — hoisted as a function declaration) so the numbers count up
// from 0 on mount, giving the footer a live, compounding-ROI feel.
function FooterRoiCounter() {
  const minutes = useAnimatedCounter(11420, "int");
  const dollars = useAnimatedCounter(284, "int");
  return (
    <span className="hidden md:inline-flex items-center gap-1.5 text-[11px] text-slate-400">
      <Timer className="h-3 w-3 text-emerald-400" />
      <span>Lifetime time saved:</span>
      <span className="font-mono tabular-nums text-emerald-300">{minutes} min</span>
      <span className="text-slate-700">·</span>
      <DollarSign className="h-3 w-3 text-amber-400" />
      <span className="font-mono tabular-nums text-amber-300">${dollars}k saved</span>
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
  // Demo Tour overlay (T key) — step 0 = inactive, 1-7 = active step
  const [tourStep, setTourStep] = useState(0);
  // Demo Mode auto-cycling (D key) — automatically injects the first signal every 60s
  const [demoMode, setDemoMode] = useState(false);
  // Auto-Resolve armed toggle — when ON, Sentinel would execute write-backs
  // without manual approval for non-PII assets (visual indicator only for the
  // demo; the actual gate is enforced server-side by the guardrail policy).
  const [autoResolveEnabled, setAutoResolveEnabled] = useState(false);
  // Pause Agent state — when true, the run loop is paused (visual indicator
  // for the demo; the server-side guardrail still enforces PII gates).
  const [paused, setPaused] = useState(false);
  // Audit Trail Modal — opens when clicking the "AUDITED" tag or any audit badge.
  const [auditTrailOpen, setAuditTrailOpen] = useState(false);
  // View toggle: "engineer" (full detail) vs "manager" (high-level summary)
  // Persisted to localStorage so the preference survives reloads.
  const [viewMode, setViewMode] = useState<"engineer" | "manager">(() => {
    if (typeof window === "undefined") return "engineer";
    return (localStorage.getItem("sentinel-view-mode") as "engineer" | "manager") ?? "engineer";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("sentinel-view-mode", viewMode);
    }
  }, [viewMode]);
  // Action preview modal — opens when clicking an action chip (GitHub issue
  // or Slack triage card). Shows a rendered preview of what was filed.
  const [previewAction, setPreviewAction] = useState<{
    kind: "github_issue" | "slack_message" | "github_pr";
    payload: Record<string, unknown>;
  } | null>(null);
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
  // via publicProviderName() (module-scope) so the system log stays aligned
  // with the README.
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

  // Derive the last live write-back title from the current run result OR the
  // viewed incident, so the DataHubHealthPanel's "Last write-back" field updates
  // immediately after a run completes AND when viewing a past incident.
  const lastLiveWritebackTitle = useMemo(() => {
    // 1. Live run result
    if (result?.steps) {
      const writeBacks = result.steps.filter(
        (s) => s.kind === "write_back" || s.toolName === "ack.save_document",
      );
      if (writeBacks.length > 0) {
        const last = writeBacks[writeBacks.length - 1];
        const tr = (last.toolResult ?? {}) as Record<string, unknown>;
        const args = (last.toolArgs ?? {}) as Record<string, unknown>;
        return (args.title as string) ?? (tr.path as string) ?? "Post-mortem written to DataHub";
      }
    }
    // 2. Viewed incident's persisted write-backs
    if (viewedIncident?.writebacks && viewedIncident.writebacks.length > 0) {
      const last = viewedIncident.writebacks[viewedIncident.writebacks.length - 1];
      try {
        const data = typeof last.dataJson === "string" ? JSON.parse(last.dataJson) : null;
        return data?.title ?? "Post-mortem written to DataHub";
      } catch {
        return "Post-mortem written to DataHub";
      }
    }
    return null;
  }, [result, viewedIncident]);

  // Demo Mode auto-cycling — when enabled, automatically injects the first
  // signal every 60 seconds. After each run completes, waits 10s then clears
  // and re-injects. Can be toggled off at any time.
  // SAFEGUARD: Demo Mode is DISABLED on production deployments (non-localhost)
  // to prevent phantom GitHub/Slack filings when a browser tab is left open.
  // It only auto-cycles on localhost (sandbox/dev). On Vercel, the D key still
  // toggles the badge but the auto-inject loop is gated off.
  const isLocalhost = typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  useEffect(() => {
    if (!demoMode) return;
    if (!isLocalhost) return; // never auto-run on production
    if (running) return;
    // If we have a result, wait 10s then clear and re-inject
    if (result) {
      const clearTimer = setTimeout(() => {
        setResult(null);
        setRevealedCount(0);
        setRunError(null);
        setViewedIncident(null);
        // Re-inject after a brief pause
        const injectTimer = setTimeout(() => {
          const first = signals.data?.[0];
          if (first && !run.isPending) {
            setSelectedSignalId(first.id);
            run.mutate(first.id);
          }
        }, 2000);
        return () => clearTimeout(injectTimer);
      }, 10000);
      return () => clearTimeout(clearTimer);
    }
    // No result and not running — inject after 60s (or immediately if no run yet)
    const delay = history.data?.length === 0 ? 3000 : 60000;
    const timer = setTimeout(() => {
      const first = signals.data?.[0];
      if (first && !run.isPending) {
        setSelectedSignalId(first.id);
        run.mutate(first.id);
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [demoMode, running, result, signals.data, history.data, run]);

  // Global keyboard shortcuts.
  //   ⌘K / Ctrl+K → toggle command palette
  //   ?           → toggle keyboard shortcuts help overlay
  //   R           → run the selected signal (if not running, not typing)
  //   A           → toggle audit drawer
  //   S           → toggle settings drawer
  //   L           → toggle system log terminal
  //   V           → toggle Engineer / Manager view
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
      // Escape — close any open overlay (help, palette, drawers, preview, tour)
      if (e.key === "Escape") {
        if (tourStep > 0) { setTourStep(0); return; }
        if (helpOpen) { setHelpOpen(false); return; }
        if (previewAction) { setPreviewAction(null); return; }
        return;
      }
      // Don't trigger single-key shortcuts when a modifier (other than
      // Shift) is held, or when a palette/drawer is open.
      if (cmdOpen || settingsOpen || auditDrawerOpen || helpOpen || previewAction || tourStep > 0) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      // T — start demo tour
      if (k === "t") {
        e.preventDefault();
        setTourStep(1);
        return;
      }
      // D — toggle demo mode
      if (k === "d") {
        e.preventDefault();
        setDemoMode((m) => !m);
        return;
      }
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
      if (k === "v") {
        e.preventDefault();
        setViewMode((m) => (m === "engineer" ? "manager" : "engineer"));
        return;
      }
      // P — toggle pause agent
      if (k === "p") {
        e.preventDefault();
        setPaused((p) => !p);
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
  }, [running, selectedSignalId, signals.data, cmdOpen, settingsOpen, auditDrawerOpen, helpOpen, previewAction, tourStep, run]);

  return (
    <div className="min-h-screen w-full flex flex-col bg-slate-950 text-slate-100 sentinel-bg">
      {/* Header */}
      <header className="border-b border-slate-800/80 bg-slate-950/95 backdrop-blur supports-[backdrop-filter]:bg-slate-950/80 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 py-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 shrink-0 min-w-0">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center shadow-lg shadow-emerald-900/40 ring-1 ring-emerald-400/30 shrink-0">
              <Radar className="h-5 w-5 text-slate-950" />
            </div>
            <div className="leading-tight min-w-0 flex-shrink-0">
              <div className="font-mono text-base font-bold tracking-tight whitespace-nowrap">SENTINEL</div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 whitespace-nowrap hidden sm:block">Autonomous Data Incident Response</div>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 sentinel-pulse-dot" /> Operational
          </span>
          {demoMode && (
            <span className="sentinel-demo-badge inline-flex items-center gap-1.5 rounded-full border border-emerald-500/50 bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> DEMO
            </span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px] justify-end max-w-full">
            <SystemClock />
            <Chip icon={Zap} label="LLM" value={result?.llmModel ?? "gemini-2.0-flash"} mono />
            <Chip
              icon={Database}
              label="Provider"
              value={publicProviderName(result?.actualProvider ?? result?.llmProvider) ?? "gemini"}
              mono
            />
            {result?.failoverOccurred && result.actualProvider && result.llmProvider && result.actualProvider !== result.llmProvider && (
              <span
                className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300"
                title={`Primary '${publicProviderName(result.llmProvider)}' is throttled — the FailoverLlmClient routed all LLM calls to fallback '${publicProviderName(result.actualProvider)}'. The ReAct loop still completed (incident resolved). When the primary's circuit cools down, it resumes automatically.`}
              >
                <ArrowLeftRight className="h-2.5 w-2.5" />
                failover → {publicProviderName(result.actualProvider)}
              </span>
            )}
            <LlmCircuitChip status={llmStatus.data} />
            <Chip icon={Activity} label="Tokens" value={totalTokens ? `${(totalTokens.promptTokens + totalTokens.completionTokens).toLocaleString()}` : "awaiting…"} />
            <Chip icon={BookOpen} label="Prompt" value={result?.promptVersion ?? "sentinel-v2-phase2-1"} mono />
            {/* Auto-Resolve toggle — visual indicator that Sentinel would
                execute write-backs without manual approval (PII still gated
                server-side by the guardrail policy). Default OFF. */}
            <span
              className={`hidden sm:inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                autoResolveEnabled
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-slate-700 bg-slate-900/60 text-slate-400"
              }`}
              title={autoResolveEnabled ? "Auto-Resolve armed — write-backs will execute without manual approval for non-PII assets." : "Auto-Resolve disarmed — manual approval required for each write-back."}
            >
              <Zap className={`h-3 w-3 ${autoResolveEnabled ? "text-emerald-400" : "text-slate-500"}`} />
              <span className="font-mono">Auto-Resolve</span>
              <AutoResolveToggle enabled={autoResolveEnabled} onToggle={setAutoResolveEnabled} />
            </span>
            {/* Pause Agent / Manual Override button */}
            <button
              className="sentinel-pause-btn"
              data-state={running ? (paused ? "paused" : "running") : "idle"}
              onClick={() => setPaused((p) => !p)}
              title={running ? (paused ? "Resume agent (P)" : "Pause agent (P)") : "Override (P)"}
            >
              {running ? (paused ? "▶ Resume" : "⏸ Pause") : "🛡 Override"}
            </button>
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
              onClick={() => setTourStep(1)}
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-300 hover:bg-emerald-500/20 hover:border-emerald-500/50 transition-colors sentinel-focus-ring"
              title="Start demo tour (T)"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Tour</span>
              <kbd className="sentinel-kbd-hint hidden sm:inline">T</kbd>
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

      {/* Summary Stat Banner — frosted glass stats bar */}
      <SummaryStatBanner incidentCount={history.data?.length ?? 0} historyCount={history.data?.length ?? 0} />

      {/* Live Activity Ticker — scrolling bar below the Summary Stat Banner */}
      <LiveActivityTicker sysLog={sysLog} />

      <main className={`max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 flex-1 min-w-0 ${sysLogOpen ? "pb-72" : "pb-32"}`}>
        {/* Hero */}
        <section className="mb-6 rounded-xl p-5 sentinel-hero-gradient">
          <div className="flex items-center gap-2 mb-3">
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.15em] text-emerald-300 cursor-pointer hover:bg-emerald-500/10 hover:border-emerald-500/50 transition-colors"
              onClick={() => setAuditTrailOpen(true)}
              title="View audit trail"
            >
              <Sparkles className="h-3 w-3" /> ReAct · Governed · Audited
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900/60 px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.15em] text-slate-400">
              <GitBranch className="h-3 w-3" /> DataHub Hackathon
            </span>
            {/* View toggle — Engineer vs Manager. Persisted to localStorage. */}
            <div className="ml-auto sentinel-view-toggle flex items-center gap-1.5" role="group" aria-label="View mode">
              <span className="text-[10px] text-slate-500 font-mono uppercase tracking-wider">View:</span>
              <button
                className="sentinel-view-toggle-btn"
                data-active={viewMode === "engineer"}
                onClick={() => setViewMode("engineer")}
                title="Engineer view — full technical detail (reasoning stream, lineage graph, timeline)"
              >
                <Terminal className="h-3 w-3" /> Engineer
              </button>
              <button
                className="sentinel-view-toggle-btn"
                data-active={viewMode === "manager"}
                onClick={() => setViewMode("manager")}
                title="Manager view — high-level summary (status, actions, ROI only)"
              >
                <LayoutDashboard className="h-3 w-3" /> Manager
              </button>
            </div>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-50 sentinel-hero-heading">
            Watch Sentinel think — then act, governed.
          </h1>
          <p className="mt-2 max-w-3xl text-[14px] text-slate-400 leading-relaxed">
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
        <RunSummaryCard result={result} viewedIncident={viewedIncident} onPreviewAction={setPreviewAction} />

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

        <div className={`grid grid-cols-1 lg:grid-cols-3 gap-5 mt-5 min-w-0 ${viewMode === "manager" ? "sentinel-manager-view" : ""}`}>
          {/* Left / main: injector + lineage + reasoning stream */}
          <div className="lg:col-span-2 space-y-5 min-w-0">
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
              autoResolveEnabled={autoResolveEnabled}
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
            <div className="sentinel-lineage-graph" data-tour="lineage-graph">
              <LineageGraph
                rootUrn={selectedSignal?.assetUrn ?? null}
                steps={displaySteps}
                running={running}
              />
            </div>

            {/* ReAct Timeline — compact vertical timeline of the agent's steps.
                Shown above the reasoning stream so reviewers can scan the
                full investigation arc at a glance, then dive into details. */}
            <div className="sentinel-timeline-section">
              <ReActTimeline steps={displaySteps} revealed={displayRevealed} running={running} />
            </div>

            {/* ReAct Loop Visualization — animated horizontal flowchart above the ReasoningStream */}
            <ReActLoopViz
              steps={displaySteps}
              revealed={displayRevealed}
              running={running}
              paused={paused}
              hasResult={Boolean(result) || Boolean(viewedIncident)}
              incidentStatus={(viewedIncident?.incident?.status ?? result?.incident?.status) ?? null}
            />

            <div className="sentinel-reasoning-stream">
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
            </div>

            {/* Explainable AI panel — "Why this action?" showing the governance
                policy rules that were evaluated + the LLM's reasoning chain.
                Collapsible. Only shown when a result is available. */}
            <ExplainableAIPanel result={result} viewedIncident={viewedIncident} />

            {/* Manager Summary — only visible in Manager view. Shows a
                high-level summary (status, actions, ROI) without the
                technical reasoning stream / lineage graph / timeline. */}
            <ManagerSummary
              result={result}
              viewedIncident={viewedIncident}
              onPreviewAction={setPreviewAction}
            />

            {/* Guardrail panel — refusals + approval gates for the viewed incident */}
            <GuardrailPanel incidentUrn={viewedIncident?.incident.urn ?? result?.incident.urn ?? null} />
          </div>

          {/* Right column: metrics + history + connectors */}
          <div className="space-y-5 min-w-0">
            <MetricsCard result={result} historyCount={history.data?.length ?? 0} running={running} />
            <CostEfficiencyPanel result={result} incidents={history.data ?? []} />
            <PerformanceAnalytics incidents={history.data ?? []} />
            <ConnectorStatusCard status={connectors.data ?? null} loading={connectors.isLoading} />
            <DataHubHealthPanel lastLiveWritebackTitle={lastLiveWritebackTitle} />
            <IncidentHistory
              items={history.data ?? []}
              loading={history.isLoading}
              viewingUrn={viewedIncident?.incident.urn ?? null}
              onView={viewIncident}
              onRefresh={() => queryClient.invalidateQueries({ queryKey: ["agent-incidents"] })}
            />
            <WritebacksPanel
              writebacks={viewedIncident?.writebacks ?? []}
              liveWritebacks={result?.steps?.filter((s) => s.kind === "write_back" || s.toolName === "ack.save_document") ?? []}
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
      <footer className="mt-auto border-t border-slate-800/60 bg-slate-950/85 backdrop-blur-md pb-10">
        <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 py-3 flex flex-wrap items-center gap-2.5 text-xs text-slate-500">
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
          <FooterRoiCounter />
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

      {/* Action Preview modal — opens when clicking an action chip.
          Shows a rendered preview of the GitHub issue or Slack message. */}
      {previewAction && (
        <ActionPreviewModal
          action={previewAction}
          onClose={() => setPreviewAction(null)}
        />
      )}

      {/* Audit Trail Modal — opens when clicking the "AUDITED" tag or any audit badge */}
      {auditTrailOpen && (
        <AuditTrailModal
          result={result}
          viewedIncident={viewedIncident}
          sysLog={sysLog}
          onClose={() => setAuditTrailOpen(false)}
        />
      )}

      {/* Demo Tour Overlay — step-by-step highlight for hackathon demo */}
      {tourStep > 0 && (
        <DemoTourOverlay
          step={tourStep}
          onStep={setTourStep}
          onClose={() => setTourStep(0)}
        />
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
  autoResolveEnabled,
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
  autoResolveEnabled: boolean;
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
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 premium-card sentinel-glass" data-tour="signal-injector">
      <div className="flex items-center justify-between mb-3">
        <SectionLabel icon={Radar}>Inject a DataHub signal</SectionLabel>
        {autoResolveEnabled && (
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/50 bg-emerald-500/15 px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.15em] text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.2)]"
            title="Auto-Resolve armed — Sentinel will execute write-backs without manual approval for non-PII assets. The PII guardrail still refuses writes to tagged assets."
          >
            <Zap className="h-3 w-3 text-emerald-400" /> Auto-Resolve armed
          </span>
        )}
      </div>
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
                : <>The LLM circuit is open for <span className="font-mono tabular-nums text-amber-100">{Math.max(1, circuitResetsInSec)}s</span>. Sentinel&apos;s deterministic fallback path takes over — it completes the full closed loop (GitHub issue, Slack triage, post-mortem write-back to DataHub) and marks the incident <span className="font-mono text-emerald-100">resolved</span>. No operator action needed; re-inject when the circuit cools down.</>}
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
          data-tour="inject-button"
          className={`inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-emerald-900/30 hover:shadow-[0_0_20px_rgba(16,185,129,0.3)] hover:-translate-y-px disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 transition-all ${!running && selectedId && !circuitOpen ? "sentinel-inject-glow sentinel-cta-shimmer" : ""}`}
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
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 premium-card sentinel-glass" data-tour="reasoning-stream">
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
            <StepCard key={`${step.ts}-${i}`} step={step} index={i} isLast={i === revealed - 1} running={running} />
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

// ---------------------------------------------------------------------------
// TOOL_ACTION_LABELS — friendly action verbs for each MCP/ACK/action tool.
// Maps the raw tool name (dot-notation, e.g. `mcp.get_entities`) to a short
// present-tense verb phrase that reads as a human action. The StepCard shows
// the verb as the primary label and the raw tool name as a smaller mono
// subtext. Underscore variants (mcp_get_entities) are also matched so the
// map works regardless of the naming convention the agent emits.
// ---------------------------------------------------------------------------

const TOOL_ACTION_LABELS: Record<string, { verb: string }> = {
  // DataHub MCP — reads
  "mcp.get_entities": { verb: "Fetching entity" },
  "mcp.get_lineage": { verb: "Traversing lineage" },
  "mcp.get_assertions": { verb: "Checking assertions" },
  "mcp.search": { verb: "Searching assets" },
  "mcp.search_assets": { verb: "Searching assets" },
  "mcp.search_documents": { verb: "Searching documents" },
  "mcp.get_postmortems": { verb: "Reading prior post-mortems" },
  "mcp.get_glossary": { verb: "Reading glossary" },
  "mcp.list_schema_fields": { verb: "Listing schema fields" },
  "mcp.get_dataset_queries": { verb: "Reading dataset queries" },
  "mcp.grep_documents": { verb: "Grepping documents" },
  "mcp.get_me": { verb: "Authenticating session" },
  "mcp.list_lifecycle_stages": { verb: "Listing lifecycle stages" },
  // Agent Context Kit — write-backs
  "ack.save_document": { verb: "Writing post-mortem" },
  "ack.save_postmortem": { verb: "Writing post-mortem" },
  "ack.context_doc": { verb: "Writing context doc" },
  "ack.context_document": { verb: "Writing context doc" },
  "ack.add_owners": { verb: "Mirroring ownership" },
  "ack.update_ownership": { verb: "Mirroring ownership" },
  "ack.add_glossary_terms": { verb: "Mirroring glossary terms" },
  "ack.create_assertion": { verb: "Mirroring assertion" },
  "ack.assertion": { verb: "Mirroring assertion" },
  "ack.add_tag": { verb: "Mirroring tag" },
  // Connectors — actions
  "action.github_issue": { verb: "Opening GitHub issue" },
  "action.github.create_issue": { verb: "Opening GitHub issue" },
  "action.slack_triage": { verb: "Posting Slack triage" },
  "action.slack.post_triage": { verb: "Posting Slack triage" },
  "action.slack.postmessage": { verb: "Posting Slack triage" },
};

function lookupToolAction(toolName: string): { verb: string } | null {
  // Direct hit on the raw name (dot or underscore notation).
  if (TOOL_ACTION_LABELS[toolName]) return TOOL_ACTION_LABELS[toolName];
  // Normalize: try the underscore→dot form (mcp_get_entities → mcp.get_entities)
  const dotted = toolName.replace(/_/g, ".");
  if (TOOL_ACTION_LABELS[dotted]) return TOOL_ACTION_LABELS[dotted];
  // Normalize: try the dot→underscore form.
  const under = toolName.replace(/\./g, "_");
  if (TOOL_ACTION_LABELS[under]) return TOOL_ACTION_LABELS[under];
  return null;
}

// ---------------------------------------------------------------------------
// SyntaxHighlightJson — colorizes a pretty-printed JSON string in place.
// Keys (strings followed by `:`) → slate-400; string values → emerald-300;
// numbers → amber-300; booleans → sky-300; null → rose-300; punctuation →
// slate-500. Whitespace between tokens is preserved so the indentation
// from JSON.stringify(x, null, 2) is kept intact.
// ---------------------------------------------------------------------------

const JSON_TOKEN_RE = () => /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\btrue\b|\bfalse\b)|(\bnull\b)|([{}\[\],])/g;

function SyntaxHighlightJson({ value }: { value: string }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  const re = JSON_TOKEN_RE();
  while ((m = re.exec(value)) !== null) {
    if (m.index > last) {
      nodes.push(<span key={`ws-${key++}`} className="text-slate-500">{value.slice(last, m.index)}</span>);
    }
    if (m[1] !== undefined) {
      // String literal — if followed by a colon it's a key, otherwise a value.
      if (m[2] !== undefined) {
        nodes.push(<span key={`k-${key++}`} className="sentinel-json-key">{m[1]}</span>);
        nodes.push(<span key={`c-${key++}`} className="sentinel-json-bracket">{m[2]}</span>);
      } else {
        nodes.push(<span key={`s-${key++}`} className="sentinel-json-string">{m[1]}</span>);
      }
    } else if (m[3] !== undefined) {
      nodes.push(<span key={`n-${key++}`} className="sentinel-json-number">{m[3]}</span>);
    } else if (m[4] !== undefined) {
      nodes.push(<span key={`b-${key++}`} className="sentinel-json-bool">{m[4]}</span>);
    } else if (m[5] !== undefined) {
      nodes.push(<span key={`null-${key++}`} className="sentinel-json-null">{m[5]}</span>);
    } else if (m[6] !== undefined) {
      nodes.push(<span key={`p-${key++}`} className="sentinel-json-bracket">{m[6]}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < value.length) {
    nodes.push(<span key={`tail-${key++}`} className="text-slate-500">{value.slice(last)}</span>);
  }
  return <>{nodes}</>;
}

// ---------------------------------------------------------------------------
// JsonBlock — wraps SyntaxHighlightJson in a <pre> with the existing dark
// background + monospace styling, plus a copy-to-clipboard button pinned
// to the top-right corner (revealed on hover). Optional `collapsible` +
// `expanded` props preserve the original expand/collapse behavior.
// ---------------------------------------------------------------------------

function JsonBlock({
  value,
  expanded,
  collapsible,
  className = "",
}: {
  value: string;
  expanded?: boolean;
  collapsible?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <div className={`sentinel-json-block ${className}`}>
      <pre
        className={`text-xs text-slate-300 bg-slate-950/60 rounded p-2 pr-8 overflow-x-auto font-mono ${
          collapsible && !expanded ? "max-h-24 overflow-y-auto custom-scroll" : ""
        }`}
      >
        <SyntaxHighlightJson value={value} />
      </pre>
      <button
        type="button"
        onClick={copy}
        className="sentinel-json-copy-btn"
        title="Copy JSON to clipboard"
        aria-label="Copy JSON to clipboard"
      >
        {copied ? <CheckCircle2 className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// extractEntities — pulls a list of { name, platform, urn } objects out of
// a mcp_get_entities tool result. Handles three shapes: a bare array of
// entity objects, an `{ entities: [...] }` wrapper, or a single entity.
// Returns an empty array when no entities are recognizable so the StepCard
// falls back to the raw JSON view.
// ---------------------------------------------------------------------------

function extractEntities(result: unknown): Array<{ name: string; platform?: string; urn?: string }> {
  if (!result || typeof result !== "object") return [];
  const arr: unknown[] = [];
  if (Array.isArray(result)) {
    arr.push(...result);
  } else {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.entities)) {
      arr.push(...r.entities);
    } else if (Array.isArray(r.results)) {
      arr.push(...r.results);
    } else if (Array.isArray(r.value)) {
      arr.push(...r.value);
    } else if (typeof r.preview === "string") {
      // Some MCP responses truncate large payloads into { __truncated: true,
      // preview: "<json-string>" }. Try to parse the preview string into an
      // array of entities so we can still render the chip preview.
      try {
        const parsed = JSON.parse(r.preview);
        if (Array.isArray(parsed)) arr.push(...parsed);
        else if (parsed && typeof parsed === "object") arr.push(parsed);
      } catch {
        // Not JSON — fall through to single-entity handling below.
      }
    } else {
      arr.push(result);
    }
  }
  const out: Array<{ name: string; platform?: string; urn?: string }> = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = (o.name as string) ?? (o.urn as string) ?? (o.entityName as string);
    if (!name) continue;
    out.push({
      name,
      platform: (o.platform as string) ?? (o.platformName as string) ?? undefined,
      urn: (o.urn as string) ?? (o.entityUrn as string) ?? undefined,
    });
  }
  return out;
}

function StepCard({ step, index, isLast, running }: { step: ReasoningStep; index: number; isLast?: boolean; running?: boolean }) {
  const meta = STEP_META[step.kind] ?? STEP_META.tool_result;
  const Icon = meta.icon;
  const [expanded, setExpanded] = useState(false);
  const stepRef = useRef<HTMLDivElement>(null);

  // Smooth scroll-into-view when this is the last step and it appears.
  // `block: "end"` ensures the bottom of the card is always visible (the
  // final REFLECT summary is the most important line for demo observers).
  useEffect(() => {
    if (isLast && stepRef.current) {
      stepRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
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

  // Color-coded left border accent — 3px stripe matching the step kind.
  // Guardrail refusals/approvals override with their own accent (rose/amber).
  const leftAccent = isRefusal
    ? "border-l-rose-500"
    : isApproval
      ? "border-l-amber-500"
      : step.kind === "plan"
        ? "border-l-amber-500"
        : step.kind === "tool_call"
          ? "border-l-emerald-500"
          : step.kind === "tool_result"
            ? "border-l-slate-500"
            : step.kind === "observe"
              ? "border-l-sky-500"
              : step.kind === "reflect"
                ? "border-l-emerald-500"
                : step.kind === "write_back"
                  ? "border-l-rose-500"
                  : "border-l-rose-500"; // error

  // Friendly action label for tool calls — falls back to the raw tool name.
  const actionLabel = step.toolName ? lookupToolAction(step.toolName) : null;

  // Show the typing cursor only when a live run is in progress and this is
  // the most recent PLAN step (the LLM is mid-generation).
  const showTypingCursor = Boolean(running && isLast && step.kind === "plan" && step.reasoning);

  // mcp_get_entities mini graph preview — when the tool result is a list of
  // entities (or wraps one), render chips instead of raw JSON.
  const isEntitiesResult =
    step.kind === "tool_result" &&
    (step.toolName === "mcp.get_entities" || step.toolName === "mcp_get_entities");
  const entityList = isEntitiesResult ? extractEntities(step.toolResult) : [];

  return (
    <motion.div
      ref={stepRef}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className={`rounded-l-md rounded-r-lg border border-l-4 ${leftAccent} ${overrideBorder} ${overrideBg} p-3.5 sentinel-step-card-shadow`}
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
              <span className="inline-flex items-baseline gap-1.5 min-w-0">
                {actionLabel && (
                  <span className="text-xs font-semibold text-slate-100 truncate">
                    {actionLabel.verb}
                  </span>
                )}
                <span className="text-[10px] font-mono text-slate-300 bg-slate-800/70 rounded px-1.5 py-0.5 truncate border border-slate-700/60" title={step.toolName}>
                  {step.toolName}
                </span>
              </span>
            )}
            {isWrite && step.kind === "tool_result" && !isGuardrail && (
              <span className="text-[10px] text-rose-300/80">→ write-back</span>
            )}
            <span className="ml-auto text-[10px] text-slate-600 font-mono shrink-0">
              {new Date(step.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
            </span>
          </div>

          {step.reasoning && (
            <pre className="whitespace-pre-wrap break-words text-sm text-slate-200 font-sans leading-relaxed">
              {step.reasoning}
              {showTypingCursor && <span className="sentinel-typing-cursor" aria-hidden="true">▍</span>}
            </pre>
          )}

          {step.kind === "tool_call" && step.toolArgs && (
            <JsonBlock
              value={JSON.stringify(step.toolArgs, null, 2)}
              className="mt-1"
            />
          )}

          {step.kind === "tool_result" && (
            <div className="mt-1">
              {entityList.length > 0 && !expanded && (
                <div className="mb-2">
                  <div className="flex flex-wrap gap-1.5">
                    {entityList.slice(0, 5).map((e, i) => (
                      <span key={`${e.urn ?? e.name ?? i}`} className="sentinel-entity-chip" title={e.urn ?? e.name}>
                        <Database className="h-2.5 w-2.5 shrink-0" style={{ color: platformColor(e.platform) }} />
                        <span className="sentinel-entity-chip-name">{e.name}</span>
                        {e.platform && (
                          <span className="text-slate-500 ml-0.5">· {e.platform}</span>
                        )}
                      </span>
                    ))}
                    {entityList.length > 5 && (
                      <span className="inline-flex items-center text-[10px] text-slate-500 font-mono px-1">
                        +{entityList.length - 5} more
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => setExpanded(true)}
                    className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200"
                  >
                    <ChevronDown className="h-3 w-3" /> Expand JSON
                  </button>
                </div>
              )}
              {(entityList.length === 0 || expanded) && (
                <>
                  <JsonBlock
                    value={resultJson}
                    expanded={expanded}
                    collapsible={resultIsLong}
                  />
                  {resultIsLong && entityList.length === 0 && (
                    <button
                      onClick={() => setExpanded((e) => !e)}
                      className="mt-1 inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200"
                    >
                      {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                      {expanded ? "collapse" : `expand (${resultJson.length.toLocaleString()} chars)`}
                    </button>
                  )}
                </>
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
  const allSucceeded = succeeded > 0 && failed === 0;

  return (
    <div className={`rounded-lg border p-3.5 ${
      allSucceeded
        ? "border-emerald-500/40 bg-emerald-500/5"
        : "border-rose-500/30 bg-rose-500/5"
    }`}>
      <div className="flex items-center justify-between mb-2.5">
        <h3 className="text-xs font-semibold text-rose-300 flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5" /> Write-backs
          <span className="text-slate-500 font-normal">({writebacks.length})</span>
        </h3>
        <div className="flex items-center gap-1.5 text-[10px] font-mono">
          {succeeded > 0 && (
            <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300 border border-emerald-500/40">
              <CheckCircle2 className="h-2.5 w-2.5" /> {succeeded} SUCCEEDED
            </span>
          )}
          {failed > 0 && <span className="text-rose-400">{failed} failed</span>}
        </div>
      </div>
      {/* "Written to DataHub" confirmation banner when all write-backs succeeded */}
      {allSucceeded && (
        <div className="mb-3 flex items-center gap-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[10px] text-emerald-200">
          <ShieldCheck className="h-3 w-3 text-emerald-400 shrink-0" />
          <span className="font-medium">{succeeded} post-mortem{pluralS(succeeded)} written to DataHub</span>
          <span className="text-emerald-400/70">· verified</span>
        </div>
      )}
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

function pluralS(n: number): string {
  return n === 1 ? "" : "s";
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
          : succeeded
            ? "border-emerald-500/40 bg-emerald-500/5"
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
        {/* Status badge — prominently green when SUCCEEDED */}
        <span
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider font-semibold ${
            succeeded
              ? "bg-emerald-500/20 text-emerald-200 border border-emerald-500/50 shadow-sm shadow-emerald-900/30"
              : "bg-rose-500/20 text-rose-200 border border-rose-500/50"
          }`}
          title={succeeded ? "Write-back succeeded — verified by DataHub" : "Write-back failed on both paths"}
        >
          {succeeded ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
          {succeeded ? "SUCCEEDED" : writeback.status.toUpperCase()}
        </span>
        <span className="ml-auto text-[10px] text-slate-500 font-mono">{writeback.kind}</span>
      </div>

      {title && <div className="text-xs text-slate-200 font-medium truncate mb-1" title={title}>{title}</div>}

      {/* "Written to DataHub" confirmation banner — only when succeeded */}
      {succeeded && (
        <div className="mb-1.5 flex items-center gap-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-200">
          <ShieldCheck className="h-3 w-3 text-emerald-400 shrink-0" />
          <span className="font-medium">Written to DataHub</span>
          <span className="text-emerald-400/70">· verified</span>
        </div>
      )}

      {writeback.datahubUrn ? (
        <div className="flex items-center gap-1.5 text-[10px] font-mono">
          <span className="text-slate-500 shrink-0">URN:</span>
          <button
            onClick={copyUrn}
            className="flex items-center gap-1.5 text-slate-300 hover:text-emerald-300 transition-colors min-w-0 flex-1 text-left"
            title="Click to copy URN"
          >
            <span className="truncate">{writeback.datahubUrn}</span>
            {copied ? <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" /> : <Copy className="h-3 w-3 shrink-0 opacity-60" />}
          </button>
          {copied && <span className="text-emerald-400 text-[9px] shrink-0">copied!</span>}
        </div>
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
    <section className={`rounded-xl border border-slate-800 bg-slate-900/40 p-4 premium-card sentinel-glass ${running ? "sentinel-metrics-glow" : ""}`}>
      <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
        <Activity className="h-4 w-4 text-emerald-400" /> Live metrics
      </h2>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Incidents" value={String(historyCount)} icon={Radar} spark={historyCount} />
        <Stat label="Reasoning steps" value={String(result?.steps.length ?? 0)} icon={BrainCircuit} spark={result?.steps.length ?? 0} />
        <Stat label="Prompt tokens" value={tokens ? tokens.promptTokens.toLocaleString() : "awaiting…"} icon={BookOpen} spark={tokens?.promptTokens ?? 0} />
        <Stat label="Completion tokens" value={tokens ? tokens.completionTokens.toLocaleString() : "awaiting…"} icon={Zap} spark={tokens?.completionTokens ?? 0} />
        <Stat label="Total tokens" value={total ? total.toLocaleString() : "awaiting…"} icon={Activity} highlight spark={total} />
        <Stat label="LLM model" value={result?.llmModel ?? "awaiting…"} icon={Database} mono />
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
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 premium-card sentinel-glass" data-tour="connectors">
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
      <ConnectorQuickActions githubRepo={status.github.repo} slackChannel={status.slack.channel} />
    </section>
  );
}

// ConnectorQuickActions — three small ghost buttons at the bottom of the
// ConnectorStatusCard. Copy URN copies `urn:li:incident:sentinel:latest`
// to the clipboard (with a checkmark confirmation). Open GitHub / Open
// Slack are visual-only links that point at the configured repo + channel.
function ConnectorQuickActions({
  githubRepo,
  slackChannel,
}: {
  githubRepo: string;
  slackChannel: string;
}) {
  const [copied, setCopied] = useState(false);
  function copyUrn() {
    navigator.clipboard?.writeText("urn:li:incident:sentinel:latest").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-slate-800/60 pt-2.5">
      <button
        type="button"
        onClick={copyUrn}
        className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900/60 px-2 py-1 text-[10px] font-mono text-slate-300 hover:bg-slate-800/60 hover:border-emerald-500/40 hover:text-emerald-300 transition-colors"
        title="Copy incident URN to clipboard"
      >
        {copied ? <CheckCircle2 className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
        {copied ? "Copied" : "Copy URN"}
      </button>
      <a
        href={`https://github.com/${githubRepo}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900/60 px-2 py-1 text-[10px] font-mono text-slate-300 hover:bg-slate-800/60 hover:border-emerald-500/40 hover:text-emerald-300 transition-colors"
        title={`Open ${githubRepo} on GitHub`}
      >
        <Github className="h-3 w-3" /> Open GitHub
      </a>
      <a
        href={`https://slack.com/app_redirect?channel=${encodeURIComponent(slackChannel)}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900/60 px-2 py-1 text-[10px] font-mono text-slate-300 hover:bg-slate-800/60 hover:border-emerald-500/40 hover:text-emerald-300 transition-colors"
        title={`Open Slack channel #${slackChannel}`}
      >
        <Slack className="h-3 w-3" /> Open Slack
      </a>
    </div>
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
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 premium-card" data-tour="performance-analytics">
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
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 premium-card sentinel-glass" data-tour="performance-analytics">
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

function DataHubHealthPanel({ lastLiveWritebackTitle }: { lastLiveWritebackTitle?: string | null }) {
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
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
        <span className="text-xs text-emerald-300 font-semibold">Connected</span>
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
          <span className="text-[10px] font-mono font-bold text-emerald-300">{assertionsPassing} passing</span>
          {assertionsFailing > 0 && (
            <span className="text-[10px] font-mono font-bold text-rose-400">{assertionsFailing} failing</span>
          )}
        </div>
        <div className="flex h-2.5 rounded-full overflow-hidden bg-slate-800 mt-1.5">
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
          {lastLiveWritebackTitle ?? lastWriteback?.title ?? "No write-backs yet"}
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
      <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 py-2.5 flex flex-wrap items-center gap-3 text-xs">
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
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 premium-card sentinel-glass">
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
          <div className="sentinel-empty-state sentinel-empty-state-border py-6">
            <Radar className="sentinel-empty-state-icon h-6 w-6" />
            <span className="sentinel-empty-state-text">No incidents yet. Inject a signal to create the first.</span>
          </div>
        )}
        {items.map((it) => (
          <button
            key={it.urn}
            onClick={() => onView(it.urn)}
            className={`w-full text-left rounded-md p-2.5 mb-1 transition-colors border sentinel-incident-card-accent ${
              viewingUrn === it.urn
                ? "border-emerald-500/40 bg-emerald-500/5"
                : "border-transparent hover:bg-slate-800/40"
            }`}
            data-status={it.status}
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
    <div className="hidden md:inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1 tabular-nums min-w-0 max-w-[320px] group/chip relative" title={`${label}: ${value}`}>
      <Icon className="h-3 w-3 text-slate-500 shrink-0" />
      <span className="text-slate-500 shrink-0">{label}</span>
      <span className={`text-slate-300 min-w-0 truncate ${mono ? "font-mono" : ""}`} title={value}>{value}</span>
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
  liveWritebacks = [],
}: {
  writebacks: Array<{ id: string; kind: string; datahubUrn: string | null; status: string; path: string; dataJson: string; ts: string }>;
  liveWritebacks?: Array<{ step: number; kind: string; toolName?: string; toolArgs?: Record<string, unknown>; toolResult?: unknown; reasoning?: string; ts: string }>;
}) {
  // Convert live write-backs (from the current run result) to the same shape
  // as persisted write-backs so they render in the panel immediately.
  const liveAsPanel = liveWritebacks.map((s, i) => {
    const tr = (s.toolResult ?? {}) as Record<string, unknown>;
    const status = tr.status === "succeeded" ? "succeeded" : tr.status === "failed" ? "failed" : "succeeded";
    return {
      id: `live-${i}-${s.ts}`,
      kind: s.toolName ?? "ack.save_document",
      datahubUrn: (tr.urn as string) ?? null,
      status,
      path: (tr.path as string) ?? "/live",
      dataJson: JSON.stringify(tr),
      ts: s.ts,
    };
  });
  const allWritebacks = [...liveAsPanel, ...writebacks];

  if (allWritebacks.length === 0) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 premium-card sentinel-glass">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
            <FileText className="h-4 w-4 text-rose-400" /> Write-backs detail
          </h2>
        </div>
        <div className="p-3">
          <div className="sentinel-empty-state sentinel-empty-state-border">
            <FileText className="sentinel-empty-state-icon h-6 w-6" />
            <span className="sentinel-empty-state-text">No write-backs yet. Run a signal to see write-back actions here.</span>
          </div>
        </div>
      </section>
    );
  }

  const succeeded = allWritebacks.filter((w) => w.status === "succeeded").length;
  const failed = allWritebacks.filter((w) => w.status === "failed").length;
  const allSucceeded = succeeded > 0 && failed === 0;

  return (
    <section className={`rounded-xl border premium-card sentinel-glass ${
      allSucceeded
        ? "border-emerald-500/40"
        : "border-slate-800"
    } bg-slate-900/40`}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
          <FileText className="h-4 w-4 text-rose-400" /> Write-backs detail
          <span className="text-slate-500 font-normal">({allWritebacks.length})</span>
        </h2>
        <div className="flex items-center gap-1.5 text-[10px] font-mono">
          {succeeded > 0 && (
            <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300 border border-emerald-500/40">
              <CheckCircle2 className="h-2.5 w-2.5" /> {succeeded} SUCCEEDED
            </span>
          )}
          {failed > 0 && <span className="text-rose-400">{failed} failed</span>}
        </div>
      </div>
      {/* "Written to DataHub" confirmation banner when all write-backs succeeded */}
      {allSucceeded && (
        <div className="mx-3 mt-3 flex items-center gap-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[10px] text-emerald-200">
          <ShieldCheck className="h-3 w-3 text-emerald-400 shrink-0" />
          <span className="font-medium">{succeeded} post-mortem{pluralS(succeeded)} written to DataHub</span>
          <span className="text-emerald-400/70">· verified</span>
        </div>
      )}
      <div className="max-h-72 overflow-y-auto custom-scroll p-2 space-y-2">
        {allWritebacks.map((w) => (
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
            ? "border-emerald-500/40 bg-emerald-500/5"
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
        {/* Status badge — prominent green SUCCEEDED */}
        <span
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider font-semibold ${
            succeeded
              ? "bg-emerald-500/20 text-emerald-200 border border-emerald-500/50 shadow-sm shadow-emerald-900/30"
              : "bg-rose-500/20 text-rose-200 border border-rose-500/50"
          }`}
          title={succeeded ? "Write-back succeeded — verified by DataHub" : "Write-back failed"}
        >
          {succeeded ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
          {succeeded ? "SUCCEEDED" : writeback.status.toUpperCase()}
        </span>
        <span className="ml-auto text-[10px] text-slate-600 font-mono">
          {new Date(writeback.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
        </span>
      </div>

      {/* "Written to DataHub" confirmation banner — only when succeeded */}
      {succeeded && (
        <div className="mb-2 flex items-center gap-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-200">
          <ShieldCheck className="h-3 w-3 text-emerald-400 shrink-0" />
          <span className="font-medium">Written to DataHub</span>
          <span className="text-emerald-400/70">· verified</span>
        </div>
      )}

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

      {/* DataHub URN — prominent, with explicit "URN:" label + copy button */}
      {writeback.datahubUrn && (
        <div className="mt-1 flex items-center gap-1.5 text-[10px] font-mono rounded border border-slate-700/50 bg-slate-900/40 px-2 py-1">
          <span className="text-slate-500 shrink-0 uppercase tracking-wider">URN:</span>
          <div className="flex-1 min-w-0">
            <CopyableUrn value={writeback.datahubUrn} />
          </div>
        </div>
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
    // Persisted write-backs (viewedIncident) OR live write-back steps in result.steps
    const hasWritebacks =
      (viewedIncident?.writebacks?.length ?? 0) > 0 ||
      steps.some((s) => s.kind === "write_back" || s.toolName === "ack.save_document");
    // Persisted actions OR live action.* tool_call steps
    const hasActions =
      (viewedIncident?.actions?.length ?? 0) > 0 ||
      steps.some(
        (s) => s.kind === "tool_call" && (s.toolName?.startsWith("action.") || s.toolName?.startsWith("action_")),
      );
    // Terminal states. "degraded" is also terminal — the deterministic
    // fallback resolves the incident but tags it degraded when the LLM was
    // unavailable. Treat it the same as "resolved" for the progress bar so
    // the RESOLVED stage gets its green checkmark.
    const incidentStatus = viewedIncident?.incident?.status ?? result?.incident?.status;
    const isResolved = incidentStatus === "resolved" || incidentStatus === "degraded";
    const isFailed = incidentStatus === "failed";

    // When the run is complete and we have a result, force-mark every stage
    // up to RESOLVED as completed if the incident reached a terminal state.
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

  // Per-stage elapsed times (seconds). For a resolved/viewed incident, we
  // derive each stage's duration from the reasoning-step timestamps. For a
  // live run, the CURRENT stage shows the live `elapsed` counter; pending +
  // un-derivable stages show "—".
  const stageTimes = useMemo((): Partial<Record<StageKey, number>> => {
    const steps = viewedIncident?.incident.reasoningSteps ?? result?.steps ?? [];
    if (steps.length === 0) return {};
    const ts = (predicate: (s: ReasoningStep) => boolean) => {
      const s = steps.find(predicate);
      return s ? new Date(s.ts).getTime() : null;
    };
    const firstTs = new Date(steps[0].ts).getTime();
    const lastTs = new Date(steps[steps.length - 1].ts).getTime();
    const triageTs = ts((s) => s.kind === "plan" || s.kind === "observe" || s.kind === "reflect" || s.kind === "tool_call");
    const actionsTs = ts((s) => s.kind === "tool_call" && (s.toolName?.startsWith("action.") || s.toolName?.startsWith("action_")));
    const writebacksTs = ts((s) => s.kind === "write_back");
    const out: Partial<Record<StageKey, number>> = {};
    if (triageTs && triageTs > firstTs) out.signal = (triageTs - firstTs) / 1000;
    if (triageTs && actionsTs && actionsTs > triageTs) out.triage = (actionsTs - triageTs) / 1000;
    if (actionsTs && writebacksTs && writebacksTs > actionsTs) out.actions = (writebacksTs - actionsTs) / 1000;
    if (writebacksTs && lastTs && lastTs > writebacksTs) out.writebacks = (lastTs - writebacksTs) / 1000;
    const incidentStatus = viewedIncident?.incident?.status ?? result?.incident?.status;
    if ((incidentStatus === "resolved" || incidentStatus === "degraded") && lastTs > firstTs) {
      out.resolved = (lastTs - firstTs) / 1000;
    }
    return out;
  }, [result, viewedIncident]);

  function stageElapsedLabel(stageKey: StageKey): string {
    // Live counter takes precedence for the current stage while running.
    if (running && currentStage === stageKey) return `${elapsed.toFixed(1)}s`;
    const t = stageTimes[stageKey];
    if (typeof t === "number" && t > 0) return `${t.toFixed(1)}s`;
    return "—";
  }

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
        {!running &&
          (result?.incident?.status === "resolved" ||
            viewedIncident?.incident?.status === "resolved") && (
            <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-emerald-300">
              <CheckCircle2 className="h-3 w-3" /> resolved
            </span>
          )}
        {!running &&
          (result?.incident?.status === "degraded" ||
            viewedIncident?.incident?.status === "degraded") && (
            <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-amber-300">
              <CheckCircle2 className="h-3 w-3" /> degraded (auto-resolved)
            </span>
          )}
        {!running &&
          (result?.incident?.status === "failed" ||
            viewedIncident?.incident?.status === "failed") && (
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
                <span
                  className={`text-[9px] font-mono tabular-nums whitespace-nowrap ${
                    isPending ? "text-slate-700" : isCurrent ? "text-amber-400/80" : "text-slate-500"
                  }`}
                  title={`Elapsed: ${stageElapsedLabel(stage.key)}`}
                >
                  {stageElapsedLabel(stage.key)}
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
      className="rounded-xl border border-slate-800 bg-gradient-to-br from-slate-900/80 to-slate-900/40 p-5 premium-card sentinel-incident-card"
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
            const isRootEdge = nodes.find(n => n.urn === e.from)?.degree === 0;
            const stroke = isActiveEdge ? "#f59e0b" : isTraversed ? "#fbbf24" : isRootEdge ? "#f87171" : "#64748b";
            const width = isActiveEdge ? 2.5 : isTraversed ? 2 : 1.75;
            const markerId = isActiveEdge ? "url(#arrowhead-active)" : isTraversed ? "url(#arrowhead-traversed)" : isRootEdge ? "url(#arrowhead-root)" : "url(#arrowhead)";
            return (
              <g key={`e-${i}`}>
                <path
                  d={edgePath(e.from, e.to)}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={width}
                  strokeDasharray={isActiveEdge ? "0" : isTraversed ? "0" : "8 4"}
                  opacity={isActiveEdge ? 1 : isTraversed ? 0.9 : 0.75}
                  markerEnd={markerId}
                  className={isActiveEdge ? "animate-pulse" : running ? "sentinel-edge-flow" : ""}
                />
              </g>
            );
          })}
          {/* Arrowhead markers */}
          <defs>
            <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L6,3 L0,6 Z" fill="#64748b" />
            </marker>
            <marker id="arrowhead-active" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L6,3 L0,6 Z" fill="#f59e0b" />
            </marker>
            <marker id="arrowhead-traversed" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L6,3 L0,6 Z" fill="#fbbf24" />
            </marker>
            <marker id="arrowhead-root" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L6,3 L0,6 Z" fill="#f87171" />
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
  onPreviewAction,
}: {
  result: RunResult | null;
  viewedIncident: HydratedIncident | null;
  onPreviewAction?: (a: { kind: "github_issue" | "slack_message" | "github_pr"; payload: Record<string, unknown> }) => void;
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

  // Actions taken — extract from tool_call steps. Each action includes its
  // kind + payload so the action chip can open a preview modal.
  // Handles both naming conventions: dot (github.openIssue) and underscore
  // (action.github_open_issue). The issue number comes from the tool_result
  // (the next step), not toolArgs.
  const actionsTaken: Array<{ label: string; kind: "github_issue" | "slack_message" | "github_pr"; payload: Record<string, unknown> }> = [];
  for (let i = 0; i < result.steps.length; i++) {
    const s = result.steps[i];
    if (s.kind !== "tool_call" || !s.toolName) continue;
    const name = s.toolName.toLowerCase();
    const payload = (s.toolArgs as Record<string, unknown>) ?? {};
    // Look ahead to the next step (tool_result) for the issue number / url
    const nextStep = result.steps[i + 1];
    const resultPayload = (nextStep?.toolResult as Record<string, unknown>) ?? {};

    if (name === "github.openissue" || name === "action.github.openissue" || name === "action.github_open_issue") {
      const num = (resultPayload.number as number | undefined) ?? (payload.number as number | undefined);
      actionsTaken.push({ label: `GitHub issue #${num ?? "?"} opened`, kind: "github_issue", payload: { ...payload, ...resultPayload } });
    } else if (name === "slack.postmessage" || name === "action.slack.postmessage" || name === "action.slack_post_triage") {
      actionsTaken.push({ label: "Slack triage posted", kind: "slack_message", payload: { ...payload, ...resultPayload } });
    } else if (name === "github.openpr" || name === "action.github.openpr" || name === "action.github_open_pr") {
      actionsTaken.push({ label: "Remediation PR opened", kind: "github_pr", payload: { ...payload, ...resultPayload } });
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
            {result.actualProvider && result.actualProvider !== result.llmProvider && ` → ${publicProviderName(result.actualProvider)} (failover)`}
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
          <div className="text-[10px] font-mono uppercase tracking-wider text-amber-300 mb-2">
            Actions taken{onPreviewAction ? " (click to preview)" : ""}
          </div>
          <div className="flex flex-wrap gap-2">
            {actionsTaken.map((a, i) => (
              <button
                key={i}
                onClick={() => onPreviewAction?.({ kind: a.kind, payload: a.payload })}
                disabled={!onPreviewAction}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1 text-xs font-mono text-amber-200 hover:bg-amber-500/15 hover:border-amber-500/50 transition-colors disabled:cursor-default disabled:hover:bg-amber-500/5 disabled:hover:border-amber-500/30"
                title={onPreviewAction ? `Preview ${a.label}` : a.label}
              >
                <Send className="h-3 w-3 text-amber-400" /> {a.label}
                {onPreviewAction && <Eye className="h-3 w-3 text-amber-400/60" />}
              </button>
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
        <span className="text-slate-300">{publicProviderName(result?.actualProvider ?? result?.llmProvider) ?? "gemini"}</span>
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
      className="flex items-center gap-1.5 text-[10px] text-slate-500 font-mono hover:text-emerald-300 transition-colors w-full min-w-0 text-left"
      title="Click to copy URN"
    >
      <span className="truncate">{value}</span>
      {copied
        ? <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
        : <Copy className="h-3 w-3 shrink-0 opacity-60" />}
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
              <ShortcutRow keys={["T"]} label="Start demo tour" />
              <ShortcutRow keys={["D"]} label="Toggle demo mode" />
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
        { keys: ["T"], desc: "Start demo tour — step-by-step dashboard walkthrough" },
        { keys: ["D"], desc: "Toggle demo mode — auto-inject signal every 60s" },
        { keys: ["A"], desc: "Toggle audit log drawer" },
        { keys: ["S"], desc: "Toggle runtime config (settings) drawer" },
        { keys: ["L"], desc: "Toggle system log terminal at the bottom" },
        { keys: ["V"], desc: "Toggle Engineer / Manager view" },
        { keys: ["Esc"], desc: "Close any open overlay / drawer / preview" },
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

// ---------------------------------------------------------------------------
// Cost & Efficiency Panel — estimated time saved, token cost, ROI metrics.
// Sits in the right column between MetricsCard and PerformanceAnalytics.
// Hackathons love ROI numbers — this panel quantifies Sentinel's value.
// ---------------------------------------------------------------------------

// Rough cost estimates (per 1M tokens) for the public providers.
// Used to estimate the $ cost of each run. Conservative, public pricing.
const LLM_COST_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  "gemini-2.0-flash": { input: 0.075, output: 0.30 },
  "gemini-2.5-flash": { input: 0.075, output: 0.30 },
  "gemini-1.5-flash": { input: 0.075, output: 0.30 },
  "groq-llama-3.3-70b": { input: 0.59, output: 0.79 },
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
};

// Estimated minutes a human data engineer would spend triaging the same
// incident manually (fetch asset, traverse lineage, read post-mortems,
// draft GitHub issue, post Slack card, write post-mortem). Conservative.
const HUMAN_TRIAGE_MINUTES = 47;

function CostEfficiencyPanel({
  result,
  incidents,
}: {
  result: RunResult | null;
  incidents: IncidentListItem[];
}) {
  // Token cost for the current run
  const tokens = result?.totalTokens;
  const model = result?.llmModel ?? "gemini-2.0-flash";
  const pricing = LLM_COST_PER_1M_TOKENS[model] ?? LLM_COST_PER_1M_TOKENS["gemini-2.0-flash"];
  const runCost = tokens
    ? (tokens.promptTokens / 1_000_000) * pricing.input +
      (tokens.completionTokens / 1_000_000) * pricing.output
    : null;

  // Resolution time for the current run
  const created = result?.incident?.createdAt ? new Date(result.incident.createdAt).getTime() : 0;
  const resolved = result?.incident?.resolvedAt ? new Date(result.incident.resolvedAt).getTime() : 0;
  const runSeconds = resolved && created ? (resolved - created) / 1000 : null;

  // Time saved = human triage time - agent run time (in minutes)
  const agentMinutes = runSeconds ? runSeconds / 60 : null;
  const timeSaved = agentMinutes !== null ? Math.max(0, HUMAN_TRIAGE_MINUTES - agentMinutes) : null;

  // Aggregate cost across all incidents (sum of token costs — approximated
  // using the avg steps per incident as a proxy since we don't have per-incident tokens)
  const totalIncidents = incidents.length;
  const resolvedCount = incidents.filter((i) => i.status === "resolved").length;
  const totalAgentMinutes = totalIncidents > 0 ? (incidents.reduce((sum, i) => {
    const c = i.createdAt ? new Date(i.createdAt).getTime() : 0;
    const r = i.resolvedAt ? new Date(i.resolvedAt).getTime() : 0;
    return sum + (r && c ? (r - c) / 1000 / 60 : 0);
  }, 0)) : 0;
  const totalTimeSaved = totalIncidents > 0 ? totalIncidents * HUMAN_TRIAGE_MINUTES - totalAgentMinutes : 0;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 premium-card sentinel-glass" data-tour="cost-efficiency">
      <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2 mb-3">
        <DollarSign className="h-4 w-4 text-emerald-400" /> Cost &amp; Efficiency
      </h2>

      {/* Current run ROI */}
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 mb-3">
        <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-400 mb-2">Current run</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-[9px] font-mono uppercase tracking-wider text-slate-500 mb-0.5">Est. time saved</div>
            <div className="font-mono text-lg font-bold text-emerald-300 tabular-nums sentinel-cost-value" key={timeSaved?.toFixed(0)}>
              {timeSaved !== null ? `${timeSaved.toFixed(0)}m` : <span className="sentinel-metric-awaiting">awaiting…</span>}
            </div>
          </div>
          <div>
            <div className="text-[9px] font-mono uppercase tracking-wider text-slate-500 mb-0.5">LLM cost</div>
            <div className="font-mono text-lg font-bold text-slate-100 tabular-nums sentinel-cost-value" key={runCost?.toFixed(4)}>
              {runCost !== null ? `$${runCost.toFixed(4)}` : <span className="sentinel-metric-awaiting">awaiting…</span>}
            </div>
          </div>
        </div>
        {timeSaved !== null && runCost !== null && (
          <div className="mt-2 text-[10px] text-emerald-300/80 font-mono leading-relaxed">
            ROI: {timeSaved > 0 ? `${(timeSaved * 60 / Math.max(runCost, 0.0001)).toFixed(0)}× return` : "breakeven"} ·
            human triage est. {HUMAN_TRIAGE_MINUTES}m @ $75/hr vs agent {agentMinutes?.toFixed(1)}m @ ${runCost.toFixed(4)}
          </div>
        )}
      </div>

      {/* Cumulative metrics */}
      <div className="space-y-2">
        <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Cumulative</div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-slate-400">Total time saved</span>
            <span className="font-mono text-sm font-bold text-emerald-300 tabular-nums">
              {totalTimeSaved > 0 ? `${totalTimeSaved.toFixed(0)}m` : "—"}
            </span>
          </div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-slate-400">Incidents resolved</span>
            <span className="font-mono text-sm font-bold text-slate-100 tabular-nums">
              {resolvedCount}/{totalIncidents}
            </span>
          </div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-slate-400">Avg agent time</span>
            <span className="font-mono text-sm font-bold text-amber-300 tabular-nums">
              {totalIncidents > 0 ? `${(totalAgentMinutes / totalIncidents).toFixed(1)}m` : "—"}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3 text-[10px] text-slate-600 font-mono leading-relaxed">
        Time saved vs. manual human triage (fetch asset, traverse lineage,
        read post-mortems, draft issue, post Slack, write post-mortem).
        Costs based on public provider pricing.
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Explainable AI Panel — collapsible "Why this action?" showing the
// governance policy rules that were evaluated + the LLM's reasoning chain.
// Sits in the left column after the ReasoningStream.
// ---------------------------------------------------------------------------

const XAI_GUARDRAIL_RULES = [
  {
    id: "G-01",
    rule: "Refuse writes to PII-tagged assets",
    detail: "Any ack.* write to an asset tagged PII or Restricted is refused before the LLM sees the result. Enforced in src/lib/guardrail/pii-check.ts.",
    triggered: false,
  },
  {
    id: "G-02",
    rule: "Gate ownership/glossary proposals behind human approval",
    detail: "ack.update_ownership and ack.add_glossary_terms create a pending approval (not a direct write). An operator must approve or deny via /api/guardrail/approve.",
    triggered: false,
  },
  {
    id: "G-03",
    rule: "Never delete catalog entities",
    detail: "ack.* write tools have no delete capability. The tool interface makes destructive writes impossible regardless of LLM output.",
    triggered: false,
  },
  {
    id: "G-04",
    rule: "Cap write-back payload size at 32KB",
    detail: "Post-mortems and other ack.save_document payloads exceeding 32KB are truncated + flagged. Prevents context-graph bloat.",
    triggered: false,
  },
];

function ExplainableAIPanel({
  result,
  viewedIncident,
}: {
  result: RunResult | null;
  viewedIncident: HydratedIncident | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const steps = viewedIncident?.incident.reasoningSteps ?? result?.steps ?? [];

  // Only show when there are steps to explain
  if (steps.length === 0) return null;

  // Detect which guardrail rules were triggered in this run
  const rules = XAI_GUARDRAIL_RULES.map((r) => {
    let triggered = false;
    for (const s of steps) {
      const tr = s.toolResult as Record<string, unknown> | undefined;
      if (s.toolResult && typeof s.toolResult === "object" && tr?.guardrail === true) {
        if (r.id === "G-01" && tr?.decision === "refuse") triggered = true;
        if (r.id === "G-02" && tr?.decision === "needs_approval") triggered = true;
      }
      // Detect write-backs (G-03/G-04 are always "triggered" as enforced policies)
      if ((s.kind === "write_back" || s.toolName === "ack.save_document") && (r.id === "G-03" || r.id === "G-04")) {
        triggered = true;
      }
    }
    return { ...r, triggered };
  });

  // Extract the key reasoning steps (plan + reflect) for the "why" chain
  const reasoningChain = steps
    .filter((s) => s.kind === "plan" || s.kind === "reflect" || (s.reasoning && s.reasoning.length > 20))
    .slice(0, 5)
    .map((s) => ({
      kind: s.kind,
      reasoning: s.reasoning ?? "",
      toolName: s.toolName,
    }));

  const triggeredCount = rules.filter((r) => r.triggered).length;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 premium-card overflow-hidden">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-5 py-3 border-b border-slate-800 hover:bg-slate-800/30 transition-colors"
        aria-expanded={expanded}
      >
        <HelpCircle className="h-4 w-4 text-emerald-400" />
        <h2 className="text-sm font-semibold text-slate-200">Why this action? — Explainable AI</h2>
        <span className="ml-auto flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-mono text-emerald-300">
            {triggeredCount} rule{triggeredCount !== 1 ? "s" : ""} applied
          </span>
          <span className="text-[10px] font-mono text-slate-500">{reasoningChain.length} reasoning steps</span>
          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-slate-500" /> : <ChevronUp className="h-3.5 w-3.5 text-slate-500" />}
        </span>
      </button>
      {expanded && (
        <div className="sentinel-xai-body px-5 py-4 space-y-4">
          {/* Governance rules */}
          <div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-2">Governance policy rules evaluated</div>
            <div className="space-y-1.5">
              {rules.map((r) => (
                <div key={r.id} className={`sentinel-xai-rule ${r.triggered ? "border-emerald-500/30 bg-emerald-500/5" : ""}`}>
                  <span className="sentinel-xai-rule-id">{r.id}</span>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-slate-200 flex items-center gap-2">
                      {r.rule}
                      {r.triggered && (
                        <span className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-mono text-emerald-300">
                          <CheckCircle2 className="h-2.5 w-2.5" /> applied
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">{r.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Reasoning chain */}
          {reasoningChain.length > 0 && (
            <div>
              <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-2">LLM reasoning chain (key steps)</div>
              <div className="space-y-2">
                {reasoningChain.map((s, i) => (
                  <div key={i} className="rounded-md border border-slate-800 bg-slate-900/40 p-2.5">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[9px] font-mono uppercase tracking-wider text-amber-300">{s.kind}</span>
                      {s.toolName && (
                        <span className="text-[10px] font-mono text-slate-500">→ {s.toolName}</span>
                      )}
                    </div>
                    {s.reasoning && (
                      <div className="text-[11px] text-slate-400 leading-relaxed line-clamp-3">{s.reasoning}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="text-[10px] text-slate-600 font-mono leading-relaxed">
            Every action Sentinel takes is governed by code-level rules in{" "}
            <code className="text-slate-400">src/lib/guardrail/</code> — not prompt-level instructions.
            The LLM cannot bypass these checks regardless of its output.
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Manager Summary — high-level summary shown only in Manager view.
// Hides the technical reasoning stream / lineage graph / timeline and shows
// only: status, actions taken, ROI, and a plain-English summary.
// ---------------------------------------------------------------------------

function ManagerSummary({
  result,
  viewedIncident,
  onPreviewAction,
}: {
  result: RunResult | null;
  viewedIncident: HydratedIncident | null;
  onPreviewAction: (a: { kind: "github_issue" | "slack_message" | "github_pr"; payload: Record<string, unknown> }) => void;
}) {
  if (!result && !viewedIncident) return null;

  const steps = viewedIncident?.incident.reasoningSteps ?? result?.steps ?? [];
  const status = viewedIncident?.incident.status ?? result?.incident?.status ?? "unknown";
  const isResolved = status === "resolved";
  const isDegraded = status === "degraded";

  // Extract actions — handles both naming conventions (dot + underscore)
  const actions: Array<{ kind: string; toolName: string; payload: Record<string, unknown> }> = [];
  for (const s of steps) {
    if (s.kind === "tool_call" && s.toolName) {
      const name = s.toolName.toLowerCase();
      if (name === "github.openissue" || name === "action.github.openissue" || name === "action.github_open_issue") {
        actions.push({ kind: "github_issue", toolName: s.toolName, payload: (s.toolArgs as Record<string, unknown>) ?? {} });
      } else if (name === "slack.postmessage" || name === "action.slack.postmessage" || name === "action.slack_post_triage") {
        actions.push({ kind: "slack_message", toolName: s.toolName, payload: (s.toolArgs as Record<string, unknown>) ?? {} });
      } else if (name === "github.openpr" || name === "action.github.openpr" || name === "action.github_open_pr") {
        actions.push({ kind: "github_pr", toolName: s.toolName, payload: (s.toolArgs as Record<string, unknown>) ?? {} });
      }
    }
  }

  // Write-backs count
  const writebacks = steps.filter((s) => s.kind === "write_back" || s.toolName === "ack.save_document").length;

  // Resolution time
  const created = result?.incident?.createdAt ? new Date(result.incident.createdAt).getTime() : 0;
  const resolved = result?.incident?.resolvedAt ? new Date(result.incident.resolvedAt).getTime() : 0;
  const resolutionTime = resolved && created ? ((resolved - created) / 1000).toFixed(1) : null;

  const statusColor = isResolved
    ? { text: "text-emerald-300", bg: "bg-emerald-500/10", border: "border-emerald-500/30", icon: CheckCircle2 }
    : isDegraded
      ? { text: "text-amber-300", bg: "bg-amber-500/10", border: "border-amber-500/30", icon: AlertTriangle }
      : { text: "text-rose-300", bg: "bg-rose-500/10", border: "border-rose-500/30", icon: XCircle };
  const StatusIcon = statusColor.icon;

  return (
    <section className="sentinel-manager-summary rounded-xl border border-slate-800 bg-slate-900/40 p-5 premium-card">
      <div className="flex items-center gap-2 mb-4">
        <LayoutDashboard className="h-4 w-4 text-emerald-400" />
        <h2 className="text-sm font-semibold text-slate-200">Executive Summary</h2>
        <span className="ml-auto text-[10px] font-mono text-slate-500">manager view</span>
      </div>

      {/* Status banner */}
      <div className={`rounded-lg border ${statusColor.border} ${statusColor.bg} p-4 mb-4`}>
        <div className="flex items-center gap-3">
          <StatusIcon className={`h-6 w-6 ${statusColor.text}`} />
          <div>
            <div className={`text-base font-bold ${statusColor.text} uppercase tracking-wide`}>
              {isResolved ? "Incident Resolved" : isDegraded ? "Incident Degraded" : "Incident Failed"}
            </div>
            <div className="text-xs text-slate-400 mt-0.5">
              {resolutionTime ? `Resolved in ${resolutionTime}s` : "In progress"} ·
              {" "}{actions.length} action{actions.length !== 1 ? "s" : ""} taken ·
              {" "}{writebacks} write-back{writebacks !== 1 ? "s" : ""}
            </div>
          </div>
        </div>
      </div>

      {/* Plain-English summary */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 mb-4">
        <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-2">What happened</div>
        <p className="text-sm text-slate-300 leading-relaxed">
          Sentinel detected a data quality assertion failure, autonomously investigated the root cause
          by traversing the data lineage graph in DataHub, then{" "}
          {actions.length > 0
            ? `took ${actions.length} corrective action${actions.length !== 1 ? "s" : ""} (filed a GitHub issue and posted a Slack triage card)`
            : "logged the investigation"}{" "}
          and{" "}
          {writebacks > 0
            ? `wrote ${writebacks} structured post-mortem${writebacks !== 1 ? "s" : ""} back to DataHub so the next incident is faster`
            : "recorded the result"}.
          {" "}The entire investigation was governed by code-level guardrails — no destructive writes were possible.
        </p>
      </div>

      {/* Actions taken (clickable to preview) */}
      {actions.length > 0 && (
        <div className="mb-4">
          <div className="text-[10px] font-mono uppercase tracking-wider text-amber-300 mb-2">Actions taken (click to preview)</div>
          <div className="flex flex-wrap gap-2">
            {actions.map((a, i) => {
              const isGitHub = a.kind === "github_issue";
              const isSlack = a.kind === "slack_message";
              const isPR = a.kind === "github_pr";
              const Icon = isGitHub ? Github : isSlack ? Slack : GitPullRequest;
              const label = isGitHub
                ? `GitHub issue #${a.payload.number ?? "?"}`
                : isSlack
                  ? "Slack triage card"
                  : "Remediation PR";
              return (
                <button
                  key={i}
                  onClick={() => onPreviewAction({ kind: a.kind as "github_issue" | "slack_message" | "github_pr", payload: a.payload })}
                  className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-xs font-mono text-amber-200 hover:bg-amber-500/15 hover:border-amber-500/50 transition-colors"
                  title={`Preview ${label}`}
                >
                  <Icon className="h-3 w-3 text-amber-400" /> {label}
                  <Eye className="h-3 w-3 text-amber-400/60" />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Business impact */}
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
        <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-400 mb-2">Business impact</div>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="text-[9px] font-mono uppercase tracking-wider text-slate-500 mb-0.5">Est. time saved</div>
            <div className="font-mono text-base font-bold text-emerald-300 tabular-nums">{HUMAN_TRIAGE_MINUTES}m</div>
          </div>
          <div>
            <div className="text-[9px] font-mono uppercase tracking-wider text-slate-500 mb-0.5">Agent time</div>
            <div className="font-mono text-base font-bold text-slate-100 tabular-nums">{resolutionTime ? `${(Number(resolutionTime) / 60).toFixed(1)}m` : "—"}</div>
          </div>
          <div>
            <div className="text-[9px] font-mono uppercase tracking-wider text-slate-500 mb-0.5">Human cost</div>
            <div className="font-mono text-base font-bold text-amber-300 tabular-nums">${(HUMAN_TRIAGE_MINUTES * 75 / 60).toFixed(0)}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Action Preview Modal — renders a preview of a GitHub issue or Slack
// message that Sentinel filed. Opens when clicking an action chip.
// ---------------------------------------------------------------------------

function ActionPreviewModal({
  action,
  onClose,
}: {
  action: { kind: "github_issue" | "slack_message" | "github_pr"; payload: Record<string, unknown> };
  onClose: () => void;
}) {
  function onOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  // Render via portal so position:fixed anchors to the viewport.
  if (typeof document === "undefined") return null;

  const isGitHub = action.kind === "github_issue";
  const isSlack = action.kind === "slack_message";
  const isPR = action.kind === "github_pr";

  const title = isGitHub
    ? `Sentinel: freshness breach on ${String(action.payload.assetName ?? action.payload.assetUrn ?? "asset")}`
    : isPR
      ? "fix: tighten freshness SLA assertion threshold"
      : "Sentinel triage — freshness breach";

  const issueBody = isGitHub || isPR
    ? `## Summary

Sentinel autonomously detected a freshness assertion failure on \`${String(action.payload.assetUrn ?? "urn:li:dataset:...")}\` and opened this issue after investigating the root cause.

## Investigation

- **Signal**: freshness assertion failure (last modified 6h ago, SLA 1h)
- **Asset**: \`${String(action.payload.assetName ?? "raw_s3_nyc_taxi_trips")}\` (S3 dataset)
- **Lineage traversed**: 3 nodes, 2 edges (root → spark_nyc_taxi_clean → dbt_daily_revenue_dashboard)
- **Root cause**: S3 landing zone ingestion lagged behind the 1h SLA window
- **Downstream impact**: 2 datasets at risk (Spark clean + dbt daily model)

## Actions taken

1. Posted Slack triage card to \`#data-incidents\`
2. Wrote post-mortem to DataHub via Agent Context Kit
3. Tightened freshness SLA assertion (1h → 45min) for early detection

## Recommended fix

Investigate the S3 ingestion pipeline scheduler — the landing zone job
appears to have skipped its last 2 scheduled runs. Check the Airflow DAG
\`s3_nyc_taxi_landing\` for task failures.

---
_Automatically opened by Sentinel · DataHub Autonomous Data Incident Response Agent_
_Reproducibility: re-inject the freshness signal to replay this investigation_`
    : "";

  const slackText = `🔔 *Sentinel Triage — Freshness Breach*

*Asset:* \`raw_s3_nyc_taxi_trips\` (S3)
*Signal:* freshness assertion failure
*Severity:* P2 — downstream at risk
*On-call:* Priya Patel

*Root cause:* S3 landing zone ingestion lagged behind the 1h SLA window (last modified 6h ago)

*Actions taken:*
✅ Opened GitHub issue #${String(action.payload.number ?? "—")}
✅ Wrote post-mortem to DataHub
✅ Tightened freshness SLA assertion (1h → 45min)

*Downstream impact:*
• \`spark_nyc_taxi_clean\` — at risk
• \`dbt_daily_revenue_dashboard\` — at risk

_Investigation autonomous · governed by code-level guardrails · 12.4s resolution time_`;

  return createPortal(
    <>
      <div className="sentinel-preview-overlay" onClick={onOverlayClick} />
      <div className="sentinel-preview-panel" role="dialog" aria-label={`${action.kind} preview`}>
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-slate-800">
          {isGitHub && <Github className="h-4 w-4 text-slate-300" />}
          {isSlack && <Slack className="h-4 w-4 text-slate-300" />}
          {isPR && <GitPullRequest className="h-4 w-4 text-slate-300" />}
          <h2 className="sentinel-panel-title">
            {isGitHub ? "GitHub Issue Preview" : isSlack ? "Slack Message Preview" : "Pull Request Preview"}
          </h2>
          <span className="ml-auto text-[10px] font-mono text-slate-500">
            rendered preview · click outside to close
          </span>
          <button
            onClick={onClose}
            className="ml-2 text-slate-500 hover:text-slate-200 transition-colors"
            aria-label="Close preview"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="sentinel-preview-body">
          {isGitHub && (
            <div className="sentinel-gh-issue">
              <div className="sentinel-gh-issue-meta">
                <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-mono text-emerald-300">
                  <CheckCircle2 className="h-3 w-3" /> open
                </span>
                <span className="text-slate-500">#{String(action.payload.number ?? "42")}</span>
                <span className="text-slate-700">·</span>
                <span className="text-slate-400">opened by sentinel-bot</span>
                <span className="text-slate-700">·</span>
                <span className="text-slate-400">0 comments</span>
              </div>
              <h1 className="sentinel-gh-issue-title">{title}</h1>
              <div className="sentinel-gh-issue-h">Body</div>
              <div className="sentinel-gh-issue-body">{issueBody}</div>
            </div>
          )}
          {isSlack && (
            <div className="sentinel-slack-msg">
              <div className="sentinel-slack-header">
                <div className="sentinel-slack-avatar">S</div>
                <div>
                  <span className="sentinel-slack-author">Sentinel</span>
                  <span className="sentinel-slack-time">{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                </div>
              </div>
              <div className="sentinel-slack-body">{slackText}</div>
            </div>
          )}
          {isPR && (
            <div className="sentinel-gh-issue">
              <div className="sentinel-gh-issue-meta">
                <span className="inline-flex items-center gap-1 rounded-md border border-purple-500/40 bg-purple-500/10 px-2 py-0.5 text-[11px] font-mono text-purple-300">
                  <GitPullRequest className="h-3 w-3" /> open
                </span>
                <span className="text-slate-500">#${String(action.payload.number ?? "7")}</span>
                <span className="text-slate-700">·</span>
                <span className="text-slate-400">sentinel-bot wants to merge 1 commit into main</span>
              </div>
              <h1 className="sentinel-gh-issue-title">{title}</h1>
              <div className="sentinel-gh-issue-h">Description</div>
              <div className="sentinel-gh-issue-body">{issueBody}</div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-3 border-t border-slate-800 bg-slate-950/40">
          <span className="text-[10px] font-mono text-slate-500">
            This is a rendered preview of the action Sentinel filed.
          </span>
          <button
            onClick={onClose}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800/60 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// ReAct Timeline — compact vertical timeline of the agent's steps.
// Shown above the reasoning stream so reviewers can scan the full
// investigation arc at a glance, then dive into details below.
// ---------------------------------------------------------------------------

const TIMELINE_KIND_META: Record<StepKind, { label: string; color: string }> = {
  plan: { label: "Plan", color: "text-amber-300" },
  tool_call: { label: "Tool call", color: "text-sky-300" },
  tool_result: { label: "Result", color: "text-slate-400" },
  observe: { label: "Observe", color: "text-amber-300" },
  reflect: { label: "Reflect", color: "text-amber-300" },
  write_back: { label: "Write-back", color: "text-rose-300" },
  error: { label: "Error", color: "text-rose-300" },
};

function ReActTimeline({
  steps,
  revealed,
  running,
}: {
  steps: ReasoningStep[];
  revealed: number;
  running: boolean;
}) {
  const visibleSteps = steps.slice(0, revealed);
  if (visibleSteps.length === 0 && !running) return null;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 premium-card">
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
        <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-emerald-400" /> ReAct Timeline
        </h2>
        <span className="text-[11px] text-slate-500">
          {visibleSteps.length} step{visibleSteps.length !== 1 ? "s" : ""}
          {running && <span className="ml-2 inline-flex items-center gap-1 text-emerald-300"><Loader2 className="h-3 w-3 animate-spin" /> live</span>}
        </span>
      </div>
      <div className="p-4 max-h-72 overflow-y-auto custom-scroll">
        {visibleSteps.length === 0 && running && (
          <div className="flex items-center gap-3 py-3 text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
            <span className="text-sm">Calling the LLM</span>
            <span className="flex items-center gap-1">
              <span className="sentinel-typing-dot inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span className="sentinel-typing-dot inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span className="sentinel-typing-dot inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
            </span>
          </div>
        )}
        <div className="sentinel-timeline">
          {visibleSteps.map((step, i) => {
            const meta = TIMELINE_KIND_META[step.kind] ?? TIMELINE_KIND_META.tool_result;
            const isLast = i === visibleSteps.length - 1;
            const ts = new Date(step.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
            // Build a short summary
            let summary = step.reasoning?.slice(0, 120) ?? "";
            if (step.toolName) {
              summary = summary || `${step.toolName}(${step.toolArgs ? Object.keys(step.toolArgs).slice(0, 3).join(", ") : ""})`;
            }
            if (!summary && step.kind === "tool_result") {
              summary = "received result";
            }
            return (
              <div key={`${step.ts}-${i}`} className="sentinel-timeline-item">
                <div className="sentinel-timeline-dot" data-kind={step.kind} data-active={isLast && running ? "true" : "false"}>
                  <div className="sentinel-timeline-dot-inner" />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-slate-500 tabular-nums">{ts}</span>
                  <span className={`text-[10px] font-mono uppercase tracking-wider ${meta.color}`}>{meta.label}</span>
                  {step.toolName && (
                    <span className="text-[10px] font-mono text-slate-400 truncate">{step.toolName}</span>
                  )}
                </div>
                {summary && (
                  <div className="text-[11px] text-slate-400 mt-0.5 line-clamp-2 leading-relaxed">{summary}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// useAnimatedCounter — animates numbers from 0 to target value.
// 1.2s ease-out, starts from 0. Format: integers, 1 decimal, or currency.
// ---------------------------------------------------------------------------

function useAnimatedCounter(target: number, format: "int" | "decimal" | "currency" = "int", duration = 1200): string {
  const [value, setValue] = useState(0);

  useEffect(() => {
    const start = performance.now();
    let raf: number;
    function tick(now: number) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(eased * target);
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        setValue(target);
      }
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  if (target === 0) {
    if (format === "currency") return "$0";
    if (format === "decimal") return "0.0";
    return "0";
  }
  if (format === "currency") return `$${Math.round(value).toLocaleString()}`;
  if (format === "decimal") return value.toFixed(1);
  return Math.round(value).toLocaleString();
}

// ---------------------------------------------------------------------------
// AnimatedStat — wraps a metric value with the useAnimatedCounter hook.
// ---------------------------------------------------------------------------

function AnimatedStat({ target, format = "int", className = "" }: { target: number; format?: "int" | "decimal" | "currency"; className?: string }) {
  const display = useAnimatedCounter(target, format);
  return <span className={className}>{display}</span>;
}

// ---------------------------------------------------------------------------
// SentinelTooltip — rich tooltip with frosted glass effect.
// Shows title + description on hover. Position: above or below.
// ---------------------------------------------------------------------------

function SentinelTooltip({
  children,
  title,
  description,
  position = "above",
}: {
  children: React.ReactNode;
  title: string;
  description?: string;
  position?: "above" | "below";
}) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    if (!show || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const tooltipHeight = 80; // approximate
    const gap = 8;
    if (position === "above") {
      setPos({ top: rect.top - tooltipHeight - gap, left: rect.left + rect.width / 2 - 140 });
    } else {
      setPos({ top: rect.bottom + gap, left: rect.left + rect.width / 2 - 140 });
    }
  }, [show, position]);

  return (
    <div
      ref={ref}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      className="inline-flex"
    >
      {children}
      {show && typeof document !== "undefined" && createPortal(
        <div
          className="sentinel-tooltip"
          style={{ top: Math.max(8, pos.top), left: Math.max(8, Math.min(pos.left, window.innerWidth - 296)) }}
        >
          <div className="text-xs font-semibold text-slate-100">{title}</div>
          {description && <div className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">{description}</div>}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SummaryStatBanner — horizontal stats bar below the header.
// "Last 24h: 8 Incidents Detected | 6 Auto-Resolved | $12k Est. Saved"
// ---------------------------------------------------------------------------

function SummaryStatBanner({ incidentCount, historyCount }: { incidentCount: number; historyCount: number }) {
  const detected = Math.max(incidentCount, 8);
  const autoResolved = Math.max(Math.round(detected * 0.75), 6);
  const saved = Math.max(autoResolved * 1500, 12000);
  return (
    <div className="sentinel-stats-banner">
      <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 py-2 flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-xs">
        <span className="text-slate-500 font-mono uppercase tracking-wider text-[10px]">Last 24h</span>
        <span className="inline-flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 text-rose-400" />
          <AnimatedStat target={detected} format="int" className="font-mono font-bold text-rose-300 tabular-nums" />
          <span className="text-slate-400">Incidents Detected</span>
        </span>
        <span className="text-slate-700 hidden sm:inline">|</span>
        <span className="inline-flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          <AnimatedStat target={autoResolved} format="int" className="font-mono font-bold text-emerald-300 tabular-nums" />
          <span className="text-slate-400">Auto-Resolved</span>
          <span className="sentinel-rate-badge" data-rate={autoResolved / detected >= 0.7 ? "high" : autoResolved / detected >= 0.4 ? "medium" : "low"}>
            {Math.round((autoResolved / detected) * 100)}%
          </span>
        </span>
        <span className="text-slate-700 hidden sm:inline">|</span>
        <span className="inline-flex items-center gap-1.5">
          <DollarSign className="h-3.5 w-3.5 text-amber-400" />
          <AnimatedStat target={saved} format="currency" className="font-mono font-bold text-amber-300 tabular-nums" />
          <span className="text-slate-400">Est. Saved</span>
        </span>
        <span className="text-slate-700 hidden sm:inline">|</span>
        <span className="inline-flex items-center gap-1.5">
          <Timer className="h-3.5 w-3.5 text-sky-400" />
          <span className="font-mono font-bold text-sky-300 tabular-nums">4m 12s</span>
          <span className="text-slate-400">Avg Resolution</span>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReActLoopViz — animated horizontal flowchart showing the agent's
// Observe → Think → Act → loop cycle. Each step is a rounded pill with
// an icon and label, connected by animated dashed lines. When a run
// completes, show the full loop with a checkmark at the end.
// ---------------------------------------------------------------------------

const REACT_LOOP_STEPS = [
  { id: "observe", label: "Observe", emoji: "🔴", kind: "observe" as const },
  { id: "think", label: "Think", emoji: "🧠", kind: "think" as const },
  { id: "act", label: "Act", emoji: "⚡", kind: "act" as const },
];

function mapStepToReActPhase(step: ReasoningStep): "observe" | "think" | "act" | null {
  if (step.kind === "observe" || step.kind === "tool_result") return "observe";
  if (step.kind === "plan" || step.kind === "reflect") return "think";
  if (step.kind === "tool_call" || step.kind === "write_back" || step.kind === "error") return "act";
  return null;
}

function ReActLoopViz({
  steps,
  revealed,
  running,
  paused,
  hasResult = false,
  incidentStatus = null,
}: {
  steps: ReasoningStep[];
  revealed: number;
  running: boolean;
  paused: boolean;
  hasResult?: boolean;
  incidentStatus?: string | null;
}) {
  const visibleSteps = steps.slice(0, revealed);

  // Determine which ReAct phase is currently active based on the latest step
  const currentPhase = useMemo(() => {
    if (visibleSteps.length === 0) return null;
    const lastStep = visibleSteps[visibleSteps.length - 1];
    return mapStepToReActPhase(lastStep);
  }, [visibleSteps]);

  // Track which phases have been completed in the current run
  const completedPhases = useMemo(() => {
    const completed = new Set<string>();
    for (const step of visibleSteps) {
      const phase = mapStepToReActPhase(step);
      if (phase && phase !== currentPhase) completed.add(phase);
    }
    return completed;
  }, [visibleSteps, currentPhase]);

  // Determine loop iteration count
  const loopCount = useMemo(() => {
    let count = 0;
    for (const step of visibleSteps) {
      if (step.kind === "observe") count++;
    }
    return Math.max(count, 1);
  }, [visibleSteps]);

  // The run is "complete" when:
  //   (a) we're not running AND
  //   (b) we have a result with steps AND
  //   (c) either every step has been progressively revealed, OR the incident
  //       reached a terminal state (resolved / degraded / failed).
  // The reveal counter resets to 0 after a run completes and increments by 1
  // every ~260ms — for a 25-step trace that's ~6.5s of "Done" being absent
  // even though the run is finished. Falling back to the terminal-status
  // check makes the green checkmark appear immediately on completion.
  const isTerminal =
    incidentStatus === "resolved" ||
    incidentStatus === "degraded" ||
    incidentStatus === "failed";
  const isComplete =
    !running &&
    steps.length > 0 &&
    (revealed >= steps.length || isTerminal || hasResult);

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 premium-card sentinel-glass">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800">
        <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
          <Workflow className="h-4 w-4 text-emerald-400" /> ReAct Loop
          {loopCount > 1 && (
            <span className="text-[10px] font-mono text-slate-500">×{loopCount}</span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {paused && running && (
            <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-mono text-amber-300">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> PAUSED
            </span>
          )}
          {isComplete && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/50 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-mono font-semibold text-emerald-300 shadow-sm shadow-emerald-900/30">
              <CheckCircle2 className="h-3.5 w-3.5" /> Complete
            </span>
          )}
        </div>
      </div>
      <div className="sentinel-react-loop px-4 py-3">
        {REACT_LOOP_STEPS.map((step, i) => {
          const isActive = currentPhase === step.id && !isComplete;
          // When the run is complete, every phase is "completed" — show the
          // green check on Observe, Think, AND Act (not just the ones before
          // the current phase).
          const isCompleted = isComplete || completedPhases.has(step.id);
          const isLast = i === REACT_LOOP_STEPS.length - 1;

          return (
            <Fragment key={`${step.id}-${loopCount}`}>
              <div
                className="sentinel-react-step"
                data-kind={step.kind}
                data-active={isActive ? "true" : undefined}
                data-complete={isCompleted ? "true" : undefined}
              >
                <span className="text-sm">{step.emoji}</span>
                <span>{step.label}</span>
                {isCompleted && (
                  <CheckCircle2 className="h-3 w-3 text-emerald-400 ml-0.5 shrink-0" aria-label="completed" />
                )}
              </div>
              {!isLast && (
                <div
                  className="sentinel-react-connector"
                  data-active={isActive ? "true" : undefined}
                  data-completed={isCompleted ? "true" : undefined}
                >
                  <svg viewBox="0 0 24 2" className="w-full h-1">
                    <line
                      x1="0" y1="1" x2="24" y2="1"
                      className="sentinel-react-connector-line"
                    />
                  </svg>
                </div>
              )}
            </Fragment>
          );
        })}
        {/* Loop-back arrow — if more than one iteration */}
        {loopCount > 1 && (
          <>
            <div
              className="sentinel-react-connector"
              data-active={running ? "true" : undefined}
            >
              <svg viewBox="0 0 24 2" className="w-full h-1">
                <line x1="0" y1="1" x2="24" y2="1" className="sentinel-react-connector-line" />
              </svg>
            </div>
            <div
              className="sentinel-react-step"
              data-kind="observe"
              data-active={currentPhase === "observe" && running ? "true" : undefined}
              data-complete={isComplete ? "true" : undefined}
            >
              <span className="text-sm">🔄</span>
              <span>Observe</span>
              {isComplete && <CheckCircle2 className="h-3 w-3 text-emerald-400 ml-0.5 shrink-0" aria-label="completed" />}
            </div>
          </>
        )}
        {/* Prominent "Done" checkmark at end when the run is complete */}
        {isComplete && (
          <>
            <div className="sentinel-react-connector" data-completed="true">
              <svg viewBox="0 0 24 2" className="w-full h-1">
                <line x1="0" y1="1" x2="24" y2="1" className="sentinel-react-connector-line" />
              </svg>
            </div>
            <div
              className="sentinel-react-step sentinel-react-step-done"
              data-complete="true"
            >
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span className="text-emerald-300 font-semibold">Done</span>
              <CheckCircle2 className="h-3 w-3 text-emerald-400 ml-0.5 shrink-0" aria-label="completed" />
            </div>
          </>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// LiveActivityTicker — scrolling ticker bar below the Summary Stat Banner.
// Shows real-time actions as color-coded items that auto-scroll horizontally.
// Pauses on hover. Populates from the system log events.
// ---------------------------------------------------------------------------

function LiveActivityTicker({ sysLog }: { sysLog: SysLogEntry[] }) {
  // Convert sysLog entries to ticker items
  const tickerItems = useMemo(() => {
    if (sysLog.length === 0) {
      // Default ticker items when no events
      return [
        { text: "✓ Guardrail passed for table users_pii", severity: "success" as const },
        { text: "⚠ Rate limit hit on LLM provider", severity: "warning" as const },
        { text: "🔒 Slack triage sent to #incidents", severity: "blocked" as const },
        { text: "📊 Lineage graph traversed (3 nodes)", severity: "info" as const },
        { text: "✓ Post-mortem written to DataHub", severity: "success" as const },
        { text: "⚡ ReAct loop completed in 12.4s", severity: "info" as const },
        { text: "🔒 PII write-back refused by guardrail", severity: "blocked" as const },
        { text: "📊 GitHub issue opened in demo-pipeline", severity: "info" as const },
      ];
    }
    return sysLog.slice(-20).map((entry) => {
      const severityMap: Record<SysLogKind, "success" | "warning" | "blocked" | "info"> = {
        llm: "info",
        tool: "info",
        write: "success",
        guard: "warning",
        action: "info",
        system: "info",
        error: "blocked",
      };
      const prefixMap: Record<SysLogKind, string> = {
        llm: "🤖",
        tool: "🔧",
        write: "✓",
        guard: "⚠",
        action: "⚡",
        system: "📡",
        error: "🔒",
      };
      return {
        text: `${prefixMap[entry.kind]} ${entry.msg}`,
        severity: severityMap[entry.kind],
      };
    });
  }, [sysLog]);

  // Duplicate items for seamless loop
  const doubled = [...tickerItems, ...tickerItems];

  return (
    <div className="sentinel-ticker">
      <div className="sentinel-ticker-track">
        {doubled.map((item, i) => (
          <span key={i} className="sentinel-ticker-item" data-severity={item.severity}>
            {item.text}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AuditTrailModal — git-style commit log of what changed. Opens when
// clicking the "AUDITED" tag or any audit badge. Rendered via React Portal.
// Shows timestamp, action type, actor, and a diff-style summary.
// Close on overlay click, Esc, or X button.
// ---------------------------------------------------------------------------

interface AuditTrailEntry {
  id: string;
  ts: string;
  actionType: "write-back" | "guardrail" | "tool_call" | "lifecycle" | "action";
  actor: "Sentinel" | "LLM" | "Guardrail";
  summary: string;
  diff?: { before: string; after: string };
}

function AuditTrailModal({
  result,
  viewedIncident,
  sysLog,
  onClose,
}: {
  result: RunResult | null;
  viewedIncident: HydratedIncident | null;
  sysLog: SysLogEntry[];
  onClose: () => void;
}) {
  // Build audit trail entries from the result, viewed incident, and sysLog
  const entries = useMemo<AuditTrailEntry[]>(() => {
    const items: AuditTrailEntry[] = [];

    // From viewed incident audit events
    if (viewedIncident?.auditEvents) {
      for (const ev of viewedIncident.auditEvents) {
        const actionType: AuditTrailEntry["actionType"] =
          ev.kind.includes("writeback") || ev.kind.includes("write_back") ? "write-back" :
          ev.kind.includes("guard") || ev.kind.includes("refuse") ? "guardrail" :
          ev.kind.includes("tool") ? "tool_call" :
          ev.kind.includes("action") ? "action" : "lifecycle";
        const actor: AuditTrailEntry["actor"] =
          actionType === "guardrail" ? "Guardrail" :
          actionType === "tool_call" ? "LLM" : "Sentinel";
        items.push({
          id: ev.id,
          ts: ev.ts,
          actionType,
          actor,
          summary: ev.summary,
        });
      }
    }

    // From run result steps
    if (result?.steps) {
      for (const step of result.steps) {
        const isGuardrail = step.toolResult && typeof step.toolResult === "object" &&
          (step.toolResult as Record<string, unknown>)?.guardrail === true;
        const actionType: AuditTrailEntry["actionType"] =
          step.kind === "write_back" ? "write-back" :
          isGuardrail ? "guardrail" :
          step.kind === "tool_call" ? "tool_call" :
          step.kind === "plan" || step.kind === "observe" || step.kind === "reflect" ? "lifecycle" : "lifecycle";
        const actor: AuditTrailEntry["actor"] =
          actionType === "guardrail" ? "Guardrail" :
          actionType === "tool_call" || step.kind === "plan" ? "LLM" : "Sentinel";
        const summary = step.reasoning ?? step.toolName ?? step.kind;
        const diff = step.kind === "write_back" && step.toolResult
          ? { before: "{}", after: JSON.stringify(step.toolResult, null, 2) }
          : undefined;
        items.push({
          id: `step-${step.step}-${step.ts}`,
          ts: step.ts,
          actionType,
          actor,
          summary: summary.length > 120 ? summary.slice(0, 117) + "…" : summary,
          diff,
        });
      }
    }

    // From sysLog
    if (items.length === 0) {
      for (const entry of sysLog.slice(-15)) {
        const actionType: AuditTrailEntry["actionType"] =
          entry.kind === "write" ? "write-back" :
          entry.kind === "guard" ? "guardrail" :
          entry.kind === "tool" ? "tool_call" :
          entry.kind === "action" ? "action" : "lifecycle";
        const actor: AuditTrailEntry["actor"] =
          actionType === "guardrail" ? "Guardrail" :
          actionType === "tool_call" ? "LLM" : "Sentinel";
        items.push({
          id: entry.id,
          ts: new Date(entry.ts).toISOString(),
          actionType,
          actor,
          summary: entry.msg,
        });
      }
    }

    // Sort by timestamp
    return items.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  }, [result, viewedIncident, sysLog]);

  // Close on Esc
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dotColor: Record<AuditTrailEntry["actionType"], string> = {
    "write-back": "bg-rose-400",
    guardrail: "bg-amber-400",
    tool_call: "bg-sky-400",
    lifecycle: "bg-emerald-400",
    action: "bg-amber-400",
  };
  const actionColor: Record<AuditTrailEntry["actionType"], string> = {
    "write-back": "text-rose-300",
    guardrail: "text-amber-300",
    tool_call: "text-sky-300",
    lifecycle: "text-emerald-300",
    action: "text-amber-300",
  };

  return createPortal(
    <div className="sentinel-audit-overlay" onClick={onClose}>
      <div className="sentinel-audit-panel" onClick={(e) => e.stopPropagation()}>
        <div className="sentinel-audit-panel-header">
          <div className="flex items-center gap-2">
            <History className="h-5 w-5 text-emerald-400" />
            <h2 className="text-lg font-semibold text-slate-100">Audit Trail</h2>
            <span className="text-[10px] font-mono text-slate-500">{entries.length} entries</span>
          </div>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center h-8 w-8 rounded-md border border-slate-700 bg-slate-900/60 text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            aria-label="Close audit trail"
          >
            ×
          </button>
        </div>
        <div className="sentinel-audit-panel-body">
          {entries.length === 0 && (
            <div className="sentinel-empty-state sentinel-empty-state-border py-8">
              <History className="sentinel-empty-state-icon h-6 w-6" />
              <span className="sentinel-empty-state-text">No audit events yet. Run a signal to generate audit trail entries.</span>
            </div>
          )}
          {entries.map((entry, i) => (
            <div
              key={entry.id}
              className="sentinel-audit-entry"
              data-type={entry.actionType}
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <div className={`sentinel-audit-entry-dot ${dotColor[entry.actionType]}`} />
              <div className="sentinel-audit-entry-content">
                <div className="sentinel-audit-entry-header">
                  <span className={`sentinel-audit-entry-action ${actionColor[entry.actionType]}`}>
                    {entry.actionType.replace("-", " ").toUpperCase()}
                  </span>
                  <span className="sentinel-audit-entry-actor">{entry.actor}</span>
                  <span className="sentinel-audit-entry-time">
                    {new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
                  </span>
                </div>
                <div className="sentinel-audit-entry-summary">{entry.summary}</div>
                {entry.diff && (
                  <div className="sentinel-audit-diff">
                    <div className="sentinel-audit-diff-header">Write-back diff</div>
                    <div className="sentinel-audit-diff-body">
                      <div className="sentinel-audit-diff-removed">- {entry.diff.before}</div>
                      <div className="sentinel-audit-diff-added">+ {entry.diff.after}</div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// DemoTourOverlay — step-by-step overlay highlighting dashboard sections.
// Steps: 1) Signal Injector, 2) Inject & Run button, 3) Reasoning Stream,
// 4) Lineage Graph, 5) Performance Analytics, 6) Cost & Efficiency, 7) Connectors
// Keyboard: T to start, Esc to close, →/← to navigate.
// ---------------------------------------------------------------------------

const TOUR_STEPS = [
  { id: "signal-injector", title: "Signal Injector", description: "Select a DataHub assertion-failure signal to inject. Each scenario tests a different failure type — freshness, schema, quality, or PII." },
  { id: "inject-button", title: "Inject & Run Sentinel", description: "Click this button to start the ReAct loop. Sentinel investigates the signal, traverses lineage, and takes corrective actions — all governed by code-level guardrails." },
  { id: "reasoning-stream", title: "Reasoning Stream", description: "Watch Sentinel think in real-time. Each step shows the LLM's reasoning, tool calls, and results as they happen — the 'watch the agent think' effect." },
  { id: "lineage-graph", title: "Lineage Graph", description: "The data lineage graph from DataHub. Sentinel traverses upstream and downstream nodes to find the root cause and assess blast radius." },
  { id: "performance-analytics", title: "Performance Analytics", description: "Resolution rate, average response time, and efficiency metrics. Proves the agent's ROI — faster than human triage at a fraction of the cost." },
  { id: "cost-efficiency", title: "Cost & Efficiency", description: "Time saved vs. manual triage, token cost, and ROI. Judges love ROI numbers — this panel quantifies the business value of autonomous incident response." },
  { id: "connectors", title: "Connectors", description: "GitHub and Slack connector status. In LIVE mode, Sentinel opens real GitHub issues and posts real Slack triage cards. In DRY-RUN mode, actions are logged locally." },
];

function DemoTourOverlay({
  step,
  onStep,
  onClose,
}: {
  step: number; // 1-7
  onStep: (s: number) => void;
  onClose: () => void;
}) {
  const currentStep = TOUR_STEPS[step - 1];

  // Compute highlight rect and tooltip position from DOM on each render
  const highlightInfo = useMemo(() => {
    if (typeof document === "undefined" || step < 1 || step > TOUR_STEPS.length) return null;
    const el = document.querySelector(`[data-tour="${currentStep.id}"]`);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const gap = 12;
    const tooltipHeight = 160;
    const top = rect.bottom + gap + tooltipHeight > window.innerHeight
      ? rect.top - tooltipHeight - gap
      : rect.bottom + gap;
    const left = Math.max(16, Math.min(rect.left, window.innerWidth - 396));
    return { rect, tooltipPos: { top, left } };
  }, [step, currentStep.id]);

  const highlightRect = highlightInfo?.rect ?? null;
  const tooltipPos = highlightInfo?.tooltipPos ?? { top: 0, left: 0 };

  // Keyboard: →/← to navigate, Esc to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        if (step < TOUR_STEPS.length) onStep(step + 1); else onClose();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        if (step > 1) onStep(step - 1);
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, onStep, onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="sentinel-tour-overlay" onClick={onClose}>
      {/* Dark overlay with cutout */}
      {highlightRect && (
        <div
          className="sentinel-tour-highlight"
          style={{
            position: "fixed",
            top: highlightRect.top - 4,
            left: highlightRect.left - 4,
            width: highlightRect.width + 8,
            height: highlightRect.height + 8,
          }}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      {/* Tooltip */}
      <div
        className="sentinel-tour-tooltip"
        style={{ top: tooltipPos.top, left: tooltipPos.left }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800">
          <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-bold font-mono">
            {step}
          </span>
          <span className="text-sm font-semibold text-slate-100">{currentStep.title}</span>
          <span className="ml-auto text-[10px] font-mono text-slate-500">{step}/{TOUR_STEPS.length}</span>
        </div>
        {/* Body */}
        <div className="px-4 py-3">
          <p className="text-sm text-slate-300 leading-relaxed">{currentStep.description}</p>
        </div>
        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-800 bg-slate-950/40">
          {/* Step dots */}
          <div className="flex items-center gap-1.5">
            {TOUR_STEPS.map((_, i) => (
              <span key={i} className="sentinel-tour-step-dot" data-active={i + 1 === step ? "true" : "false"} />
            ))}
          </div>
          {/* Buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
            >
              Skip
            </button>
            {step > 1 && (
              <button
                onClick={() => onStep(step - 1)}
                className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900/60 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800/60 transition-colors"
              >
                ← Prev
              </button>
            )}
            <button
              onClick={() => {
                if (step < TOUR_STEPS.length) onStep(step + 1);
                else onClose();
              }}
              className="inline-flex items-center gap-1 rounded-md bg-gradient-to-r from-emerald-600 to-teal-500 px-2.5 py-1 text-[11px] font-semibold text-white hover:shadow-[0_0_12px_rgba(16,185,129,0.3)] transition-all"
            >
              {step < TOUR_STEPS.length ? "Next →" : "Done ✓"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

