// GET /api/guardrail/pending — list pending/decided approvals for the UI.
//
// Query params:
//   ?incidentUrn=...   — restrict to one incident
//   ?status=pending   — pending | approved | denied (default: all)
//   ?limit=50          — max rows
//
// PDF §10.3 approval-gate.ts: "returns a structured { needsApproval,
// reason, proposedAction, approver } object that surfaces in the UI".
import { NextResponse } from 'next/server'
import { listApprovals } from '@/lib/guardrail/approval-gate'
import { isDemoMode, demoFixture } from '@/lib/demo-mode'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  if (isDemoMode()) return NextResponse.json(demoFixture('guardrail-pending'))
  const url = new URL(req.url)
  const incidentUrn = url.searchParams.get('incidentUrn') || undefined
  const statusParam = url.searchParams.get('status')
  const status =
    statusParam === 'pending' || statusParam === 'approved' || statusParam === 'denied'
      ? statusParam
      : undefined
  const limitParam = url.searchParams.get('limit')
  const limit = limitParam ? Math.min(200, Math.max(1, parseInt(limitParam, 10) || 50)) : 50
  const approvals = await listApprovals({ incidentUrn, status, limit })
  return NextResponse.json({ approvals })
}
