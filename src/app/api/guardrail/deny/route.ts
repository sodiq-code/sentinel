// POST /api/guardrail/deny — mark a pending approval as denied.
//
// Body: { id: string, approverUrn: string }
import { NextResponse } from 'next/server'
import { denyApproval } from '@/lib/guardrail/approval-gate'
import { isPreviewMode, previewFixture } from '@/lib/demo-mode'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  if (isPreviewMode()) return NextResponse.json(previewFixture('guardrail-deny'))
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
    const decision = await denyApproval({
      id: body.id,
      approverUrn: body.approverUrn,
    })
    return NextResponse.json({ decision })
  } catch (err) {
    return NextResponse.json(
      { error: `Denial failed: ${(err as Error).message}` },
      { status: 500 },
    )
  }
}
