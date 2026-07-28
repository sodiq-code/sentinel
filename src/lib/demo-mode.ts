// =============================================================================
// Sentinel — Vercel Demo Replay mode helper (Phase: Vercel Deploy)
//
// When VERCEL_DEMO_MODE=true, every API route the console calls returns a
// pinned fixture derived from the Phase 7 dry-run trace
// (examples/dry-run/nyc-taxi-freshness.json) instead of touching the DB or
// the live LLM gateway.
//
// Why this exists (PDF §11.3 contingency plan):
//   The z-ai-web-dev-sdk gateway (internal-api.z.ai) is only reachable from
//   inside the z.ai build sandbox. On Vercel's servers the live LLM calls
//   would fail. SQLite (file:./prisma/dev.db) also cannot persist on
//   Vercel's ephemeral, read-only function filesystem. Rather than ship a
//   broken live demo, we ship a Vercel-safe READ-ONLY preview that replays
//   the EXACT same closed-loop trace through the SAME console UI. Judges
//   get a public URL to explore the full dashboard, reasoning trace,
//   lineage graph, persona, actions, write-backs, audit log, roadmap,
//   skill, and RFC. The live agent demo (with the real LLM) continues to
//   run on the sandbox link — both are linked from the README.
//
// This file is SERVER-ONLY. It is imported exclusively by App Router API
// route handlers (src/app/api/**). The console (src/app/page.tsx) reads
// NEXT_PUBLIC_VERCEL_DEMO_MODE directly at build time and never imports
// this module, so the JSON fixtures are never bundled client-side.
//
// All fixtures share one incident URN
// (urn:li:incident:sentinel:dryrun:0001) so the page's after-run +
// click-incident flows are internally consistent. Regenerate with:
//   bun run scripts/gen-demo-fixtures.ts
// =============================================================================

import signalsFixture from '../../examples/demo-replay/signals.json'
import incidentsFixture from '../../examples/demo-replay/incidents.json'
import runResultFixture from '../../examples/demo-replay/run-result.json'
import incidentDetailFixture from '../../examples/demo-replay/incident-detail.json'
import auditFixture from '../../examples/demo-replay/audit.json'
import connectorsStatusFixture from '../../examples/demo-replay/connectors-status.json'
import llmStatusFixture from '../../examples/demo-replay/llm-status.json'
import connectorsTestFixture from '../../examples/demo-replay/connectors-test.json'
import writebackFixture from '../../examples/demo-replay/writeback.json'
import guardrailPendingFixture from '../../examples/demo-replay/guardrail-pending.json'
import guardrailApproveFixture from '../../examples/demo-replay/guardrail-approve.json'
import guardrailDenyFixture from '../../examples/demo-replay/guardrail-deny.json'

/** True when running on Vercel in read-only demo replay mode. */
export function isDemoMode(): boolean {
  return process.env.VERCEL_DEMO_MODE === 'true'
}

// Fixture registry — keyed by the short name each route uses.
const FIXTURES = {
  signals: signalsFixture,
  incidents: incidentsFixture,
  'run-result': runResultFixture,
  'incident-detail': incidentDetailFixture,
  audit: auditFixture,
  'connectors-status': connectorsStatusFixture,
  'llm-status': llmStatusFixture,
  'connectors-test': connectorsTestFixture,
  writeback: writebackFixture,
  'guardrail-pending': guardrailPendingFixture,
  'guardrail-approve': guardrailApproveFixture,
  'guardrail-deny': guardrailDenyFixture,
} as const

export type DemoFixtureName = keyof typeof FIXTURES

/** Load a demo replay fixture by name. Returns the parsed JSON object. */
export function demoFixture<T = unknown>(name: DemoFixtureName): T {
  return FIXTURES[name] as T
}
