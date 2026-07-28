// GET /api/agent/signals — list the injectable seed signals (the Phase 2 demo inputs).

import { NextResponse } from 'next/server'
import { listSeedSignals } from '@/lib/agent'
import { isPreviewMode, previewFixture } from '@/lib/demo-mode'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (isPreviewMode()) return NextResponse.json(previewFixture('signals'))
  const signals = await listSeedSignals()
  return NextResponse.json({
    signals: signals.map((s) => ({
      id: s.id,
      scenarioId: s.scenarioId,
      label: s.label,
      description: s.description,
      assetUrn: s.assetUrn,
      assetName: s.assetName,
      type: s.type,
      status: s.status,
      assertionDescription: s.assertionDescription,
      failureReason: s.failureReason,
    })),
  })
}
