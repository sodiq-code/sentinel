// =============================================================================
// Sentinel — Connectors barrel (Phase 3)
//
// Two action connectors:
//   github — openIssue + openPR (NEVER merges) against the demo repo
//   slack  — postTriage (chat.postMessage) against the demo channel
//
// Both honor SENTINEL_DRY_RUN=true (default) — trace mode writes JSONL
// to `examples/trace/{kind}-actions.log` instead of calling the live API.
// PDF §11.3 contingency plan: the dry-run toggle is exposed in the DemoControlBar.
// =============================================================================

export * from './github'
export * from './slack'
export * from './_trace'
