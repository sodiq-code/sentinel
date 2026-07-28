// =============================================================================
// Sentinel — Agent package barrel
// =============================================================================

export { getLlm, NvidiaNimLlmClient, BASE_URL as LLM_BASE_URL, PRIMARY_MODEL as LLM_PRIMARY_MODEL, FALLBACK_MODEL as LLM_FALLBACK_MODEL } from './llm'
export { assembleSystemPrompt, loadPromptParts, PROMPT_VERSION, PROMPTS_DIR } from './prompts/system-prompt'
export { buildToolCatalogue, toLlmTools, executeToolCall, TOOL_CATALOGUE, TOOL_NAMES } from './tools'
export type { ToolDefinition, ToolContext, ToolExecResult } from './tools'
export { getAudit, getReasoningTrace, getLifecycleEvents, getAllAuditEvents } from './audit'
export { listSeedSignals, buildSignal, buildInitialUserMessage } from './seed-signals'
export type { InjectableSignal } from './seed-signals'
export { runSentinel, runSentinelOnSeedSignal, hydrateIncident, listIncidents } from './orchestrator'
export type { OrchestratorResult, RunOptions } from './orchestrator'
export type {
  LlmClient,
  LlmMessage,
  LlmTool,
  LlmToolCall,
  LlmCompletion,
  Signal,
  Incident,
  IncidentStatus,
  ReasoningStep,
  ReasoningStepKind,
  PendingApproval,
  ProposedAction,
  AuditEvent,
  AuditEventKind,
  WriteBackResult,
  Urn,
  Entity,
  AssertionType,
  AssertionRecord,
} from './types'
