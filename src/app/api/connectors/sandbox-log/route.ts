// GET /api/connectors/sandbox-log — return the last N sandbox log entries
// for the DemoControlBar's "Sandbox log" viewer.
//
// Query params:
//   ?kind=github|slack  — which log (default: github)
//   ?limit=50           — max entries (newest last)
import { NextResponse } from 'next/server'
import { readSandboxLog } from '@/lib/connectors/_sandbox'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const kindParam = url.searchParams.get('kind')
  const kind: 'github' | 'slack' = kindParam === 'slack' ? 'slack' : 'github'
  const limitParam = url.searchParams.get('limit')
  const limit = limitParam ? Math.min(200, Math.max(1, parseInt(limitParam, 10) || 50)) : 50
  const entries = await readSandboxLog(kind, limit)
  return NextResponse.json({ kind, entries })
}
