// =============================================================================
// Sentinel — Connectors barrel
//
// Two action connectors:
//   github — openIssue + openPR (NEVER merges) against the demo repo
//   slack  — postTriage (chat.postMessage) against the demo channel
//
// Both honor SENTINEL_DRY_RUN=true (default) — trace mode writes JSONL
// to `examples/trace/{kind}-actions.log` instead of calling the live API.
// Fallback path: the dry-run toggle is exposed in the DemoControlBar.
// =============================================================================

export * from './github'
export * from './slack'
export * from './_trace'
