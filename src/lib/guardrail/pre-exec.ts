// =============================================================================
// Sentinel — Pre-execute hook
//
// This is the heart of the guardrail. The orchestrator calls
// `checkBeforeExecute(toolName, args, ctx)` BEFORE every tool_call. The hook:
//   1. For action.* tools → no-merge check, allow (the trace + dry-run
//      toggle are the demo's approval surface).
//   2. For ack.save_document → async PII check on the assetUrn (reads
//      governance tags via MCP `get_entities`). If PII: refuse + persist
//      a PendingApproval row. The LLM sees the refusal as the tool_result.
//   3. For ack.add_owners / ack.add_glossary_terms / ack.add_tags /
//      ack.update_description → needs_approval (proposals only — surface
//      the approval gate, persist a PendingApproval row, return the
//      approval request as the tool_result).
//   4. For ack.create_assertion → direct write, allowed.
//   5. For mcp.* (read tools) → always allow.
//
// The hook returns a `GuardrailVerdict`:
//   allow      → orchestrator proceeds to execute the tool
//   refuse     → orchestrator skips the tool call, returns the refusal as
//                the structured tool_result (LLM sees the reason)
//   needs_approval → orchestrator skips the tool call, returns the
//                approval request as the tool_result, persists the
//                PendingApproval row, surfaces it in the UI.
//
// The orchestrator records every check to the AuditEvent table
// so the demo UI can render the guardrail timeline.
// =============================================================================

import { db } from '@/lib/db'
import { checkPiiForAsset, classifyTags } from './pii-check'
import { applyRules, type GuardrailCheckResult, type GuardrailRule } from './policy'
import { requestApproval } from './approval-gate'
import type { ProposedAction } from '../agent/types'
import type { ToolContext } from '../agent/tools'

export interface GuardrailVerdict {
  decision: 'allow' | 'refuse' | 'needs_approval'
  toolName: string
  reason?: string
  ruleId?: string
  approvalId?: string
  proposedAction?: ProposedAction
  approver?: string
}

// ---------------------------------------------------------------------------
// PII rule (needs the live MCP client — composed at call-time, not at
// module-load). Returned as an extra rule for `applyRules`.
// ---------------------------------------------------------------------------

function piiRuleFor(assetUrn: string): GuardrailRule {
  return {
    id: 'pii-refusal',
    description: 'Refuse write-back to a PII-tagged asset without approval.',
    async check(toolName, _args, ctx) {
      // Only the explicit direct-write tool triggers PII check; proposal
      // tools are handled by DirectWriteAllowlistRule.
      if (toolName !== 'ack.save_document') return null
      const res = await checkPiiForAsset(ctx.clients.mcp, assetUrn)
      if (!res) return null
      if (res.hasPii) {
        const proposed: ProposedAction = {
          kind: 'datahub.proposeGlossary',
          assetUrn,
          termUrns: [],
        }
        return {
          decision: 'refuse',
          ruleId: 'pii-refusal',
          reason: res.reason ?? `Asset carries PII tags: ${res.tags.map((t) => t.name).join(', ')}`,
          proposedAction: proposed,
          approver: 'data owner',
        }
      }
      return null
    },
  }
}

// ---------------------------------------------------------------------------
// checkBeforeExecute — the orchestrator's pre-execute hook.
// ---------------------------------------------------------------------------

export async function checkBeforeExecute(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<GuardrailVerdict> {
  // Read tools — always allow.
  if (toolName.startsWith('mcp.')) {
    return { decision: 'allow', toolName }
  }

  // PII rule (needs the assetUrn from args — only relevant for save_document).
  const assetUrn = typeof args.assetUrn === 'string' ? args.assetUrn : ''
  const extraRules: GuardrailRule[] = []
  if (toolName === 'ack.save_document' && assetUrn) {
    extraRules.push(piiRuleFor(assetUrn))
  }

  const result: GuardrailCheckResult = await applyRules(toolName, args, ctx, extraRules)
  if (result.decision === 'allow') {
    return { decision: 'allow', toolName }
  }

  // Persist + return the verdict
  if (result.decision === 'refuse') {
    // For PII refusals, also persist a PendingApproval row so the operator
    // can see + reverse the refusal if they choose.
    if (result.proposedAction && ctx.incidentUrn) {
      const approval = await requestApproval({
        incidentUrn: ctx.incidentUrn,
        kind: result.proposedAction.kind,
        reason: result.reason ?? 'Guardrail refusal',
        proposedAction: result.proposedAction,
        approver: result.approver ?? 'data owner',
      })
      return {
        decision: 'refuse',
        toolName,
        reason: result.reason,
        ruleId: result.ruleId,
        approvalId: approval.id,
        proposedAction: result.proposedAction,
        approver: result.approver,
      }
    }
    return {
      decision: 'refuse',
      toolName,
      reason: result.reason,
      ruleId: result.ruleId,
    }
  }

  // needs_approval
  if (result.proposedAction && ctx.incidentUrn) {
    const approval = await requestApproval({
      incidentUrn: ctx.incidentUrn,
      kind: result.proposedAction.kind,
      reason: result.reason ?? 'Requires human approval',
      proposedAction: result.proposedAction,
      approver: result.approver ?? 'data owner',
    })
    return {
      decision: 'needs_approval',
      toolName,
      reason: result.reason,
      ruleId: result.ruleId,
      approvalId: approval.id,
      proposedAction: result.proposedAction,
      approver: result.approver,
    }
  }

  // No proposedAction (shouldn't happen for non-allow) — fall back to refuse.
  return {
    decision: 'refuse',
    toolName,
    reason: result.reason ?? 'Guardrail blocked this action',
    ruleId: result.ruleId,
  }
}

// ---------------------------------------------------------------------------
// recordGuardrailCheck — write an AuditEvent so the UI timeline shows it.
// ---------------------------------------------------------------------------

export async function recordGuardrailCheck(
  incidentUrn: string,
  verdict: GuardrailVerdict,
  toolCallId?: string,
): Promise<void> {
  const summary =
    verdict.decision === 'allow'
      ? `Guardrail: ${verdict.toolName} allowed`
      : verdict.decision === 'refuse'
        ? `Guardrail REFUSED ${verdict.toolName}${verdict.ruleId ? ` (rule: ${verdict.ruleId})` : ''}: ${verdict.reason ?? ''}`
        : `Guardrail: ${verdict.toolName} needs human approval (${verdict.approver ?? 'operator'}): ${verdict.reason ?? ''}`
  await db.auditEvent.create({
    data: {
      incidentUrn,
      kind: 'tool_result',
      summary,
      payloadJson: JSON.stringify({
        guardrail: true,
        decision: verdict.decision,
        toolName: verdict.toolName,
        toolCallId,
        ruleId: verdict.ruleId,
        reason: verdict.reason,
        approvalId: verdict.approvalId,
        proposedAction: verdict.proposedAction,
        approver: verdict.approver,
        ts: new Date().toISOString(),
      }),
    },
  })
}

// Re-export the classify helper for the UI / API.
export { classifyTags }
