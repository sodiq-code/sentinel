import { NextResponse } from 'next/server'
import { getDataHub } from '@/lib/datahub'

export const dynamic = 'force-dynamic'

// GET /api/datahub/asset?urn=<urn>
// Exercises MockMcpClient.get_entities() + list_schema_fields().
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const urn = searchParams.get('urn')
  if (!urn) {
    return NextResponse.json({ error: 'missing required `urn` query param' }, { status: 400 })
  }
  const { mcp } = await getDataHub()
  const [entities, fields] = await Promise.all([
    mcp.get_entities([urn]),
    mcp.list_schema_fields(urn),
  ])
  return NextResponse.json({ entity: entities[0] ?? null, schemaFields: fields })
}
