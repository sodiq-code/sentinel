import { NextResponse } from 'next/server'
import { printLineage } from '@/lib/datahub/mock/mock-datahub'

export const dynamic = 'force-dynamic'

// GET /api/datahub/print-lineage?urn=<urn>&direction=upstream|downstream&maxHops=<n>
// Returns the ASCII lineage tree as plain text. This is the HTTP version of the
// "script that prints lineage" deliverable, exposed so the incident
// console UI can show it inline.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const urn = searchParams.get('urn')
  if (!urn) {
    return NextResponse.json({ error: 'missing required `urn` query param' }, { status: 400 })
  }
  const direction = (searchParams.get('direction') ?? 'downstream') as 'upstream' | 'downstream'
  const maxHops = Number(searchParams.get('maxHops') ?? '3')
  const tree = await printLineage(urn, direction, maxHops)
  return new NextResponse(tree, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
