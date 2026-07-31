/**
 * Sentinel — Orchestrator (the ReAct reasoning loop).
 *
 * Single orchestrator + tools, with a layered prompt architecture.
 *
 * The public interface and the structure of the ReAct loop are wired to the
 * LLM client, tool registry, guardrail, connectors, and write-back.
 *
 * Blueprint fidelity:
 *  - One LLM provider, temperature 0.
 *  - Visible reasoning: every intermediate step is observable.
 *  - Retry with exponential backoff on any tool failure.
 *  - Structured tool-call inputs, never free-text execution
 *    (prompt-injection mitigation).
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
 */
export interface OrchestratorDeps {
  /** LLM client (NVIDIA NIM, OpenAI-compatible). */
  readonly llm: LlmClient;
  /** Read tools (12 MCP tools). */
  readonly readTools: McpReadTools;
  /** Write tools (7 Agent Context Kit tools + REST fallback). */
  readonly writeTools: WriteBackTools;
  /** Action connectors. */
  readonly github: GitHubConnector;
  readonly slack: SlackConnector;
  /** Guardrail. */
  readonly guardrail: Guardrail;
  /** Audit log. */
  readonly audit: AuditLog;
  /** Reasoning stream — called on every step for the live console. */
  readonly onReasoningStep?: (step: ReasoningStep) => void;
}

export interface LlmClient {
  /**
   * One LLM completion with tool-calling.
   * POST to NVIDIA NIM `chat/completions` with the OpenAI-compatible
   * schema, model `nvidia/llama-3.3-nemotron-super-49b-v1`, temperature 0,
   * tools = the catalogue, tool_choice 'auto'. Fallback to
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
  /** Dual write-back path. Try Agent Context Kit; on failure → REST ingestion. */
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
    /** Sentinel NEVER merges (no-merge policy). */
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
 * The layered system prompt. Assembles the layers from
 * `src/lib/agent/prompts/*.md`.
 */
export interface SystemPromptParts {
  role: string;
  workflow: string;
  governance: string;
  tools: string;
  assemble(): string;
}

/**
 * Stable interface for the ReAct loop. The runtime implementation is
 * provided separately; the interface is the stable contract surface.
 */
export class SentinelOrchestrator implements Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {
    if (!deps.llm) throw new Error('Orchestrator requires an LLM client');
    if (!deps.readTools) throw new Error('Orchestrator requires MCP read tools');
  }

  /**
   * Incident lifecycle (15 steps), implemented as a ReAct loop.
   * Not yet implemented — throws to make the contract obvious.
   */
  async handleSignal(_signal: Signal): Promise<Incident> {
    throw new Error(
      'SentinelOrchestrator.handleSignal is not implemented. ' +
        'The interface ships as the stable contract.',
    );
  }

  /**
   * Read the prior post-mortem for this asset, if any — the compounding beat.
   * Run 2 visibly reads Run 1's post-mortem.
   */
  async readPriorPostMortem(_assetUrn: string): Promise<Assertion | null> {
    throw new Error('Not implemented');
  }
}

export { type Signal, type ReasoningStep, type WriteBackResult, type Incident };
