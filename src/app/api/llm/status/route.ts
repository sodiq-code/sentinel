// GET /api/llm/status — resilience: LLM circuit + failover state.
//
// Returns the live state of the LLM resilience layer so the UI can show a
// circuit-state chip alongside the existing "LLM model / Provider" chips.
//
//   provider:         'gemini' | 'groq' | 'zai' | 'nvidia'
//   model:            the configured primary model
//   failoverEnabled:  bool — whether the primary can fail over to the
//                     configured fallback provider (LLM_FALLBACK_PROVIDER)
//                     when its circuit opens. Production default: Gemini
//                     primary → Groq fallback.
//   hasNvidiaKey:     bool
//   hasGroqKey:       bool
//   circuit:          { isOpen, consecutiveFailures, msUntilReset } | null
//                     — null until the first LLM call instantiates the client
//
// Read-only. Never throws. (retry visibility +
// fallback path: surface throttle state to the operator, don't mask it).
import { NextResponse } from 'next/server'
import { getLlmResilienceStatus } from '@/lib/agent/llm'
import { isPreviewMode, previewFixture } from '@/lib/demo-mode'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (isPreviewMode()) return NextResponse.json(previewFixture('llm-status'))
  return NextResponse.json(getLlmResilienceStatus())
}
