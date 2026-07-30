/**
 * Sentinel — Orchestrator (the ReAct reasoning loop).
 *
 * PDF §9.3.2 Option A: single orchestrator + tools.
 * PDF §9.4.4 layered prompt architecture.
 *
 * Phase 0 (this file): the public interface + the structure of the ReAct loop,
 * wired to the LLM client + tool registry + guardrail + connectors + write-back.
 * The actual tool execution is a Phase 2 deliverable (Demo Mode) and Phase 4
 * (real write-back).
 *
 * Blueprint fidelity:
 *  - One LLM provider, temperature 0 (PDF §10.2).
 *  - Visible reasoning: every intermediate step is observable (PDF §5.3).
 *  - Retry with exponential backoff on any tool failure (PDF §9.5.4).
 *  - Structured tool-call inputs, never free-text execution (PDF §12.3 —
 *    prompt-injection mitigation).
 */

import type {
  Assertion,
  Incident,
  ReasoningStep,
  Signal,
  WriteBackResult,
} from './types';

/** Public interface for the Orchestrator. */
export interface Orchestrator {
  /**
   * Handle a DataHub assertion-failure signal end-to-end:
   *   detect → triage → diagnose → remediate → document → write-back.
   * Returns the resolved incident with the full reasoning trace.
   */
  handleSignal(signal: Signal): Promise<Incident>;
}

/**
 * The orchestrator's dependencies — injected for testability.
 * Phase 2 fills these in with real implementations.
 */
export interface OrchestratorDeps {
  /** LLM client (NVIDIA NIM, OpenAI-compatible). Phase 2. */
  readonly llm: LlmClient;
  /** Read tools (12 MCP tools). Phase 1. */
  readonly readTools: McpReadTools;
  /** Write tools (7 Agent Context Kit tools + REST fallback). Phase 4. */
  readonly writeTools: WriteBackTools;
  /** Action connectors. Phase 3. */
  readonly github: GitHubConnector;
  readonly slack: SlackConnector;
  /** Guardrail. Phase 3. */
  readonly guardrail: Guardrail;
  /** Audit log. Phase 2. */
  readonly audit: AuditLog;
  /** Reasoning stream — called on every step for the live console. Phase 5. */
  readonly onReasoningStep?: (step: ReasoningStep) => void;
}

export interface LlmClient {
  /**
   * One LLM completion with tool-calling.
   * Phase 2 implementation: POST to NVIDIA NIM `chat/completions` with the
   * OpenAI-compatible schema, model `nvidia/llama-3.3-nemotron-super-49b-v1`,
   * temperature 0, tools = the catalogue, tool_choice 'auto'. Fallback to
   * `openai/gpt-oss-120b` on 429/timeout.
   */
  complete(input: {
    messages: LlmMessage[];
    tools?: LlmTool[];
    temperature?: number;
    maxTokens?: number;
  }): Promise<LlmCompletion>;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** For role === 'assistant' with tool_calls. */
  toolCalls?: LlmToolCall[];
  /** For role === 'tool' — the tool_call_id this responds to. */
  toolCallId?: string;
  name?: string;
}

export interface LlmTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmCompletion {
  content: string | null;
  toolCalls: LlmToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | string;
  /** Tokens used (for the audit + cost guard). */
  usage?: { promptTokens: number; completionTokens: number };
}

export interface McpReadTools {
  search(query: string, opts?: { count?: number; filters?: unknown }): Promise<unknown[]>;
  getEntities(urns: string[]): Promise<unknown[]>;
  listSchemaFields(urn: string, opts?: { keywords?: string }): Promise<unknown[]>;
  getMe(): Promise<unknown>;
  getLineage(urn: string, direction: 'upstream' | 'downstream', opts?: unknown): Promise<unknown>;
  getLineagePathsBetween(fromUrn: string, toUrn: string): Promise<unknown[]>;
  searchDocuments(query: string, opts?: unknown): Promise<unknown[]>;
  grepDocuments(pattern: string, opts?: unknown): Promise<unknown[]>;
  getDatasetQueries(urn: string, opts?: unknown): Promise<unknown[]>;
  listLifecycleStages(): Promise<unknown[]>;
  getGlossaryTermVersions(urn: string): Promise<unknown[]>;
  compareGlossaryTermVersions(urn: string, v1: string, v2: string): Promise<unknown>;
}

export interface WriteBackTools {
  saveDocument(input: {
    assetUrn: string;
    title: string;
    content: string;
    format?: 'markdown' | 'html' | 'plaintext';
  }): Promise<{ urn: string }>;
  addTags(urn: string, tags: string[]): Promise<void>;
  removeTags(urn: string, tags: string[]): Promise<void>;
  updateDescription(urn: string, description: string): Promise<void>;
  addGlossaryTerms(urn: string, termUrns: string[]): Promise<void>;
  removeGlossaryTerms(urn: string, termUrns: string[]): Promise<void>;
  setDomains(urn: string, domainUrns: string[]): Promise<void>;
  addOwners(urn: string, owners: { urn: string; type: 'user' | 'team' | 'group' }[]): Promise<void>;
}

export interface IngestionClient {
  ingestProposal(proposal: unknown): Promise<{ urn: string }>;
  patchEntity(urn: string, patch: unknown): Promise<void>;
  createAssertion(input: {
    assetUrn: string;
    type: 'freshness' | 'schema' | 'quality' | 'custom';
    slaSeconds?: number;
    description?: string;
  }): Promise<{ urn: string }>;
}

export interface WriteBackRunner {
  /** Dual write-back path (PDF §12.2). Try Agent Context Kit; on failure → REST ingestion. */
  writeContextDoc(assetUrn: string, title: string, content: string): Promise<WriteBackResult>;
  proposeGlossary(assetUrn: string, termUrns: string[]): Promise<WriteBackResult>;
  proposeOwnership(assetUrn: string, owners: { urn: string; type: 'user' | 'team' | 'group' }[]): Promise<WriteBackResult>;
  createAssertion(input: {
    assetUrn: string;
    type: 'freshness' | 'schema' | 'quality' | 'custom';
    slaSeconds?: number;
  }): Promise<WriteBackResult>;
}

export interface GitHubConnector {
  openIssue(input: {
    repo: string;
    title: string;
    body: string;
    labels?: string[];
  }): Promise<{ url: string; number: number }>;
  openPR(input: {
    repo: string;
    title: string;
    body: string;
    branch: string;
    base: string;
    /** Sentinel NEVER merges — PDF §9.3.5 no-merge policy. */
  }): Promise<{ url: string; number: number }>;
}

export interface SlackConnector {
  postTriage(input: { channel: string; text: string }): Promise<{ ts: string; channel: string }>;
}

export interface Guardrail {
  /**
   * Check a proposed action against the governance policy.
   * Returns allowed=true to proceed; needsApproval=true to pause for human.
   * Refuses PII-tagged assets without prior approval. Never auto-merges PRs.
   * PDF §9.3.5 + §12.3.
   */
  check(input: {
    kind: 'github.openIssue' | 'github.openPR' | 'slack.postMessage' | 'datahub.write';
    assetUrn?: string;
    payload: unknown;
  }): Promise<{
    allowed: boolean;
    needsApproval: boolean;
    reason: string;
    /** Echoed back to the audit log. */
    action: unknown;
  }>;
}

export interface AuditLog {
  record(event: {
    incidentUrn: string;
    kind: unknown;
    summary: string;
    payload?: unknown;
  }): Promise<void>;
}

/**
 * The layered system prompt (PDF §9.4.4). Phase 2 assembles the layers from
 * `src/lib/agent/prompts/*.md`. Phase 0 ships the contract.
 */
export interface SystemPromptParts {
  role: string;
  workflow: string;
  governance: string;
  tools: string;
  assemble(): string;
}

/**
 * Phase 0 placeholder — the real ReAct loop is the Phase 2 deliverable.
 * The interface is stable; later phases fill the implementation.
 */
export class SentinelOrchestrator implements Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {
    if (!deps.llm) throw new Error('Orchestrator requires an LLM client');
    if (!deps.readTools) throw new Error('Orchestrator requires MCP read tools');
  }

  /**
   * PDF §9.4.2 incident lifecycle (15 steps), implemented as a ReAct loop.
   * Phase 0: not yet implemented — throws to make the contract obvious.
   * Phase 2 wires the real loop.
   */
  async handleSignal(_signal: Signal): Promise<Incident> {
    throw new Error(
      'SentinelOrchestrator.handleSignal is a Phase 2 deliverable. ' +
        'Phase 0 ships the interface only. See refined v2 plan Part D, Phase 2.',
    );
  }

  /**
   * Read the prior post-mortem for this asset, if any — the compounding beat
   * (PDF §12.2). Run 2 visibly reads Run 1's post-mortem.
   * Phase 2 implementation.
   */
  async readPriorPostMortem(_assetUrn: string): Promise<Assertion | null> {
    throw new Error('Phase 2 deliverable');
  }
}

export { type Signal, type ReasoningStep, type WriteBackResult, type Incident };
