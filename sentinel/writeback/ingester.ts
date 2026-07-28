/**
 * Sentinel — Write-back ingester.
 *
 * PDF §9.4.1 + §9.4.2 (steps 12–14) + §12.2 (red-team hardening: dual
 * write-back path) + §9.5.5 (threat model: assertions are the only direct
 * write, reversible).
 *
 * Responsibilities:
 *  - Compose DataHub GraphQL proposals (context doc, glossary proposal,
 *    ownership proposal, assertion) and submit
 *  - Dual write-back path (PDF §12.2):
 *      Primary: Agent Context Kit (include_mutations=True) —
 *               saveDocument, addGlossaryTerms, addOwners, addTags
 *      Fallback: direct REST ingestion —
 *               ingestProposal, patchEntity
 *    Pick whichever succeeds; pin the DataHub version; document the exact
 *    API surface used.
 *  - Ownership/glossary are PROPOSED (not direct patch) — humans approve
 *    (PDF §9.5.5)
 *  - Assertions are the only DIRECT write — and they are reversible
 *
 * Per incident (PDF §9.4.2 steps 12–14):
 *   12. save_document → post-mortem context doc attached to failing asset
 *   13. propose(glossary-term) + propose(owner) — proposals
 *   14. create_assertion(new-SLA) — assertion URN
 *
 * Phase 0: interface + the dual-path contract. Phase 4 implements the
 * dual write-back path against the Agent Context Kit + REST ingestion.
 */

import type { WriteBackResult } from '../types';

/** Public interface — see `orchestrator.ts`. */
export interface WriteBackRunner {
  writeContextDoc(assetUrn: string, title: string, content: string): Promise<WriteBackResult>;
  proposeGlossary(assetUrn: string, termUrns: string[]): Promise<WriteBackResult>;
  proposeOwnership(
    assetUrn: string,
    owners: { urn: string; type: 'user' | 'team' | 'group' }[],
  ): Promise<WriteBackResult>;
  createAssertion(input: {
    assetUrn: string;
    type: 'freshness' | 'schema' | 'quality' | 'custom';
    slaSeconds?: number;
  }): Promise<WriteBackResult>;
}

/**
 * Phase 0 placeholder. Phase 4 implementation:
 *  1. Try Agent Context Kit first
 *  2. On failure → fall back to REST ingestion
 *  3. Log to AuditLog; never crash (PDF §9.5.4 fault tolerance)
 */
export class WriteBackIngester implements WriteBackRunner {
  async writeContextDoc(
    _assetUrn: string,
    _title: string,
    _content: string,
  ): Promise<WriteBackResult> {
    throw new Error(
      'WriteBackIngester.writeContextDoc is a Phase 4 deliverable. ' +
        'Phase 0 ships the interface only. See refined v2 plan Part D, Phase 4.',
    );
  }

  async proposeGlossary(_assetUrn: string, _termUrns: string[]): Promise<WriteBackResult> {
    throw new Error('Phase 4 deliverable');
  }

  async proposeOwnership(
    _assetUrn: string,
    _owners: { urn: string; type: 'user' | 'team' | 'group' }[],
  ): Promise<WriteBackResult> {
    throw new Error('Phase 4 deliverable');
  }

  async createAssertion(_input: {
    assetUrn: string;
    type: 'freshness' | 'schema' | 'quality' | 'custom';
    slaSeconds?: number;
  }): Promise<WriteBackResult> {
    throw new Error('Phase 4 deliverable');
  }
}

export { type WriteBackResult };
