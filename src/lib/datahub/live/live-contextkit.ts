// =============================================================================
// Sentinel — Live ContextKitClient (LIVE mode — Phase 1 stub)
//
// Phase 1 (PDF §10.3 / v2 plan §"Phase 1 — Real implementation shipped alongside")
//
// This is the REAL ContextKitClient that calls DataHub's Agent Context Kit
// (ACK) mutation tools. ACK exposes a LangChain integration:
//
//   pip install "datahub-agent-context[langchain]"
//   from datahub_agent_context.langchain_tools import build_langchain_tools
//
// In TypeScript we call the same underlying HTTP/JSON-RPC surface. The tool
// names below are the EXACT names ACK exposes (verified v2 plan Part A.2 —
// `include_mutations=True` unlocks the 7 write tools).
//
// Phase 1 ships the structure. Phase 4 (write-back) wires the orchestrator
// to call these when `DATAHUB_MODE=live`. In DEMO mode the mock implements
// them against Prisma seed tables.
// =============================================================================

import type {
  ContextKitClient,
  OwnerInput,
  SaveDocumentInput,
  Urn,
} from '../types'

interface LiveContextKitConfig {
  /** ACK base URL. */
  endpoint: string
  /** Bearer token (DataHub personal access token with mutation scope). */
  token?: string
  timeoutMs?: number
}

export class LiveContextKitClient implements ContextKitClient {
  private readonly endpoint: string
  private readonly token?: string
  private readonly timeoutMs: number

  constructor(cfg: LiveContextKitConfig) {
    this.endpoint = cfg.endpoint.replace(/\/$/, '')
    this.token = cfg.token
    this.timeoutMs = cfg.timeoutMs ?? 15000
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.endpoint}/tools/call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ name: tool, arguments: args }),
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(`ACK ${tool} failed: HTTP ${res.status}`)
      }
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  async save_document(input: SaveDocumentInput): Promise<{ urn: Urn }> {
    return this.call('save_document', input) as Promise<{ urn: Urn }>
  }
  async add_tags(urn: Urn, tags: string[]): Promise<void> {
    await this.call('add_tags', { urn, tags })
  }
  async remove_tags(urn: Urn, tags: string[]): Promise<void> {
    await this.call('remove_tags', { urn, tags })
  }
  async update_description(urn: Urn, description: string): Promise<void> {
    await this.call('update_description', { urn, description })
  }
  async add_glossary_terms(urn: Urn, termUrns: Urn[]): Promise<void> {
    await this.call('add_glossary_terms', { urn, termUrns })
  }
  async remove_glossary_terms(urn: Urn, termUrns: Urn[]): Promise<void> {
    await this.call('remove_glossary_terms', { urn, termUrns })
  }
  async set_domains(urn: Urn, domainUrns: Urn[]): Promise<void> {
    await this.call('set_domains', { urn, domainUrns })
  }
  async add_owners(urn: Urn, owners: OwnerInput[]): Promise<void> {
    await this.call('add_owners', { urn, owners })
  }
}
