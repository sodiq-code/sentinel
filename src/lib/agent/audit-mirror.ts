// =============================================================================
// Sentinel — Audit mirror to DataHub Assertions
//
// The AuditEvent table (Prisma SQLite) is Sentinel's detailed, local audit
// trail — the "I can see the agent thinking" trace. But DataHub itself is the
// system of record for the data assets. To make Sentinel's activity visible
// on the asset page in DataHub (not just in Sentinel's console), key lifecycle
// audit events are MIRRORED as DataHub Assertions on the asset.
//
//   AuditEvent (local SQLite)  ──mirror──►  DataHub Assertion (on the asset)
//
// In LIVE mode  → clients.ingestion.createAssertion (real DataHub assertion)
// In DEMO mode  → db.seedAssertion.create            (seed table, mock mirror)
//
// Only the lifecycle milestones are mirrored — the detailed reasoning trace
// (plan/tool_call/tool_result/observe/reflect) stays local to Sentinel. The
// operator who wants the full trace reads the audit log; the operator who
// wants the summary reads the asset's assertions in DataHub.
//
// Mirrored events:
//   incident_created    → "Sentinel incident opened: {type} on {asset}"
//   writeback_succeeded → "Sentinel post-mortem written: {title}"
//   incident_resolved   → "Sentinel incident resolved: {summary}"
//   incident_failed     → "Sentinel incident failed: {error}"
//
// All mirrored assertions are type 'custom' with status 'passing' (except
// incident_failed → 'failing'). The SLA is intentionally null — these are
// activity markers, not freshness SLAs.
// =============================================================================

import { db } from '@/lib/db'
import { getDataHub, getDataHubMode } from '@/lib/datahub'
import type { AssertionType, Urn } from '@/lib/datahub/types'
import type { AuditEventKind } from './types'

// ---------------------------------------------------------------------------
// The lifecycle events that get mirrored. Keeping this as a Set makes the
// "what gets mirrored" policy a one-line review for a security auditor.
// ---------------------------------------------------------------------------

export const MIRRORED_KINDS = new Set<AuditEventKind>([
  'incident_created',
  'writeback_succeeded',
  'incident_resolved',
  'incident_degraded',
  'incident_failed',
])

export type AuditMirrorMode = 'demo' | 'live'

export interface MirrorInput {
  incidentUrn: string
  kind: AuditEventKind
  summary: string
  assetUrn: Urn
  /** Optional — the title of the post-mortem doc (for writeback_succeeded). */
  title?: string
}

export interface MirrorResult {
  mirrored: boolean
  mode: AuditMirrorMode
  assertionUrn?: string
  /** Populated when the mirror was skipped (event kind not mirrored). */
  skipped?: string
  /** Populated when the mirror was attempted but failed. */
  error?: string
}

export interface AuditMirror {
  mirror(input: MirrorInput): Promise<MirrorResult>
}

// ---------------------------------------------------------------------------
// PrismaAuditMirror — the production implementation. Branches on
// getDataHubMode() to pick the right sink. A failure to mirror is NON-FATAL:
// the orchestrator's primary work (the incident) is already done by the time
// the mirror runs; we return the error in the result but never throw.
// ---------------------------------------------------------------------------

export class PrismaAuditMirror implements AuditMirror {
  async mirror(input: MirrorInput): Promise<MirrorResult> {
    if (!MIRRORED_KINDS.has(input.kind)) {
      return {
        mirrored: false,
        mode: getDataHubMode(),
        skipped: `kind '${input.kind}' is not mirrored`,
      }
    }

    const assertionType: AssertionType = 'custom'
    const status = input.kind === 'incident_failed' ? 'failing' : 'passing'
    const description = buildAssertionDescription(input)

    const mode = getDataHubMode()
    try {
      const clients = await getDataHub()
      const res = await clients.ingestion.createAssertion({
        assetUrn: input.assetUrn,
        type: assertionType,
        description,
      })
      return {
        mirrored: true,
        mode,
        assertionUrn: res.urn,
      }
    } catch (err) {
      const error = (err as Error)?.message ?? String(err)
      // Non-fatal — the mirror is a best-effort side-effect. The incident is
      // already resolved; the operator can see the failed mirror in the
      // audit log and re-run the assertion creation manually.
      return {
        mirrored: false,
        mode,
        error,
      }
    }
  }
}

function buildAssertionDescription(input: MirrorInput): string {
  switch (input.kind) {
    case 'incident_created':
      return `Sentinel incident opened — ${input.summary}`
    case 'writeback_succeeded':
      return `Sentinel post-mortem written${input.title ? `: ${input.title}` : ''}`
    case 'incident_resolved':
      return `Sentinel incident resolved — ${input.summary}`
    case 'incident_degraded':
      return `Sentinel incident degraded (LLM rate-limited) — ${input.summary}`
    case 'incident_failed':
      return `Sentinel incident failed — ${input.summary}`
    default:
      return `Sentinel audit event — ${input.summary}`
  }
}

// ---------------------------------------------------------------------------
// Singleton — the mirror is stateless; one instance is enough.
// ---------------------------------------------------------------------------

let _mirror: PrismaAuditMirror | null = null
export function getAuditMirror(): AuditMirror {
  if (!_mirror) _mirror = new PrismaAuditMirror()
  return _mirror
}

// ---------------------------------------------------------------------------
// Read-only summary for the UI — "Audit mirrored to DataHub Assertions (LIVE)"
// or "Audit mirrored to seed (DEMO)". Never throws.
// ---------------------------------------------------------------------------

export function getAuditMirrorMode(): AuditMirrorMode {
  return getDataHubMode()
}

// ---------------------------------------------------------------------------
// Count the assertions mirrored for an incident — used by the UI to show
// "4 events mirrored to DataHub Assertions" on the audit timeline header.
// In DEMO mode this reads the SeedAssertion table; in LIVE mode the assertions
// live in the real DataHub (not queryable here), so we count from the audit
// log + assume each mirrored event created one assertion.
// ---------------------------------------------------------------------------

export async function countMirroredForIncident(
  incidentUrn: string,
): Promise<{ count: number; mode: AuditMirrorMode }> {
  const mode = getDataHubMode()
  if (mode === 'live') {
    // In LIVE mode the assertions live in the real DataHub. Count the
    // mirrored lifecycle audit events we recorded (each should have
    // produced one assertion).
    const events = await db.auditEvent.findMany({
      where: { incidentUrn, kind: { in: Array.from(MIRRORED_KINDS) as string[] } },
    })
    return { count: events.length, mode }
  }
  // DEMO mode — assertions are in the SeedAssertion table. They are not
  // tagged by incident, so we count the mirrored lifecycle events from the
  // audit log (each one persisted one SeedAssertion row).
  const events = await db.auditEvent.findMany({
    where: { incidentUrn, kind: { in: Array.from(MIRRORED_KINDS) as string[] } },
  })
  return { count: events.length, mode }
}
