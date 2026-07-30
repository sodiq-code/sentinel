import { NextResponse } from 'next/server'
import { getDataHub } from '@/lib/datahub'

export const dynamic = 'force-dynamic'

// GET /api/datahub/search?q=<query>&type=<optional>&platform=<optional>
// Exercises MockMcpClient.search() against the seeded assets.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q') ?? ''
  const type = searchParams.get('type') ?? undefined
  const platform = searchParams.get('platform') ?? undefined
  const { mcp } = await getDataHub()
  const results = await mcp.search(q, {
    filterType: type as never,
    filterPlatform: platform ?? undefined,
    count: 50,
  })
  return NextResponse.json({ query: q, count: results.length, results })
}
