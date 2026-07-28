// GET /api/llm/status — Phase 3 resilience: LLM circuit + failover state.
//
// Returns the live state of the LLM resilience layer so the UI can show a
// circuit-state chip alongside the existing "LLM model / Provider" chips.
//
//   provider:         'zai' | 'nvidia'
//   model:            the configured primary model
//   failoverEnabled:  bool — whether the z-ai primary can fail over to the
//                     dormant NVIDIA client (only true when LLM_PROVIDER=zai
//                     AND LLM_FAILOVER_ENABLED AND a NVIDIA key is present)
//   hasNvidiaKey:     bool
//   circuit:          { isOpen, consecutiveFailures, msUntilReset } | null
//                     — null until the first LLM call instantiates the client
//
// Read-only. Never throws. PDF §9.5.4 (retry visibility) + §11.3 (contingency
// plan: surface throttle state to the operator, don't mask it).
import { NextResponse } from 'next/server'
import { getLlmResilienceStatus } from '@/lib/agent/llm'
import { isDemoMode, demoFixture } from '@/lib/demo-mode'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (isDemoMode()) return NextResponse.json(demoFixture('llm-status'))
  return NextResponse.json(getLlmResilienceStatus())
}
