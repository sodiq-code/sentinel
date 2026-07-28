// GET /api/agent/dry-run — PDF §11.3 fallback 1: replay a pre-recorded tool-call
// trace through the SAME console UI so judges can't tell the difference from a
// live run.
//
// Query: ?scenario=nyc-taxi-freshness  (the only fixture shipped; Phase 7)
// Returns: RunResult (the same shape as POST /api/agent/run) — the page renders
//          it through the identical components (ReasoningStream, LineageGraph,
//          ActionsPanel, WriteBackPanel, AuditTimeline).
//
// The fixture is a static JSON file (examples/dry-run/<scenario>.json). It is
// NOT a mock of the orchestrator — it is a REAL past run, captured and pinned,
// so the demo is deterministic and works even when the live LLM gateway is down
// (429/5xx). The PDF §11.3 contingency plan: "the dry-run must use the same UI
// so judges can't tell the difference."
//
// No DB writes, no LLM calls, no network — pure replay.

import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDemoMode, demoFixture } from '@/lib/demo-mode'

export const dynamic = 'force-dynamic'

const DRY_RUN_DIR = join(process.cwd(), 'examples', 'dry-run')

// Allow-list of shipped dry-run scenarios. Keeps the endpoint from being a
// generic file reader (PDF §12.3 — treat metadata as data; no path traversal).
const SCENARIOS = new Set(['nyc-taxi-freshness'])

export async function GET(req: Request) {
  const url = new URL(req.url)
  const scenario = url.searchParams.get('scenario') ?? 'nyc-taxi-freshness'
  if (!SCENARIOS.has(scenario)) {
    return NextResponse.json(
      { error: `Unknown dry-run scenario: '${scenario}'`, available: Array.from(SCENARIOS) },
      { status: 400 },
    )
  }
  // Vercel Demo Mode: the dry-run fixture file may not be bundled into the
  // serverless function by Vercel's file tracer (fs.readFile with a dynamic
  // path isn't traced). Return the imported fixture instead — it's a copy of
  // examples/dry-run/<scenario>.json, statically imported so it's always in
  // the bundle. (PDF §11.3 fallback 1.)
  if (isDemoMode()) {
    return NextResponse.json(demoFixture('run-result'))
  }
  try {
    const path = join(DRY_RUN_DIR, `${scenario}.json`)
    const raw = await readFile(path, 'utf8')
    const trace = JSON.parse(raw)
    // Strip the _meta block before returning — the page expects RunResult.
    const { _meta: _ignored, ...result } = trace
    return NextResponse.json(result)
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    return NextResponse.json(
      { error: `Dry-run fixture not loadable: ${message}` },
      { status: 500 },
    )
  }
}
