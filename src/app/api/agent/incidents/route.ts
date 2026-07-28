// GET /api/agent/incidents — list recent incidents with summary counts.

import { NextResponse } from 'next/server'
import { listIncidents } from '@/lib/agent'
import { isPreviewMode, previewFixture } from '@/lib/demo-mode'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  if (isPreviewMode()) return NextResponse.json(previewFixture('incidents'))
  const url = new URL(req.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 50)
  const incidents = await listIncidents(limit)
  return NextResponse.json({ incidents })
}
