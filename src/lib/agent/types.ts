// =============================================================================
// Sentinel — Agent types (canonical Phase 2 location)
//
// These are the orchestrator-level types: the LLM wire shapes, the signal/
// incident model, the ReAct reasoning trace, the guardrail decisions, and the
// audit events. The domain (DataHub entity) types live in ../datahub/types and
// are re-exported here for one-stop imports.
//
// The Phase-0 `sentinel/types.ts` stub shipped the same shape; this module is
// the live, evolved Phase 2 contract.
// =============================================================================

export type {
  Urn,
  Entity,
  SchemaField,
  OwnerRef,
  GlossaryTermRef,
  GovernanceTag,
  AssertionType,
  AssertionRecord,
} from '../datahub/types'

// ---------------------------------------------------------------------------
// LLM wire types (OpenAI-compatible — NVIDIA NIM uses these exact shapes)
// ---------------------------------------------------------------------------

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: LlmToolCall[]
  /** Present on tool-role messages — the tool_call_id this responds to. */
  toolCallId?: string
  /** Tool name on tool-role messages. */
  name?: string
}

export interface LlmTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface LlmToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface LlmCompletion {
  content: string | null
  toolCalls: LlmToolCall[]
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'empty' | string
  usage?: { promptTokens: number; completionTokens: number }
}

export interface LlmClient {
  complete(input: {
    messages: LlmMessage[]
    tools?: LlmTool[]
    temperature?: number
    maxTokens?: number
  }): Promise<LlmCompletion>
}

// ---------------------------------------------------------------------------
// Signal — the input from DataHub (an assertion failure)
// ---------------------------------------------------------------------------

export interface Signal {
  id: string
  assertionUrn: string
  assetUrn: string
  type: 'freshness' | 'schema' | 'quality' | 'pii'
  status: 'passing' | 'failing' | 'error'
  firedAt: string
  rawPayload?: unknown
}

// ---------------------------------------------------------------------------
// Incident — Sentinel's working state
// ---------------------------------------------------------------------------

export type IncidentStatus =
  | 'open'
  | 'investigating'
  | 'acting'
  | 'awaiting_approval'
  | 'resolved'
  | 'failed'
  | 'cancelled'

export interface Incident {
  urn: string
  signal: Signal
  status: IncidentStatus
  createdAt: string
  resolvedAt?: string
  reasoningSteps: ReasoningStep[]
  pendingApprovals: PendingApproval[]
}

// ---------------------------------------------------------------------------
// ReAct reasoning trace — emitted on every step for the live console
// (PDF §5.3: "I can see the agent thinking")
// ---------------------------------------------------------------------------

export type ReasoningStepKind =
  | 'plan'
  | 'tool_call'
  | 'tool_result'
  | 'observe'
  | 'reflect'
  | 'write_back'
  | 'error'

export interface ReasoningStep {
  step: number
  kind: ReasoningStepKind
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: unknown
  reasoning?: string
  ts: string
  error?: string
  /** Cost (tokens) for the LLM call that produced this step, if any. */
  usage?: { promptTokens: number; completionTokens: number }
}

// ---------------------------------------------------------------------------
// Guardrail
// ---------------------------------------------------------------------------

export interface PendingApproval {
  id: string
  action: ProposedAction
  reason: string
  approver: string
  createdAt: string
}

export type ProposedAction =
  | { kind: 'github.openIssue'; repo: string; title: string; body: string; labels: string[] }
  | { kind: 'github.openPR'; repo: string; title: string; body: string; branch: string; base: string }
  | { kind: 'slack.postMessage'; channel: string; text: string }
  | { kind: 'datahub.proposeGlossary'; assetUrn: string; termUrns: string[] }
  | { kind: 'datahub.proposeOwnership'; assetUrn: string; owners: { urn: string; type: 'user' | 'team' | 'group' }[] }
  | { kind: 'datahub.createAssertion'; assetUrn: string; type: 'freshness' | 'schema' | 'quality' | 'custom'; slaSeconds: number }

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type AuditEventKind =
  | 'signal_received'
  | 'incident_created'
  | 'plan'
  | 'tool_call'
  | 'tool_result'
  | 'observe'
  | 'reflect'
  | 'write_back'
  | 'error'
  | 'action_proposed'
  | 'action_executed'
  | 'write_back_succeeded'
  | 'incident_resolved'
  | 'incident_failed'

export interface AuditEvent {
  id: string
  incidentUrn: string
  kind: AuditEventKind
  ts: string
  summary: string
  payload?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Write-back artefacts (PDF §9.4.2 sequence, steps 12–14)
// ---------------------------------------------------------------------------

export interface WriteBackResult {
  kind: 'context_doc' | 'glossary_proposal' | 'ownership_proposal' | 'assertion' | 'tag' | 'description'
  urn?: string
  proposal?: Record<string, unknown>
  status: 'succeeded' | 'proposed' | 'failed'
  path?: 'agent_context_kit' | 'rest_ingestion'
  ts: string
}
