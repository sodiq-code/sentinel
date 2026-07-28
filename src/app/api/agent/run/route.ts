// POST /api/agent/run — inject a seed signal and run the Sentinel orchestrator
// end-to-end. Returns the resolved incident with the full reasoning trace.
//
// Body: { "signalId": "sig:nyc-taxi:freshness" | "sig:showcase:schema" | "sig:pii:refusal" }
// Returns: OrchestratorResult { incident, steps, totalTokens, llmModel, promptVersion }

import { NextResponse } from 'next/server'
import { runSentinelOnSeedSignal, listSeedSignals } from '@/lib/agent'
import { isDemoMode, demoFixture } from '@/lib/demo-mode'

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // the loop may take 10-40s with NVIDIA

export async function POST(req: Request) {
  if (isDemoMode()) return NextResponse.json(demoFixture('run-result'))
  let body: { signalId?: string }
  try {
    body = (await req.json()) as { signalId?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const signalId = body.signalId
  if (!signalId) {
    const available = await listSeedSignals()
    return NextResponse.json(
      {
        error: 'Missing signalId',
        available: available.map((s) => ({ id: s.id, label: s.label })),
      },
      { status: 400 },
    )
  }
  try {
    const result = await runSentinelOnSeedSignal(signalId)
    return NextResponse.json(result)
  } catch (err) {
    const message = (err as Error).message ?? String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
