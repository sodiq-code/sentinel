// GET  /api/settings        — read the current effective settings
// PATCH /api/settings       — update a setting (body: { dryRun?: boolean })
//
// The DB-backed settings survive across requests + warm lambdas, so a UI
// toggle takes effect immediately without a redeploy. Env vars remain the
// deployment default; the DB override wins when present.
import { NextResponse } from 'next/server'
import { getSettings, setDryRun, resetDryRun } from '@/lib/settings'
import { isPreviewMode, previewFixture } from '@/lib/demo-mode'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (isPreviewMode()) {
    return NextResponse.json({ dryRun: true, dryRunOverridden: false, ...(previewFixture('connectors-status') as object) })
  }
  const settings = await getSettings()
  return NextResponse.json(settings)
}

export async function PATCH(req: Request) {
  if (isPreviewMode()) {
    return NextResponse.json({ dryRun: true, dryRunOverridden: false })
  }
  let body: { dryRun?: boolean; resetDryRun?: boolean } = {}
  try {
    body = (await req.json()) as { dryRun?: boolean; resetDryRun?: boolean }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  try {
    if (body.resetDryRun) {
      const s = await resetDryRun()
      return NextResponse.json(s)
    }
    if (typeof body.dryRun === 'boolean') {
      const s = await setDryRun(body.dryRun)
      return NextResponse.json(s)
    }
    return NextResponse.json({ error: 'Provide { dryRun: boolean } or { resetDryRun: true }' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
