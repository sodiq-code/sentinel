// GET /api/agent/incidents — list recent incidents with summary counts.

import { NextResponse } from 'next/server'
import { listIncidents } from '@/lib/agent'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 50)
  const incidents = await listIncidents(limit)
  return NextResponse.json({ incidents })
}
