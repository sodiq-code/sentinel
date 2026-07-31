/**
 * Sentinel — Write-back ingester.
 *
 * Red-team hardening: dual write-back path. Threat model: assertions are the
 * only direct write, reversible.
 *
 * Responsibilities:
 *  - Compose DataHub GraphQL proposals (context doc, glossary proposal,
 *    ownership proposal, assertion) and submit
 *  - Dual write-back path:
 *      Primary: Agent Context Kit (include_mutations=True) —
 *               saveDocument, addGlossaryTerms, addOwners, addTags
 *      Fallback: direct REST ingestion —
 *               ingestProposal, patchEntity
 *    Pick whichever succeeds; pin the DataHub version; document the exact
 *    API surface used.
 *  - Ownership/glossary are PROPOSED (not direct patch) — humans approve
 *  - Assertions are the only DIRECT write — and they are reversible
 *
 * Per incident:
 *   12. save_document → post-mortem context doc attached to failing asset
 *   13. propose(glossary-term) + propose(owner) — proposals
 *   14. create_assertion(new-SLA) — assertion URN
 *
 * Interface + the dual-path contract. Implements the dual write-back path
 * against the Agent Context Kit + REST ingestion.
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
 * Implementation outline:
 *  1. Try Agent Context Kit first
 *  2. On failure → fall back to REST ingestion
 *  3. Log to AuditLog; never crash (fault tolerance)
 */
export class WriteBackIngester implements WriteBackRunner {
  async writeContextDoc(
    _assetUrn: string,
    _title: string,
    _content: string,
  ): Promise<WriteBackResult> {
    throw new Error(
      'WriteBackIngester.writeContextDoc is not implemented. ' +
        'The interface ships as the stable contract.',
    );
  }

  async proposeGlossary(_assetUrn: string, _termUrns: string[]): Promise<WriteBackResult> {
    throw new Error('Not implemented');
  }

  async proposeOwnership(
    _assetUrn: string,
    _owners: { urn: string; type: 'user' | 'team' | 'group' }[],
  ): Promise<WriteBackResult> {
    throw new Error('Not implemented');
  }

  async createAssertion(_input: {
    assetUrn: string;
    type: 'freshness' | 'schema' | 'quality' | 'custom';
    slaSeconds?: number;
  }): Promise<WriteBackResult> {
    throw new Error('Not implemented');
  }
}

export { type WriteBackResult };
