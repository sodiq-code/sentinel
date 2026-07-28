// =============================================================================
// Sentinel — Vercel preview mode helper
//
// The Sentinel console runs live in the sandbox (real LLM, real connectors,
// real write-backs). On Vercel's serverless runtime the sandbox-internal LLM
// gateway is unreachable and SQLite is ephemeral, so a second read-only path
// is used: every API route returns a pinned, pre-recorded run derived from the
// Phase 7 dry-run trace. The page auto-populates on first load so a visitor
// lands on a fully-rendered incident console without clicking anything.
//
// This file is server-only. It is inert in the sandbox (VERCEL_DEMO_MODE is
// unset there) — every guard is a no-op and the live agent runs unchanged.
// =============================================================================

import signalsFixture from "../../examples/demo-replay/signals.json";
import incidentsFixture from "../../examples/demo-replay/incidents.json";
import incidentDetailFixture from "../../examples/demo-replay/incident-detail.json";
import auditFixture from "../../examples/demo-replay/audit.json";
import runResultFixture from "../../examples/demo-replay/run-result.json";
import llmStatusFixture from "../../examples/demo-replay/llm-status.json";
import connectorsStatusFixture from "../../examples/demo-replay/connectors-status.json";
import connectorsTestFixture from "../../examples/demo-replay/connectors-test.json";
import writebackFixture from "../../examples/demo-replay/writeback.json";
import guardrailPendingFixture from "../../examples/demo-replay/guardrail-pending.json";
import guardrailApproveFixture from "../../examples/demo-replay/guardrail-approve.json";
import guardrailDenyFixture from "../../examples/demo-replay/guardrail-deny.json";

// Server-only guard. In the sandbox this is always false.
export function isPreviewMode(): boolean {
  return process.env.VERCEL_DEMO_MODE === "true";
}

const FIXTURES: Record<string, unknown> = {
  signals: signalsFixture,
  incidents: incidentsFixture,
  "incident-detail": incidentDetailFixture,
  audit: auditFixture,
  "run-result": runResultFixture,
  "llm-status": llmStatusFixture,
  "connectors-status": connectorsStatusFixture,
  "connectors-test": connectorsTestFixture,
  writeback: writebackFixture,
  "guardrail-pending": guardrailPendingFixture,
  "guardrail-approve": guardrailApproveFixture,
  "guardrail-deny": guardrailDenyFixture,
};

export function previewFixture(name: keyof typeof FIXTURES | string): unknown {
  return FIXTURES[name] ?? null;
}
