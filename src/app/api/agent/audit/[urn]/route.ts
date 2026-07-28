// GET /api/agent/audit/[urn] — the full audit log for an incident, with
// payloads. This is the "first-class audit log view" Phase 4 surfaces —
// the reasoning trace reconstruction lives in hydrateIncident, but the
// audit log itself (every lifecycle event, every tool call, every write-
// back) is its own deliverable (PDF §9.4.3 / §13.4).
//
// Returns: {
//   incidentUrn,
//   mode: 'demo' | 'live',
//   mirroredCount,                       — how many events were mirrored to DataHub Assertions
//   events: AuditEvent[],                 — ordered by ts ascending
//   lifecycleEvents: AuditEvent[],        — the subset that are lifecycle milestones
//   reasoningSteps: ReasoningStep[],      — the subset that are reasoning trace
// }

import { NextResponse } from 'next/server'
import { getReasoningTrace, getLifecycleEvents } from '@/lib/agent/audit'
import { countMirroredForIncident } from '@/lib/agent/audit-mirror'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ urn: string }> },
) {
  const { urn } = await params
  if (!urn) {
    return NextResponse.json({ error: 'Missing incident URN' }, { status: 400 })
  }
  try {
    const [reasoningSteps, lifecycleEvents, mirror] = await Promise.all([
      getReasoningTrace(urn),
      getLifecycleEvents(urn),
      countMirroredForIncident(urn),
    ])
    // Combine + order by ts. The reasoning trace + lifecycle events are
    // disjoint sets (different AuditEventKind values), so the union is the
    // full audit log.
    const all = [...reasoningSteps, ...lifecycleEvents].sort((a, b) =>
      a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0,
    )
    return NextResponse.json({
      incidentUrn: urn,
      mode: mirror.mode,
      mirroredCount: mirror.count,
      events: all,
      lifecycleEvents,
      reasoningSteps,
    })
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
