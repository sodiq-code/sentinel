// =============================================================================
// Sentinel — Agent package barrel
// =============================================================================

export { getLlm, getLlmProvider, getLlmModel, getLlmResilienceStatus, CircuitOpenError } from './llm'
export type { LlmProvider } from './llm'
export { assembleSystemPrompt, loadPromptParts, PROMPT_VERSION, PROMPTS_DIR } from './prompts/system-prompt'
export { buildToolCatalogue, toLlmTools, executeToolCall, TOOL_CATALOGUE, TOOL_NAMES } from './tools'
export type { ToolDefinition, ToolContext, ToolExecResult } from './tools'
export { getAudit, getReasoningTrace, getLifecycleEvents, getAllAuditEvents } from './audit'
export { listSeedSignals, buildSignal, buildInitialUserMessage } from './seed-signals'
export type { InjectableSignal } from './seed-signals'
export { runSentinel, runSentinelOnSeedSignal, hydrateIncident, listIncidents } from './orchestrator'
export type { OrchestratorResult, RunOptions } from './orchestrator'
export { writeBackDocument } from './writeback'
export type { WriteBackDocumentInput, WriteBackDocumentOutcome, WriteBackPath, WriteBackStatus } from './writeback'
export { getAuditMirror, getAuditMirrorMode, countMirroredForIncident, MIRRORED_KINDS } from './audit-mirror'
export type { AuditMirror, AuditMirrorMode, MirrorInput, MirrorResult } from './audit-mirror'
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
