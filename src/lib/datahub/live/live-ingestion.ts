// =============================================================================
// Sentinel — Live IngestionClient (LIVE mode — Phase 1 stub)
//
// Phase 1 (PDF §10.3 / v2 plan §"Phase 1 — Real implementation shipped alongside")
//
// The REST/GraphQL fallback for write-back (PDF §12.2 dual write-back path).
// Used when the Agent Context Kit path is unavailable OR for `createAssertion`
// (the only direct write — reversible, per PDF §9.5.5 threat model).
//
// Phase 1 ships the structure. Phase 4 wires the orchestrator to use it.
// =============================================================================

import type {
  AssertionInput,
  GraphQlProposal,
  IngestionClient,
  Patch,
  Urn,
} from '../types'

interface LiveIngestionConfig {
  /** DataHub GMS REST base URL, e.g. http://localhost:8080 */
  gmsUrl: string
  /** Bearer token. */
  token?: string
  timeoutMs?: number
}

export class LiveIngestionClient implements IngestionClient {
  private readonly gmsUrl: string
  private readonly token?: string
  private readonly timeoutMs: number

  constructor(cfg: LiveIngestionConfig) {
    this.gmsUrl = cfg.gmsUrl.replace(/\/$/, '')
    this.token = cfg.token
    this.timeoutMs = cfg.timeoutMs ?? 15000
  }

  private headers(): HeadersInit {
    return {
      'Content-Type': 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    }
  }

  async ingestProposal(proposal: GraphQlProposal): Promise<{ urn: Urn }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.gmsUrl}/api/graphql`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ query: proposal.mutation, variables: proposal.variables }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`Ingest GraphQL failed: HTTP ${res.status}`)
      const json = (await res.json()) as { data?: { [key: string]: { urn: Urn } } }
      // Return the first urn-shaped value in the response.
      const first = json.data ? Object.values(json.data)[0] : undefined
      return { urn: first?.urn ?? `urn:li:dataHubGraphProposal:sentinel:${Date.now()}` }
    } finally {
      clearTimeout(timer)
    }
  }

  async patchEntity(urn: Urn, patch: Patch): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.gmsUrl}/api/entities/${encodeURIComponent(urn)}`, {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify(patch),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`Patch ${urn} failed: HTTP ${res.status}`)
    } finally {
      clearTimeout(timer)
    }
  }

  async createAssertion(input: AssertionInput): Promise<{ urn: Urn }> {
    // DataHub assertion creation is the only direct, reversible write Sentinel
    // performs (PDF §9.5.5). We POST to /api/entities with the assertion JSON-LD.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const urn = `urn:li:assertion:sentinel:${input.type}:${Date.now()}`
      const entity = {
        entity: {
          urn,
          aspects: [
            {
              entityType: 'assertion',
              platform: 'urn:li:dataPlatform:sentinel',
              type: input.type,
              description: input.description,
            },
            {
              datasetUrn: input.assetUrn,
              ...(input.slaSeconds ? { slaSeconds: input.slaSeconds } : {}),
            },
          ],
        },
      }
      const res = await fetch(`${this.gmsUrl}/api/entities`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(entity),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`createAssertion failed: HTTP ${res.status}`)
      return { urn }
    } finally {
      clearTimeout(timer)
    }
  }
}
