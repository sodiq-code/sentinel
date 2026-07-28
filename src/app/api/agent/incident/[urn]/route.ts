// GET /api/agent/incident/[urn] — hydrate a full incident (reasoning trace +
// tool calls + actions + write-backs + audit events) for the console.

import { NextResponse } from 'next/server'
import { hydrateIncident } from '@/lib/agent'
import { isDemoMode, demoFixture } from '@/lib/demo-mode'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: { params: Promise<{ urn: string }> }) {
  if (isDemoMode()) return NextResponse.json(demoFixture('incident-detail'))
  const { urn } = await ctx.params
  if (!urn) return NextResponse.json({ error: 'Missing urn' }, { status: 400 })
  // The urn arrives URL-encoded from the path; decode it.
  const decoded = decodeURIComponent(urn)
  const hydrated = await hydrateIncident(decoded)
  if (!hydrated) return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  return NextResponse.json(hydrated)
}
