// =============================================================================
// Sentinel — Approval gate
//
// Approval gate spec:
//   approval-gate.ts — returns a structured
//   `{ needsApproval: true, reason, proposedAction, approver }` object that
//   surfaces in the UI for human confirmation.
//
// A PendingApproval row is persisted to the DB (the model is part of the
// schema). The orchestrator returns the approval request as the tool_result
// for the LLM (so the agent sees "needs human approval — proceeding to the
// next step") AND surfaces it to the UI via /api/guardrail/pending.
//
// The human can approve or deny via POST /api/guardrail/approve|deny. In the
// demo we don't re-execute the action automatically on approval (the
// operator re-triggers the run if they want); we just mark the decision so
// the audit log records who approved what.
// =============================================================================

import { db } from '@/lib/db'
import type { ProposedAction } from '../agent/types'

export interface ApprovalRequest {
  id: string
  incidentUrn: string | null
  kind: ProposedAction['kind']
  reason: string
  proposedAction: ProposedAction
  approver: string
  status: 'pending' | 'approved' | 'denied'
  approverUrn: string | null
  decidedAt: string | null
  createdAt: string
}

export interface ApprovalDecision {
  id: string
  status: 'approved' | 'denied'
  approverUrn: string
  decidedAt: string
}

// ---------------------------------------------------------------------------
// requestApproval — persist a PendingApproval row + return the surface shape.
// ---------------------------------------------------------------------------

export async function requestApproval(input: {
  incidentUrn: string
  kind: ProposedAction['kind']
  reason: string
  proposedAction: ProposedAction
  approver: string
}): Promise<ApprovalRequest> {
  const row = await db.pendingApproval.create({
    data: {
      incidentUrn: input.incidentUrn,
      kind: input.kind,
      reason: input.reason,
      proposedActionJson: JSON.stringify(input.proposedAction),
      approverUrn: null,
      status: 'pending',
    },
  })
  return {
    id: row.id,
    incidentUrn: row.incidentUrn,
    kind: row.kind as ProposedAction['kind'],
    reason: row.reason,
    proposedAction: input.proposedAction,
    approver: input.approver,
    status: 'pending',
    approverUrn: null,
    decidedAt: null,
    createdAt: row.createdAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// approve / deny — flip a pending approval row + record who decided.
// ---------------------------------------------------------------------------

export async function approveApproval(input: {
  id: string
  approverUrn: string
}): Promise<ApprovalDecision> {
  const row = await db.pendingApproval.update({
    where: { id: input.id },
    data: {
      status: 'approved',
      approverUrn: input.approverUrn,
      decidedAt: new Date(),
    },
  })
  return {
    id: row.id,
    status: 'approved',
    approverUrn: row.approverUrn ?? input.approverUrn,
    decidedAt: row.decidedAt?.toISOString() ?? new Date().toISOString(),
  }
}

export async function denyApproval(input: {
  id: string
  approverUrn: string
}): Promise<ApprovalDecision> {
  const row = await db.pendingApproval.update({
    where: { id: input.id },
    data: {
      status: 'denied',
      approverUrn: input.approverUrn,
      decidedAt: new Date(),
    },
  })
  return {
    id: row.id,
    status: 'denied',
    approverUrn: row.approverUrn ?? input.approverUrn,
    decidedAt: row.decidedAt?.toISOString() ?? new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// list — surfaced by /api/guardrail/pending for the <GuardrailPanel>.
// ---------------------------------------------------------------------------

export async function listApprovals(opts: {
  incidentUrn?: string
  status?: 'pending' | 'approved' | 'denied'
  limit?: number
}): Promise<ApprovalRequest[]> {
  const where: {
    incidentUrn?: string
    status?: string
  } = {}
  if (opts.incidentUrn) where.incidentUrn = opts.incidentUrn
  if (opts.status) where.status = opts.status
  const rows = await db.pendingApproval.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 50,
  })
  return rows.map((r) => ({
    id: r.id,
    incidentUrn: r.incidentUrn,
    kind: r.kind as ProposedAction['kind'],
    reason: r.reason,
    proposedAction: safeParse(r.proposedActionJson),
    approver: r.approverUrn ?? '(unspecified)',
    status: r.status as 'pending' | 'approved' | 'denied',
    approverUrn: r.approverUrn,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }))
}

function safeParse(s: string): ProposedAction {
  try {
    return JSON.parse(s) as ProposedAction
  } catch {
    return { kind: 'datahub.proposeGlossary', assetUrn: '', termUrns: [] }
  }
}
