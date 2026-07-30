// GET /api/datahub/document/[urn] — fetch a single context doc (post-mortem)
// by its DataHub URN. Used by the "View in DataHub" link on the WritebackDetailCard.
//
// In DEMO mode the doc is read from the Prisma seed (SeedContextDoc). In LIVE
// mode it would call the DataHub GraphQL API. Returns the doc + a flag
// indicating whether the doc is a Sentinel post-mortem.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getDataHubMode } from '@/lib/datahub'
import { isPreviewMode } from '@/lib/demo-mode'

export const dynamic = 'force-dynamic'

function decodeUrn(urn: string): string {
  try {
    return decodeURIComponent(urn)
  } catch {
    return urn
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ urn: string }> }) {
  if (isPreviewMode()) {
    return NextResponse.json({
      found: false,
      mode: 'preview',
      message: 'Preview mode — no live doc.',
    })
  }
  const { urn: rawUrn } = await params
  const urn = decodeUrn(rawUrn)
  const mode = getDataHubMode()

  // DEMO mode — read from the Prisma seed.
  if (mode === 'demo') {
    const doc = await db.seedContextDoc.findUnique({ where: { urn } })
    if (!doc) {
      return NextResponse.json(
        { found: false, mode, urn, message: 'Document not found in the local DataHub seed.' },
        { status: 404 },
      )
    }
    return NextResponse.json({
      found: true,
      mode,
      urn: doc.urn,
      title: doc.title,
      content: doc.content,
      format: doc.format,
      createdAt: doc.createdAt.toISOString(),
      authorUrn: doc.authorUrn,
      authorName: doc.authorName,
      assetUrn: doc.assetUrn,
      sentinelPostMortem: doc.sentinelPostMortem,
    })
  }

  // LIVE mode — would call DataHub GraphQL. Not wired in this demo.
  return NextResponse.json(
    { found: false, mode, urn, message: 'LIVE DataHub document fetch not implemented in this demo.' },
    { status: 501 },
  )
}
