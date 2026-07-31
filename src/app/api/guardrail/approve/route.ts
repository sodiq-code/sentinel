// POST /api/guardrail/approve — mark a pending approval as approved.
//
// Body: { id: string, approverUrn: string }
// Audit log — records WHO approved what. In the demo we do NOT
// re-execute the action automatically (the operator re-triggers the run if
// they want); we just mark the decision so the audit trail is complete.
import { NextResponse } from 'next/server'
import { approveApproval } from '@/lib/guardrail/approval-gate'
import { isPreviewMode, previewFixture } from '@/lib/demo-mode'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  if (isPreviewMode()) return NextResponse.json(previewFixture('guardrail-approve'))
  let body: { id?: string; approverUrn?: string }
  try {
    body = (await req.json()) as { id?: string; approverUrn?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body.id || !body.approverUrn) {
    return NextResponse.json(
      { error: 'Missing required fields: id, approverUrn' },
      { status: 400 },
    )
  }
  try {
    const decision = await approveApproval({
      id: body.id,
      approverUrn: body.approverUrn,
    })
    return NextResponse.json({ decision })
  } catch (err) {
    return NextResponse.json(
      { error: `Approval failed: ${(err as Error).message}` },
      { status: 500 },
    )
  }
}
