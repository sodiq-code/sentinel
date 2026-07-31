import { NextResponse } from 'next/server'
import { getSeedOverview } from '@/lib/datahub/mock/mock-datahub'

export const dynamic = 'force-dynamic'

// GET /api/datahub/seed/overview
// Returns the whole seeded DataHub graph (assets, lineage edges, assertions,
// context docs) grouped by scenario. Powers the status UI's graph
// renderer.
export async function GET() {
  const overview = await getSeedOverview()
  return NextResponse.json(overview)
}
