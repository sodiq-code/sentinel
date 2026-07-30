// POST /api/agent/writeback — re-attempt a failed write-back through the
// dual path (Agent Context Kit → REST ingestion fallback), or write a new
// post-mortem doc on demand. Used by the console's "Re-attempt" button on a
// failed write-back card.
//
// Body (one of):
//   { writeBackId }                       — re-attempt a stored failed WriteBack
//   { incidentUrn, assetUrn, title, content } — write a new post-mortem doc
//
// Returns: { ok, outcome: WriteBackDocumentOutcome }

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getDataHub } from '@/lib/datahub'
import { getAudit } from '@/lib/agent/audit'
import { writeBackDocument } from '@/lib/agent/writeback'
import { isPreviewMode, previewFixture } from '@/lib/demo-mode'
import { ensureSeeded } from '@/lib/ensure-seeded'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

interface ReattemptBody {
  writeBackId?: string
  incidentUrn?: string
  assetUrn?: string
  title?: string
  content?: string
  format?: 'markdown' | 'html' | 'plaintext'
  authorUrn?: string
}

export async function POST(req: Request) {
  if (isPreviewMode()) return NextResponse.json(previewFixture('writeback'))
  await ensureSeeded()
  let body: ReattemptBody
  try {
    body = (await req.json()) as ReattemptBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  let incidentUrn = body.incidentUrn
  let assetUrn = body.assetUrn
  let title = body.title
  let content = body.content

  // Re-attempt path: load the failed WriteBack row + its stored payload.
  if (body.writeBackId && !incidentUrn) {
    const row = await db.writeBack.findUnique({ where: { id: body.writeBackId } })
    if (!row) {
      return NextResponse.json({ error: 'WriteBack not found' }, { status: 404 })
    }
    incidentUrn = row.incidentUrn
    const data = safeParse(row.dataJson)
    assetUrn = (data?.assetUrn as string) ?? body.assetUrn
    title = (data?.title as string) ?? body.title
    // The stored payload does not keep the full content (to keep the row small).
    // For a re-attempt the operator must re-supply content, OR we synthesize a
    // minimal stub noting this is a re-attempt.
    content = body.content ?? `# Sentinel Post-Mortem (re-attempt)\n\n${title ?? ''}\n`
  }

  if (!incidentUrn || !assetUrn || !title || !content) {
    return NextResponse.json(
      {
        error: 'Missing fields',
        required: ['incidentUrn', 'assetUrn', 'title', 'content'],
        hint: 'Either provide writeBackId, or all four of incidentUrn/assetUrn/title/content.',
      },
      { status: 400 },
    )
  }

  try {
    const clients = await getDataHub()
    const outcome = await writeBackDocument({
      clients,
      incidentUrn,
      assetUrn,
      title,
      content,
      format: body.format ?? 'markdown',
      authorUrn: body.authorUrn,
      sentinelPostMortem: true,
      audit: getAudit(),
    })
    return NextResponse.json({ ok: true, outcome })
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

function safeParse(s: string | null | undefined): Record<string, unknown> | null {
  if (!s) return null
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return null
  }
}
