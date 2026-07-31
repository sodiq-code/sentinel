/**
 * Sentinel — shared types for the autonomous incident-response agent.
 *
 * These types are consumed by the Next.js console and the CI integration
 * test.
 */

// ---------------------------------------------------------------------------
// DataHub entity model
// ---------------------------------------------------------------------------

export type DataPlatform =
  | 'dbt'
  | 'snowflake'
  | 'spark'
  | 's3'
  | 'looker'
  | 'bigquery'
  | 'postgres'
  | 'redshift'
  | 'kafka'
  | 'unknown';

export type EntityType = 'dataset' | 'chart' | 'dashboard' | 'dataFlow' | 'dataJob' | 'container' | 'domain';

/** A DataHub URN. Example: urn:li:dataset:(urn:li:dataPlatform:dbt,nyc_yellow_taxi_trips,PROD) */
export type Urn = string;

export interface Entity {
  urn: Urn;
  name: string;
  platform: DataPlatform;
  type: EntityType;
  description?: string;
  owners: OwnerRef[];
  glossaryTerms: GlossaryTermRef[];
  governanceTags: GovernanceTag[];
  schema?: SchemaField[];
  /** Last modified timestamp (ms). Used for freshness assertions. */
  lastModifiedAt?: number;
  /** Platform-native identifier (e.g. dbt model name, S3 path). */
  platformNativeName?: string;
}

export interface SchemaField {
  name: string;
  type: string;
  nullable: boolean;
  description?: string;
  /** URNs of glossary terms attached to this field (e.g. pii). */
  glossaryTerms?: GlossaryTermRef[];
}

export interface OwnerRef {
  urn: Urn;
  name: string;
  /** 'user' | 'team' | 'group' */
  type: 'user' | 'team' | 'group';
}

export interface GlossaryTermRef {
  urn: Urn;
  name: string;
  description?: string;
}

export interface GovernanceTag {
  name: string;
  /** 'pii' | 'restricted' | 'confidential' | 'public' */
  level: 'pii' | 'restricted' | 'confidential' | 'public';
}

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

export type LineageDirection = 'upstream' | 'downstream';

export interface LineageEdge {
  fromUrn: Urn;
  toUrn: Urn;
  /** Edge metadata: e.g. which columns flow, the Spark job that produces it. */
  via?: Urn;
  relationshipType: string;
}

export interface LineageResult {
  urn: Urn;
  direction: LineageDirection;
  nodes: Entity[];
  edges: LineageEdge[];
  /** Number of hops from the source urn. */
  depth: number;
}

// ---------------------------------------------------------------------------
// Assertions (the signal source)
// ---------------------------------------------------------------------------

export type AssertionType = 'freshness' | 'schema' | 'quality' | 'custom';
export type AssertionStatus = 'passing' | 'failing' | 'error' | 'unknown';

export interface Assertion {
  urn: Urn;
  assetUrn: Urn;
  type: AssertionType;
  status: AssertionStatus;
  description: string;
  /** SLA in seconds (e.g. 900 for a 15-min freshness SLA). */
  slaSeconds?: number;
  /** ISO timestamp of the last evaluation. */
  lastEvaluatedAt: string;
  /** ISO timestamp of the last successful evaluation. */
  lastSuccessAt?: string;
  /** Human-readable failure reason (set when status === 'failing'). */
  failureReason?: string;
}

// ---------------------------------------------------------------------------
// Context docs (the compounding substrate)
// ---------------------------------------------------------------------------

export interface ContextDoc {
  urn: Urn;
  assetUrn: Urn;
  title: string;
  content: string;
  /** Markdown body. */
  format: 'markdown' | 'html' | 'plaintext';
  createdAt: string;
  authorUrn: Urn;
  authorName: string;
  /** Marks this doc as a Sentinel post-mortem. */
  sentinelPostMortem?: boolean;
}

// ---------------------------------------------------------------------------
// Signal (the input to Sentinel)
// ---------------------------------------------------------------------------

export interface Signal {
  /** Unique signal id. */
  id: string;
  /** The assertion that fired. */
  assertionUrn: Urn;
  assetUrn: Urn;
  type: AssertionType;
  status: AssertionStatus;
  /** ISO timestamp the signal fired. */
  firedAt: string;
  /** The payload DataHub delivered (raw). */
  rawPayload?: unknown;
}

// ---------------------------------------------------------------------------
// Incident (Sentinel's working state)
// ---------------------------------------------------------------------------

export type IncidentStatus =
  | 'open'          // just detected, not yet triaged
  | 'investigating' // orchestrator is running tools
  | 'acting'        // connectors are taking actions
  | 'awaiting_approval' // guardrail paused for human approval
  | 'resolved'      // write-back complete, post-mortem saved
  | 'failed'        // unrecoverable error
  | 'cancelled';    // user cancelled

export interface Incident {
  urn: Urn;
  signal: Signal;
  status: IncidentStatus;
  createdAt: string;
  resolvedAt?: string;
  /** The reasoning trace (every ReAct step). */
  reasoningSteps: ReasoningStep[];
  /** Proposed actions awaiting human approval (if any). */
  pendingApprovals: PendingApproval[];
}

// ---------------------------------------------------------------------------
// ReAct reasoning trace
// ---------------------------------------------------------------------------

export type ReasoningStepKind =
  | 'plan'
  | 'tool_call'
  | 'tool_result'
  | 'observe'
  | 'reflect'
  | 'act'
  | 'write_back'
  | 'error';

export interface ReasoningStep {
  /** Step number, 0-indexed. */
  step: number;
  kind: ReasoningStepKind;
  /** The tool name (for tool_call/tool_result), e.g. 'mcp.search'. */
  toolName?: string;
  /** The structured tool args (for tool_call). */
  toolArgs?: Record<string, unknown>;
  /** The tool result (for tool_result). */
  toolResult?: unknown;
  /** Free-text reasoning the agent showed (plan/observe/reflect). */
  reasoning?: string;
  /** ISO timestamp. */
  ts: string;
  /** Error message (for error steps). */
  error?: string;
}

// ---------------------------------------------------------------------------
// Guardrail
// ---------------------------------------------------------------------------

export interface PendingApproval {
  id: string;
  /** The proposed action that needs approval. */
  action: ProposedAction;
  reason: string;
  /** Who should approve (user URN or role). */
  approver: string;
  createdAt: string;
}

export type ProposedAction =
  | { kind: 'github.openIssue'; repo: string; title: string; body: string; labels: string[] }
  | { kind: 'github.openPR'; repo: string; title: string; body: string; branch: string; base: string }
  | { kind: 'slack.postMessage'; channel: string; text: string }
  | { kind: 'datahub.proposeGlossary'; assetUrn: Urn; termUrns: Urn[] }
  | { kind: 'datahub.proposeOwnership'; assetUrn: Urn; owners: OwnerRef[] }
  | { kind: 'datahub.createAssertion'; assetUrn: Urn; type: AssertionType; slaSeconds: number };

export interface GuardrailDecision {
  /** Whether the proposed action may proceed without human approval. */
  allowed: boolean;
  /** If false, the action needs human approval. */
  needsApproval: boolean;
  /** The reason for refusal or approval-pending. */
  reason: string;
  /** The proposed action (echoed back for the audit log). */
  action: ProposedAction;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type AuditEventKind =
  | 'signal_received'
  | 'incident_created'
  | 'tool_call'
  | 'tool_result'
  | 'action_proposed'
  | 'action_approved'
  | 'action_refused'
  | 'action_executed'
  | 'write_back_proposed'
  | 'write_back_succeeded'
  | 'write_back_failed'
  | 'incident_resolved'
  | 'incident_failed';

export interface AuditEvent {
  id: string;
  incidentUrn: Urn;
  kind: AuditEventKind;
  /** ISO timestamp. */
  ts: string;
  /** Free-text summary. */
  summary: string;
  /** Structured payload (tool args, action, write-back, etc.). */
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Write-back artefacts
// ---------------------------------------------------------------------------

export interface WriteBackResult {
  kind: 'context_doc' | 'glossary_proposal' | 'ownership_proposal' | 'assertion';
  /** The DataHub URN created/updated, if any. */
  urn?: Urn;
  /** The proposed payload (for proposals awaiting human approval). */
  proposal?: Record<string, unknown>;
  status: 'succeeded' | 'proposed' | 'failed';
  /** Which path succeeded: 'agent_context_kit' | 'rest_ingestion'. */
  path?: 'agent_context_kit' | 'rest_ingestion';
  ts: string;
}

// ---------------------------------------------------------------------------
// Backend health (consumed by the incident console)
// ---------------------------------------------------------------------------

export interface BackendHealth {
  status: 'ok' | 'degraded' | 'down';
  phase: 'foundation' | 'loop-mvp' | 'actions-guardrails' | 'writeback' | 'demo-polish' | 'submission';
  datahubMode: 'demo' | 'live';
  llmModel: string;
  /** ISO timestamp of this health check. */
  ts: string;
}
