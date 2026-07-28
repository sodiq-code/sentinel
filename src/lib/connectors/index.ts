// =============================================================================
// Sentinel — Connectors barrel (Phase 3)
//
// Two action connectors:
//   github — openIssue + openPR (NEVER merges) against the sandbox repo
//   slack  — postTriage (chat.postMessage) against the sandbox channel
//
// Both honor SENTINEL_DRY_RUN=true (default) — the sandbox mode writes JSONL
// to `examples/sandbox/{kind}-actions.log` instead of calling the live API.
// PDF §11.3 contingency plan: the dry-run toggle is exposed in the DemoControlBar.
// =============================================================================

export * from './github'
export * from './slack'
export * from './_sandbox'
