// POST /api/agent/run — inject a seed signal and run the Sentinel orchestrator
// end-to-end. Returns the resolved incident with the full reasoning trace.
//
// Body: { "signalId": "sig:nyc-taxi:freshness" | "sig:showcase:schema" | "sig:pii:refusal" }
// Returns: OrchestratorResult { incident, steps, totalTokens, llmModel, promptVersion }

import { NextResponse } from 'next/server'
import { runSentinelOnSeedSignal, listSeedSignals } from '@/lib/agent'
import { isPreviewMode, previewFixture } from '@/lib/demo-mode'
import { ensureSeeded } from '@/lib/ensure-seeded'

export const dynamic = 'force-dynamic'
// The loop may take 10-40s when the LLM is healthy. With 429 retries (up to
// 35s Retry-After backoff + the call), a single run can take up to ~90s.
// Vercel Pro supports up to 300s; Hobby supports 60s. Set to 120 so a
// single Retry-After cycle fits on Pro without the function timing out.
export const maxDuration = 120

export async function POST(req: Request) {
  if (isPreviewMode()) return NextResponse.json(previewFixture('run-result'))
  await ensureSeeded()
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
