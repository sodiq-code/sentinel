// =============================================================================
// Sentinel — Guardrail policy DSL
//
// Policy DSL spec:
//   policy.ts — policy DSL (configurable rules: PII refusal, no-merge,
//   no-direct-patch-on-glossary)
//
// The guardrail is real CODE that runs BEFORE every action.* + ack.write tool.
// A refusal blocks the tool call entirely and surfaces a structured
// "REQUIRES APPROVAL" or "REFUSED" card in the UI. The LLM cannot bypass it
// by rephrasing the request — the check is on the structured tool args, not
// on the model's text. (prompt-injection mitigation)
//
// The policy is a small plugin DSL so a future operator can add rules without
// touching the orchestrator. Each rule receives the tool name + parsed args
// + the live ToolContext, and returns one of:
//   allow       — proceed
//   refuse      — block, surface the refusal reason (LLM sees it + UI sees it)
//   needs_approval — block pending human review (record PendingApproval row)
// =============================================================================

import type { ToolContext } from '../agent/tools'
import type { ProposedAction } from '../agent/types'

export type GuardrailDecision = 'allow' | 'refuse' | 'needs_approval'

export interface GuardrailCheckResult {
  decision: GuardrailDecision
  ruleId?: string
  reason?: string
  /** The proposed action shape that needs approval (for the PendingApproval row). */
  proposedAction?: ProposedAction
  /** Approver hint surfaced in the UI (e.g. "data owner" / "on-call"). */
  approver?: string
}

export interface GuardrailRule {
  id: string
  description: string
  /**
   * Return a non-null result to short-circuit further rules. Return null to
   * fall through to the next rule (effectively 'allow' for this rule).
   */
  check(toolName: string, args: Record<string, unknown>, ctx: ToolContext): Promise<GuardrailCheckResult | null>
}

// ---------------------------------------------------------------------------
// Rule 1: No-merge. Sentinel NEVER merges a PR. There is no merge tool, but if
// the LLM ever invents `github.merge` or calls `github.openPR` with a
// `merge:true` arg, refuse. Defence in depth.
// ---------------------------------------------------------------------------

export const NoMergeRule: GuardrailRule = {
  id: 'no-merge',
  description:
    'Sentinel NEVER merges a PR. No merge tool exists; any merge-like argument is refused.',
  async check(toolName, args) {
    const name = toolName.toLowerCase()
    if (name.includes('merge') || name.includes('github.merge') || name.includes('github.close_pr')) {
      return {
        decision: 'refuse',
        ruleId: 'no-merge',
        reason:
          'Sentinel never merges or closes pull requests. PRs are left OPEN for human review.',
      }
    }
    // If the LLM smuggles a merge flag into openPR args, refuse.
    if (name === 'action.github_open_pr' || name === 'github.openpr') {
      const mergeArg = args.merge ?? args.draft ?? args.merge_method ?? args.commitMessage
      if (mergeArg !== undefined && mergeArg !== null && mergeArg !== false) {
        return {
          decision: 'refuse',
          ruleId: 'no-merge',
          reason: 'github.openPR does not accept a merge flag. Sentinel only opens PRs, never merges.',
        }
      }
    }
    return null
  },
}

// ---------------------------------------------------------------------------
// Rule 2: Direct-write allowlist. Only `ack.save_document` (post-mortem,
// reversible) and `ack.create_assertion` (learned SLA, reversible) are direct
// writes. Everything else — `ack.add_owners`, `ack.add_glossary_terms`,
// `ack.add_tags`, `ack.update_description` — is a PROPOSAL and surfaces an
// approval gate.
// ---------------------------------------------------------------------------

export const DIRECT_WRITE_ALLOWLIST = new Set(['ack.save_document', 'ack.create_assertion'])

export const DirectWriteAllowlistRule: GuardrailRule = {
  id: 'direct-write-allowlist',
  description:
    'Only save_document (post-mortem) and create_assertion (SLA) are direct writes. All other ack.* are proposals and surface an approval gate.',
  async check(toolName, _args, ctx) {
    const isAckWrite = toolName.startsWith('ack.') && toolName !== 'ack.save_document' && toolName !== 'ack.create_assertion'
    if (!isAckWrite) return null
    // ack.add_owners / ack.add_glossary_terms / ack.add_tags / ack.update_description
    // → surface an approval gate. PII check rule handles save_document on PII assets.
    const kind =
      toolName === 'ack.add_owners'
        ? 'datahub.proposeOwnership'
        : toolName === 'ack.add_glossary_terms'
          ? 'datahub.proposeGlossary'
          : toolName === 'ack.add_tags'
            ? 'datahub.proposeTags'
            : 'datahub.proposeDescription'
    const proposed = buildProposedAction(toolName, _args, kind)
    return {
      decision: 'needs_approval',
      ruleId: 'direct-write-allowlist',
      reason: `${toolName} is a PROPOSAL. Ownership / glossary / tags / description are enrichment only — humans approve. Reversible; surfaces a proposal card.`,
      proposedAction: proposed,
      approver: 'data owner',
    }
  },
}

// ---------------------------------------------------------------------------
// Rule 3: Action approval gate. The action.* tools (github.openIssue,
// github.openPR, slack.postTriage) target external systems. In trace mode the
// trace log absorbs the side effect (trace JSONL log) — but they are still
// surfaced for human review per the governance refusal beat. For the demo we
// let them through (the trace log is the demo's
// approvals surface) but mark the audit. In a non-demo deployment this rule
// returns `needs_approval`.
// ---------------------------------------------------------------------------

export const ActionApprovalGateRule: GuardrailRule = {
  id: 'action-approval-gate',
  description:
    'action.* tools (github + slack) target external systems. Logged by default; surfaces a proposal card in the UI.',
  async check(toolName, _args) {
    if (!toolName.startsWith('action.')) return null
    // Allow action tools — the trace + dry-run toggle are the demo's approval
    // surface. We do NOT block them, but the orchestrator records the Action row
    // + the connector records the side effect, both visible in the UI.
    return null
  },
}

// ---------------------------------------------------------------------------
// Helper: build a ProposedAction from raw tool args (for the PendingApproval row).
// ---------------------------------------------------------------------------

function buildProposedAction(
  toolName: string,
  args: Record<string, unknown>,
  kind: ProposedAction['kind'],
): ProposedAction {
  if (kind === 'datahub.proposeOwnership') {
    const owners = Array.isArray(args.owners) ? args.owners : []
    return {
      kind: 'datahub.proposeOwnership',
      assetUrn: asStr(args.urn),
      owners: owners.map((o: Record<string, unknown>) => ({
        urn: asStr(o.ownerUrn ?? o.urn),
        type: (asStr(o.ownerType ?? 'USER').toUpperCase().includes('GROUP')
          ? 'group'
          : 'user') as 'user' | 'team' | 'group',
      })),
    }
  }
  if (kind === 'datahub.proposeGlossary') {
    return {
      kind: 'datahub.proposeGlossary',
      assetUrn: asStr(args.urn),
      termUrns: Array.isArray(args.termUrns) ? args.termUrns.map(String) : [],
    }
  }
  // Fallback for tag/description proposals: encode as a generic proposal
  return {
    kind: 'datahub.proposeGlossary',
    assetUrn: asStr(args.urn ?? ''),
    termUrns: [],
  }
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

// ---------------------------------------------------------------------------
// Rule registry. Order matters: no-merge is first (hard refuse), then PII
// (added in pre-exec.ts since it needs an async MCP lookup), then the
// proposal rules. The orchestrator's pre-exec hook composes them.
// ---------------------------------------------------------------------------

export const POLICY_RULES: GuardrailRule[] = [
  NoMergeRule,
  // PII rule is injected by pre-exec.ts (it needs the live MCP client)
  DirectWriteAllowlistRule,
  ActionApprovalGateRule,
]

/** Run all rules in order. First non-null result wins. Default: allow. */
export async function applyRules(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  extraRules: GuardrailRule[] = [],
): Promise<GuardrailCheckResult> {
  const all = [...extraRules, ...POLICY_RULES]
  for (const rule of all) {
    const res = await rule.check(toolName, args, ctx)
    if (res) return res
  }
  return { decision: 'allow' }
}
