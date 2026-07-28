/**
 * Sentinel — Guardrail layer.
 *
 * PDF §9.3.5 + §9.5.5 + §12.3.
 *
 * Responsibilities (PDF §9.4.1):
 *  - Governance checks (read DataHub governance tags via MCP `getEntities`)
 *  - PII refusal — refuse to act on PII-tagged assets without prior approval
 *  - No-merge policy — Sentinel opens PRs but never merges
 *  - Human-approval gate — return a structured 'needs approval' object that
 *    surfaces in the UI for human confirmation
 *  - Structured tool-call inputs (mitigates prompt injection via DataHub
 *    metadata — PDF §12.3)
 *
 * Phase 0: interface + the policy DSL contract. Phase 3 fills in the
 * implementation.
 */

import type { GuardrailDecision, PendingApproval, ProposedAction } from './types';

/** Public interface for the Guardrail. See `orchestrator.ts` for the contract. */
export interface Guardrail {
  check(input: {
    kind: ProposedAction['kind'];
    assetUrn?: string;
    payload: unknown;
  }): Promise<GuardrailDecision>;
  /** List pending approvals (for the UI's approval-gate cards). Phase 3. */
  listPendingApprovals(): Promise<PendingApproval[]>;
  /** Resolve a pending approval. Phase 3. */
  resolveApproval(id: string, decision: 'approve' | 'deny'): Promise<PendingApproval>;
}

/** The configurable policy DSL. PDF §9.4.1 — 'policy DSL'. */
export interface GuardrailPolicy {
  /** Refuse PII-tagged assets without prior approval. Default: true. */
  refusePiiWithoutApproval: boolean;
  /** Never auto-merge PRs. Default: true (PDF §9.3.5 no-merge policy). */
  neverAutoMerge: boolean;
  /** Never directly patch glossary or ownership — propose, don't patch.
   *  PDF §9.5.5: 'Ownership/glossary are proposed, not patched'. Default: true. */
  proposeNotPatchGlossaryAndOwnership: boolean;
  /** Treat DataHub metadata as data, never as instructions (PDF §12.3). */
  treatMetadataAsData: boolean;
}

export const DEFAULT_GUARDRAIL_POLICY: GuardrailPolicy = {
  refusePiiWithoutApproval: true,
  neverAutoMerge: true,
  proposeNotPatchGlossaryAndOwnership: true,
  treatMetadataAsData: true,
};

/**
 * Phase 0 placeholder. Phase 3 implementation:
 *  1. Resolve the asset's governance tags via MCP `getEntities`
 *  2. Apply the policy DSL
 *  3. Return a GuardrailDecision with `needsApproval=true` if any rule trips
 *  4. Record every check in the AuditLog
 */
export class SentinelGuardrail implements Guardrail {
  constructor(
    private readonly policy: GuardrailPolicy = DEFAULT_GUARDRAIL_POLICY,
  ) {}

  async check(_input: {
    kind: ProposedAction['kind'];
    assetUrn?: string;
    payload: unknown;
  }): Promise<GuardrailDecision> {
    throw new Error(
      'SentinelGuardrail.check is a Phase 3 deliverable. ' +
        'Phase 0 ships the interface only. See refined v2 plan Part D, Phase 3.',
    );
  }

  async listPendingApprovals(): Promise<PendingApproval[]> {
    throw new Error('Phase 3 deliverable');
  }

  async resolveApproval(_id: string, _decision: 'approve' | 'deny'): Promise<PendingApproval> {
    throw new Error('Phase 3 deliverable');
  }
}

export { type GuardrailDecision, type PendingApproval, type ProposedAction };
