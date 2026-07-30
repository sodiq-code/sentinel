// =============================================================================
// Sentinel — PII check (Phase 3)
//
// PDF §10.3 Phase 3 spec:
//   pii-check.ts — reads DataHub governance tags via MCP `get_entities`,
//   refuses if a PII tag is present without prior approval.
//
// The Phase 2 PII scenario (`customer_pii` table tagged PII + Restricted)
// should now hit a CODE-level refusal when the agent attempts to write back
// to it via `ack.save_document`. The LLM cannot bypass it by rephrasing the
// request — the check fetches the entity's governance tags directly via the
// MCP `get_entities` tool and inspects them. (PDF §12.3 — prompt-injection
// mitigation: the LLM cannot "say" the asset isn't PII and have it be true.)
// =============================================================================

import type { GovernanceTag } from '../datahub/types'

export interface PiiCheckResult {
  hasPii: boolean
  tags: GovernanceTag[]
  reason?: string
}

/**
 * Inspect an entity's governance tags for PII. A tag counts as PII if:
 *   - its name contains "pii" (case-insensitive), OR
 *   - its level is `CLASSIFICATION` AND its name is `pii`, OR
 *   - its name contains "restricted" / "confidential" / "sensitive"
 *     (these count as PII-adjacent — surface an approval gate, not a hard
 *     refusal, because some workflows legitimately write to restricted assets
 *     after review).
 */
export function classifyTags(tags: GovernanceTag[]): PiiCheckResult {
  const piiTags = tags.filter((t) => t.name.toLowerCase().includes('pii'))
  const restrictedTags = tags.filter(
    (t) =>
      t.name.toLowerCase().includes('restricted') ||
      t.name.toLowerCase().includes('confidential') ||
      t.name.toLowerCase().includes('sensitive'),
  )
  if (piiTags.length > 0) {
    return {
      hasPii: true,
      tags: piiTags,
      reason: `Asset carries PII governance tag(s): ${piiTags.map((t) => `'${t.name}'`).join(', ')}. Sentinel refuses write-back without explicit human approval.`,
    }
  }
  if (restrictedTags.length > 0) {
    return {
      hasPii: true,
      tags: restrictedTags,
      reason: `Asset carries restricted/confidential tag(s): ${restrictedTags.map((t) => `'${t.name}'`).join(', ')}. Write-back requires human approval.`,
    }
  }
  return { hasPii: false, tags: [] }
}

/**
 * Live PII check: fetch the entity via the MCP client + inspect its tags.
 * Caller (pre-exec hook) supplies the entity's URN; this does the rest.
 *
 * Returns null if the entity fetch failed (defensive: we do NOT block on a
 * fetch failure — that would let a network blip disable the agent. The PII
 * rule still fires on the tags we DO see).
 */
export async function checkPiiForAsset(
  mcp: { get_entities(urns: string[]): Promise<{ governanceTags: GovernanceTag[] }[]> },
  assetUrn: string,
): Promise<PiiCheckResult | null> {
  try {
    const entities = await mcp.get_entities([assetUrn])
    const entity = entities[0]
    if (!entity) return null
    return classifyTags(entity.governanceTags || [])
  } catch {
    return null
  }
}
