// =============================================================================
// Sentinel — Guardrail barrel (Phase 3)
//
// Exports the four guardrail modules:
//   policy.ts      — policy DSL (rules: no-merge, direct-write allowlist, action gate)
//   pii-check.ts   — PII tag detection via MCP get_entities
//   approval-gate  — PendingApproval persistence + approve/deny/list
//   pre-exec.ts    — checkBeforeExecute hook + recordGuardrailCheck audit
//
// The orchestrator imports `checkBeforeExecute` + `recordGuardrailCheck`
// and calls them in the ReAct loop before every tool_call.
// =============================================================================

export * from './policy'
export * from './pii-check'
export * from './approval-gate'
export * from './pre-exec'
