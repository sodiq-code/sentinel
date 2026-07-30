// =============================================================================
// Sentinel — Audit log (Prisma-backed, PDF §9.4.3)
//
// Every reasoning step + lifecycle event is recorded to the AuditEvent table.
// The reasoning trace is reconstructed from AuditEvents ordered by ts, so the
// Phase 2 console can render the full "I can see the agent thinking" view
// (PDF §5.3) without a separate trace table.
// =============================================================================

import { db } from '@/lib/db'
import type {
  AuditEvent,
  AuditEventKind,
  ReasoningStep,
} from './types'

export interface AuditLogger {
  record(input: {
    incidentUrn: string
    kind: AuditEventKind
    summary: string
    payload?: Record<string, unknown>
  }): Promise<void>
}

export class PrismaAuditLogger implements AuditLogger {
  async record(input: {
    incidentUrn: string
    kind: AuditEventKind
    summary: string
    payload?: Record<string, unknown>
  }): Promise<void> {
    await db.auditEvent.create({
      data: {
        incidentUrn: input.incidentUrn,
        kind: input.kind,
        summary: input.summary,
        payloadJson: input.payload ? JSON.stringify(input.payload) : null,
        ts: new Date(),
      },
    })
  }
}

let _logger: PrismaAuditLogger | null = null
export function getAudit(): AuditLogger {
  if (!_logger) _logger = new PrismaAuditLogger()
  return _logger
}

// ---------------------------------------------------------------------------
// Reasoning-trace reconstruction — read AuditEvents for an incident and map
// them to the ReasoningStep[] the console renders.
// ---------------------------------------------------------------------------

const STEP_KINDS = new Set<AuditEventKind>([
  'plan',
  'tool_call',
  'tool_result',
  'observe',
  'reflect',
  'write_back',
  'error',
])

export async function getReasoningTrace(incidentUrn: string): Promise<ReasoningStep[]> {
  const events = await db.auditEvent.findMany({
    where: { incidentUrn },
    orderBy: { ts: 'asc' },
  })
  const steps: ReasoningStep[] = []
  let stepNum = 0
  for (const e of events) {
    const kind = e.kind as AuditEventKind
    if (!STEP_KINDS.has(kind)) continue
    const payload = e.payloadJson
      ? (JSON.parse(e.payloadJson) as Record<string, unknown>)
      : undefined
    steps.push({
      step: stepNum++,
      kind: kind as ReasoningStep['kind'],
      toolName: payload?.toolName as string | undefined,
      toolArgs: payload?.toolArgs as Record<string, unknown> | undefined,
      toolResult: payload?.toolResult,
      reasoning: payload?.reasoning as string | undefined,
      error: payload?.error as string | undefined,
      usage: payload?.usage as { promptTokens: number; completionTokens: number } | undefined,
      ts: e.ts.toISOString(),
    })
  }
  return steps
}

export async function getLifecycleEvents(incidentUrn: string): Promise<AuditEvent[]> {
  const events = await db.auditEvent.findMany({
    where: { incidentUrn },
    orderBy: { ts: 'asc' },
  })
  return events
    .filter((e) => !STEP_KINDS.has(e.kind as AuditEventKind))
    .map((e) => ({
      id: e.id,
      incidentUrn: e.incidentUrn,
      kind: e.kind as AuditEventKind,
      ts: e.ts.toISOString(),
      summary: e.summary,
      payload: e.payloadJson ? (JSON.parse(e.payloadJson) as Record<string, unknown>) : undefined,
    }))
}

export async function getAllAuditEvents(incidentUrn: string): Promise<AuditEvent[]> {
  const events = await db.auditEvent.findMany({
    where: { incidentUrn },
    orderBy: { ts: 'asc' },
  })
  return events.map((e) => ({
    id: e.id,
    incidentUrn: e.incidentUrn,
    kind: e.kind as AuditEventKind,
    ts: e.ts.toISOString(),
    summary: e.summary,
    payload: e.payloadJson ? (JSON.parse(e.payloadJson) as Record<string, unknown>) : undefined,
  }))
}
