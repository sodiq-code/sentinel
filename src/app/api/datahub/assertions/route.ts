import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSeeded } from '@/lib/ensure-seeded'

export const dynamic = 'force-dynamic'

// GET /api/datahub/assertions?urn=<optional asset urn>
// Returns seeded assertions (optionally filtered to one asset).
export async function GET(request: Request) {
  await ensureSeeded()
  const { searchParams } = new URL(request.url)
  const assetUrn = searchParams.get('urn') ?? undefined
  const where = assetUrn ? { assetUrn } : undefined
  const rows = await db.seedAssertion.findMany({ where, orderBy: { lastEvaluatedAt: 'desc' } })
  return NextResponse.json({
    count: rows.length,
    failing: rows.filter((r) => r.status === 'failing').length,
    assertions: rows.map((r) => ({
      urn: r.urn,
      assetUrn: r.assetUrn,
      type: r.type,
      status: r.status,
      description: r.description,
      slaSeconds: r.slaSeconds ?? undefined,
      lastEvaluatedAt: r.lastEvaluatedAt.toISOString(),
      lastSuccessAt: r.lastSuccessAt?.toISOString(),
      failureReason: r.failureReason ?? undefined,
      scenarioId: r.scenarioId,
    })),
  })
}
