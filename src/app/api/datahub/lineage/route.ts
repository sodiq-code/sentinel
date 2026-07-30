import { NextResponse } from 'next/server'
import { getDataHub } from '@/lib/datahub'

export const dynamic = 'force-dynamic'

// GET /api/datahub/lineage?urn=<urn>&direction=upstream|downstream&maxHops=<n>
// Exercises MockMcpClient.get_lineage() against the seeded edges.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const urn = searchParams.get('urn')
  const direction = (searchParams.get('direction') ?? 'downstream') as 'upstream' | 'downstream'
  const maxHops = Number(searchParams.get('maxHops') ?? '3')
  if (!urn) {
    return NextResponse.json({ error: 'missing required `urn` query param' }, { status: 400 })
  }
  const { mcp } = await getDataHub()
  const lineage = await mcp.get_lineage(urn, direction, { maxHops })
  return NextResponse.json(lineage)
}
