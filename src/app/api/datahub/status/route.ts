import { NextResponse } from 'next/server'
import { getDataHub, getDataHubMode, isSeeded } from '@/lib/datahub'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/datahub/status
// Returns the mode (demo|live), seeded bool, and counts for the Phase 1 status UI.
export async function GET() {
  const mode = getDataHubMode()
  const seeded = await isSeeded()
  let counts: { assets: number; lineageEdges: number; assertions: number; contextDocs: number; failingAssertions: number } | undefined
  if (seeded) {
    const [assets, lineageEdges, assertions, contextDocs, failingAssertions] = await Promise.all([
      db.seedAsset.count(),
      db.seedLineageEdge.count(),
      db.seedAssertion.count(),
      db.seedContextDoc.count(),
      db.seedAssertion.count({ where: { status: 'failing' } }),
    ])
    counts = { assets, lineageEdges, assertions, contextDocs, failingAssertions }
  }
  const clients = await getDataHub()
  return NextResponse.json({
    mode: clients.mode,
    liveModeAvailable: mode === 'live',
    seeded,
    counts,
    scenarios: ['nyc-taxi-freshness', 'showcase-ecommerce', 'pii'],
    phase: 1,
    message: 'Sentinel Phase 1 — DataHub Mock + Seed',
  })
}
