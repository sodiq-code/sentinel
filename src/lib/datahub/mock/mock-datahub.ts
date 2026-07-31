// =============================================================================
// Sentinel — Mock DataHub client (DEMO mode)
//
// DataHub mock + seed.
//
// Implements all three DataHub client interfaces (McpClient, ContextKitClient,
// IngestionClient) against Prisma SQLite seeded with the nyc-taxi, showcase-
// ecommerce, and PII scenarios. The orchestrator calls these exact
// methods, so swapping `DATAHUB_MODE=live` flips the whole agent to a real
// DataHub deployment with zero orchestrator changes.
//
// Why a mock:
//   Risk register — "DataHub not available in demo env" (Certain,
//   Low impact). The demo must run from a fresh clone in under a minute with
//   no external dependencies. We ship the real interface code alongside
//   (./live/) so reviewers see we can flip to live; the demo runs on seeded data.
//
// Seeding happens in `prisma/seed.ts` (deterministic, idempotent). This file
// only reads.
// =============================================================================

import { db } from '@/lib/db'
import type {
  AssertionInput,
  AssertionRecord,
  ContextKitClient,
  DatasetQuery,
  DocGrepResult,
  DocSearchResult,
  Entity,
  GlossaryDiff,
  GlossaryVersion,
  GraphQlProposal,
  IngestionClient,
  Lineage,
  LineageNode,
  LineagePath,
  LineagePathEdge,
  LifecycleStage,
  McpClient,
  OwnerInput,
  Patch,
  SaveDocumentInput,
  SchemaField,
  SearchResult,
  Urn,
  User,
} from '../types'

// ---------------------------------------------------------------------------
// Small JSON helpers — Prisma stores all complex fields as JSON strings.
// ---------------------------------------------------------------------------

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// Internal: convert a Prisma SeedAsset row to the public Entity DTO.
// ---------------------------------------------------------------------------

function seedAssetToEntity(row: {
  urn: string
  name: string
  platform: string
  type: string
  description: string | null
  ownersJson: string
  glossaryTermsJson: string
  governanceTagsJson: string
  schemaFieldsJson: string
  lastModifiedAt: number | null
  platformNativeName: string | null
  scenarioId: string
}): Entity {
  return {
    urn: row.urn,
    name: row.name,
    type: row.type as Entity['type'],
    platform: row.platform,
    description: row.description ?? undefined,
    owners: parseJson(row.ownersJson, []),
    glossaryTerms: parseJson(row.glossaryTermsJson, []),
    governanceTags: parseJson(row.governanceTagsJson, []),
    schemaFields: parseJson(row.schemaFieldsJson, []),
    lastModifiedAt: row.lastModifiedAt != null ? Number(row.lastModifiedAt) * 1000 : undefined,
    platformNativeName: row.platformNativeName ?? undefined,
    scenarioId: row.scenarioId,
  }
}

// ---------------------------------------------------------------------------
// Mock McpClient — the 12 read tools (verified against DataHub MCP docs).
// ---------------------------------------------------------------------------

export class MockMcpClient implements McpClient {
  async search(query: string, opts?): Promise<SearchResult[]> {
    const q = query.trim().toLowerCase()
    const assets = await db.seedAsset.findMany()
    const results: SearchResult[] = []
    for (const a of assets) {
      const hay = `${a.name} ${a.platform} ${a.description ?? ''}`.toLowerCase()
      if (!q || hay.includes(q)) {
        if (opts?.filterType && a.type !== opts.filterType) continue
        if (opts?.filterPlatform && a.platform !== opts.filterPlatform) continue
        results.push({
          urn: a.urn,
          name: a.name,
          type: a.type as SearchResult['type'],
          platform: a.platform,
          description: a.description ?? undefined,
          snippet: a.description?.slice(0, 140) ?? undefined,
        })
      }
    }
    const start = opts?.start ?? 0
    const count = opts?.count ?? 50
    return results.slice(start, start + count)
  }

  async get_entities(urns: Urn[]): Promise<Entity[]> {
    if (urns.length === 0) return []
    const rows = await db.seedAsset.findMany({ where: { urn: { in: urns } } })
    // Preserve caller order.
    const byUrn = new Map(rows.map((r) => [r.urn, r]))
    return urns
      .map((u) => byUrn.get(u))
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .map(seedAssetToEntity)
  }

  async list_schema_fields(urn: Urn, opts?: { keywords?: string }): Promise<SchemaField[]> {
    const row = await db.seedAsset.findUnique({ where: { urn } })
    if (!row) return []
    let fields = parseJson<SchemaField[]>(row.schemaFieldsJson, [])
    if (opts?.keywords) {
      const kw = opts.keywords.toLowerCase()
      fields = fields.filter(
        (f) =>
          f.name.toLowerCase().includes(kw) ||
          (f.description ?? '').toLowerCase().includes(kw),
      )
    }
    return fields
  }

  async get_me(): Promise<User> {
    return {
      urn: 'urn:li:corpUser:sentinel',
      name: 'Sentinel Agent',
      email: 'sentinel@datahub.local',
      title: 'Autonomous Data Incident Response Agent',
    }
  }

  async get_lineage(
    urn: Urn,
    direction: 'upstream' | 'downstream',
    opts?,
  ): Promise<Lineage> {
    const maxHops = opts?.maxHops ?? 3
    // BFS, tracking the edge that first reached each node so we can attach `via`.
    const visited = new Map<Urn, { degree: number; via?: Urn }>()
    const nodes: LineageNode[] = []
    visited.set(urn, { degree: 0 })
    const queue: { urn: Urn; degree: number; via?: Urn }[] = [{ urn, degree: 0 }]
    while (queue.length) {
      const cur = queue.shift()!
      if (cur.degree > 0) {
        const row = await db.seedAsset.findUnique({ where: { urn: cur.urn } })
        nodes.push({
          urn: cur.urn,
          name: row?.name ?? cur.urn,
          type: (row?.type ?? 'dataset') as LineageNode['type'],
          platform: row?.platform,
          via: cur.via,
          degree: cur.degree,
        })
      }
      if (cur.degree >= maxHops) continue
      const edges =
        direction === 'upstream'
          ? await db.seedLineageEdge.findMany({ where: { toUrn: cur.urn } })
          : await db.seedLineageEdge.findMany({ where: { fromUrn: cur.urn } })
      for (const e of edges) {
        const nextUrn = direction === 'upstream' ? e.fromUrn : e.toUrn
        const nextDegree = cur.degree + 1
        const prev = visited.get(nextUrn)
        if (prev && prev.degree <= nextDegree) continue
        visited.set(nextUrn, { degree: nextDegree, via: e.via ?? undefined })
        queue.push({ urn: nextUrn, degree: nextDegree, via: e.via ?? undefined })
      }
    }
    return { urn, direction, nodes }
  }

  async get_lineage_paths_between(fromUrn: Urn, toUrn: Urn): Promise<LineagePath[]> {
    // BFS downstream from `fromUrn` until we reach `toUrn`.
    const paths: Urn[][] = []
    const stack: Urn[][] = [[fromUrn]]
    while (stack.length) {
      const path = stack.shift()!
      const tail = path[path.length - 1]
      if (tail === toUrn) {
        paths.push(path)
        continue
      }
      if (path.length > 8) continue // depth cap
      const edges = await db.seedLineageEdge.findMany({ where: { fromUrn: tail } })
      for (const e of edges) {
        if (path.includes(e.toUrn)) continue // avoid cycles
        stack.push([...path, e.toUrn])
      }
    }
    // Materialise edges for each path.
    const result: LineagePath[] = []
    for (const p of paths) {
      const ep: LineagePathEdge[] = []
      for (let i = 0; i < p.length - 1; i++) {
        const edge = await db.seedLineageEdge.findFirst({
          where: { fromUrn: p[i], toUrn: p[i + 1] },
        })
        ep.push({ fromUrn: p[i], toUrn: p[i + 1], via: edge?.via ?? undefined })
      }
      result.push({ fromUrn, toUrn, path: p, edges: ep })
    }
    return result
  }

  async search_documents(query: string, opts?): Promise<DocSearchResult[]> {
    const q = query.trim().toLowerCase()
    const docs = await db.seedContextDoc.findMany({
      where: opts?.assetUrn ? { assetUrn: opts.assetUrn } : undefined,
    })
    const results: DocSearchResult[] = []
    for (const d of docs) {
      const hay = `${d.title} ${d.content}`.toLowerCase()
      if (!q || hay.includes(q)) {
        const idx = q ? d.content.toLowerCase().indexOf(q) : 0
        const start = Math.max(0, idx - 60)
        const snippet = d.content.slice(start, start + 200).replace(/\s+/g, ' ')
        results.push({
          urn: d.urn,
          title: d.title,
          snippet,
          assetUrn: d.assetUrn,
          authorName: d.authorName,
          createdAt: d.createdAt.toISOString(),
        })
      }
    }
    return results
  }

  async grep_documents(pattern: string, opts?): Promise<DocGrepResult[]> {
    const re = new RegExp(pattern, opts?.caseSensitive ? '' : 'i')
    const docs = await db.seedContextDoc.findMany({
      where: opts?.assetUrn ? { assetUrn: opts.assetUrn } : undefined,
    })
    const out: DocGrepResult[] = []
    for (const d of docs) {
      d.content.split('\n').forEach((line, i) => {
        if (re.test(line)) {
          out.push({
            urn: d.urn,
            title: d.title,
            matchedLine: line,
            lineNumber: i + 1,
            assetUrn: d.assetUrn,
          })
        }
      })
    }
    return out
  }

  async get_dataset_queries(urn: Urn): Promise<DatasetQuery[]> {
    // Return a deterministic stub for the seeded datasets.
    // The orchestrator fills this from its investigation scratchpad.
    const row = await db.seedAsset.findUnique({ where: { urn } })
    if (!row) return []
    if (row.platform === 'dbt') {
      return [
        {
          urn: `urn:li:datasetQuery:${urn}:latest`,
          query: `SELECT date, SUM(fare_amount) AS revenue\nFROM {{ ref('spark_nyc_taxi_clean') }}\nGROUP BY 1`,
          queryType: 'DBT',
          submittedAt: new Date((row.lastModifiedAt ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
          durationMs: 4200,
          rowsReturned: 365,
        },
      ]
    }
    if (row.platform === 'spark') {
      return [
        {
          urn: `urn:li:datasetQuery:${urn}:latest`,
          query: `df = spark.read.parquet('s3://nyc-taxi/raw/')\ndf = df.filter(col('trip_distance') > 0)\ndf.write.mode('overwrite').parquet('s3://nyc-taxi/clean/')`,
          queryType: 'SPARK',
          submittedAt: new Date((row.lastModifiedAt ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
          durationMs: 18000,
          rowsReturned: 482113,
        },
      ]
    }
    return []
  }

  async list_lifecycle_stages(): Promise<LifecycleStage[]> {
    return [
      { urn: 'urn:li:lifecycleStage:raw', name: 'Raw', description: 'Unprocessed land' },
      { urn: 'urn:li:lifecycleStage:processed', name: 'Processed', description: 'Cleaned / transformed' },
      { urn: 'urn:li:lifecycleStage:curated', name: 'Curated', description: 'Business-ready' },
    ]
  }

  async get_glossary_term_versions(urn: Urn): Promise<GlossaryVersion[]> {
    // Single version per term. A post-incident proposal adds a v2.
    const row = await db.seedAsset.findFirst({
      where: { glossaryTermsJson: { contains: urn } },
    })
    const terms = parseJson<{ urn: Urn; name: string; description?: string }[]>(
      row?.glossaryTermsJson ?? null,
      [],
    )
    const t = terms.find((x) => x.urn === urn)
    if (!t) return []
    return [
      {
        version: 'v1',
        name: t.name,
        description: t.description ?? '',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]
  }

  async compare_glossary_term_versions(
    urn: Urn,
    v1: string,
    v2: string,
  ): Promise<GlossaryDiff[]> {
    // Real diffs will be produced after a glossary proposal is applied.
    return []
  }
}

// ---------------------------------------------------------------------------
// Mock ContextKitClient — 7 write tools. In DEMO mode these persist into the
// Prisma seed tables so the UI can show the write-back took effect.
// ---------------------------------------------------------------------------

export class MockContextKitClient implements ContextKitClient {
  async save_document(input: SaveDocumentInput): Promise<{ urn: Urn }> {
    const urn = `urn:li:document:sentinel:${Date.now()}`
    await db.seedContextDoc.create({
      data: {
        urn,
        assetUrn: input.assetUrn,
        title: input.title,
        content: input.content,
        format: input.format ?? 'markdown',
        createdAt: new Date(),
        authorUrn: input.authorUrn ?? 'urn:li:corpUser:sentinel',
        authorName: 'Sentinel Agent',
        sentinelPostMortem: input.sentinelPostMortem ?? true,
        scenarioId: 'nyc-taxi-freshness',
      },
    })
    return { urn }
  }

  async add_tags(urn: Urn, tags: string[]): Promise<void> {
    const row = await db.seedAsset.findUnique({ where: { urn } })
    if (!row) return
    const existing = parseJson<{ name: string; level: 'CLASSIFICATION' }[]>(
      row.governanceTagsJson,
      [],
    )
    const merged = [
      ...existing,
      ...tags
        .filter((t) => !existing.some((e) => e.name === t))
        .map((t) => ({ name: t, level: 'CLASSIFICATION' as const })),
    ]
    await db.seedAsset.update({
      where: { urn },
      data: { governanceTagsJson: JSON.stringify(merged) },
    })
  }

  async remove_tags(urn: Urn, tags: string[]): Promise<void> {
    const row = await db.seedAsset.findUnique({ where: { urn } })
    if (!row) return
    const existing = parseJson<{ name: string }[]>(row.governanceTagsJson, [])
    const next = existing.filter((t) => !tags.includes(t.name))
    await db.seedAsset.update({
      where: { urn },
      data: { governanceTagsJson: JSON.stringify(next) },
    })
  }

  async update_description(urn: Urn, description: string): Promise<void> {
    await db.seedAsset.update({ where: { urn }, data: { description } })
  }

  async add_glossary_terms(urn: Urn, termUrns: Urn[]): Promise<void> {
    const row = await db.seedAsset.findUnique({ where: { urn } })
    if (!row) return
    const existing = parseJson<{ urn: Urn; name: string }[]>(row.glossaryTermsJson, [])
    const additions = termUrns
      .filter((u) => !existing.some((e) => e.urn === u))
      .map((u) => ({ urn: u, name: u.split(':').pop() ?? u }))
    await db.seedAsset.update({
      where: { urn },
      data: { glossaryTermsJson: JSON.stringify([...existing, ...additions]) },
    })
  }

  async remove_glossary_terms(urn: Urn, termUrns: Urn[]): Promise<void> {
    const row = await db.seedAsset.findUnique({ where: { urn } })
    if (!row) return
    const existing = parseJson<{ urn: Urn }[]>(row.glossaryTermsJson, [])
    const next = existing.filter((t) => !termUrns.includes(t.urn))
    await db.seedAsset.update({
      where: { urn },
      data: { glossaryTermsJson: JSON.stringify(next) },
    })
  }

  async set_domains(urn: Urn, domainUrns: Urn[]): Promise<void> {
    // Persisting domains is a no-op that completes in the mock.
    void urn
    void domainUrns
  }

  async add_owners(urn: Urn, owners: OwnerInput[]): Promise<void> {
    const row = await db.seedAsset.findUnique({ where: { urn } })
    if (!row) return
    const existing = parseJson<OwnerInput[]>(row.ownersJson, [])
    const merged = [
      ...existing,
      ...owners.filter((o) => !existing.some((e) => e.ownerUrn === o.ownerUrn)),
    ]
    await db.seedAsset.update({
      where: { urn },
      data: { ownersJson: JSON.stringify(merged) },
    })
  }
}

// ---------------------------------------------------------------------------
// Mock IngestionClient — REST fallback (dual write-back path).
// In DEMO mode: ingestProposal / patchEntity are no-ops that return a stable
// URN; createAssertion persists into SeedAssertion so the UI can render it.
// ---------------------------------------------------------------------------

export class MockIngestionClient implements IngestionClient {
  async ingestProposal(proposal: GraphQlProposal): Promise<{ urn: Urn }> {
    // DEMO: no live DataHub GMS to send the GraphQL proposal to. For the
    // dual write-back path, when the mutation is a Sentinel
    // post-mortem doc creation, we persist the doc into SeedContextDoc so
    // the fallback path produces a findable artefact (mcp.search_documents
    // can find it on the next incident — compounding). For any
    // other mutation, return a stable synthetic URN.
    const isPostMortem = /PostMortem|ContextDoc/i.test(proposal.mutation)
    if (isPostMortem) {
      const vars = (proposal.variables?.input ?? {}) as {
        entityUrn?: Urn
        title?: string
        content?: string
        format?: string
        authorUrn?: Urn
        sentinelPostMortem?: boolean
      }
      if (vars.entityUrn && vars.title && vars.content) {
        const urn = `urn:li:document:sentinel:rest:${Date.now()}`
        await db.seedContextDoc.create({
          data: {
            urn,
            assetUrn: vars.entityUrn,
            title: vars.title,
            content: vars.content,
            format: vars.format ?? 'markdown',
            createdAt: new Date(),
            authorUrn: vars.authorUrn ?? 'urn:li:corpUser:sentinel',
            authorName: 'Sentinel Agent (REST fallback)',
            sentinelPostMortem: vars.sentinelPostMortem ?? true,
            scenarioId: 'nyc-taxi-freshness',
          },
        })
        return { urn }
      }
    }
    return { urn: `urn:li:dataHubGraphProposal:sentinel:${Date.now()}` }
  }

  async patchEntity(urn: Urn, patch: Patch): Promise<void> {
    // DEMO: patches are recorded in the audit log; the mock does not apply
    // arbitrary JSON patches to seeded assets. This may be refined later.
    void urn
    void patch
  }

  async createAssertion(input: AssertionInput): Promise<{ urn: Urn }> {
    const urn = `urn:li:assertion:sentinel:${input.type}:${Date.now()}`
    await db.seedAssertion.create({
      data: {
        urn,
        assetUrn: input.assetUrn,
        type: input.type,
        status: 'passing', // newly learned SLA starts passing
        description: input.description,
        slaSeconds: input.slaSeconds ?? null,
        lastEvaluatedAt: new Date(),
        lastSuccessAt: new Date(),
        failureReason: null,
        scenarioId: 'nyc-taxi-freshness',
      },
    })
    return { urn }
  }
}

// ---------------------------------------------------------------------------
// Snapshot helper — used by the /api/datahub/seed/overview route to render
// the whole seeded graph in the status UI.
// ---------------------------------------------------------------------------

export interface SeedOverview {
  mode: 'demo'
  scenarios: Array<{
    id: string
    name: string
    description: string
    assets: Entity[]
    lineageEdges: LineagePathEdge[]
    assertions: AssertionRecord[]
    contextDocs: Array<{
      urn: Urn
      title: string
      assetUrn: Urn
      sentinelPostMortem: boolean
      createdAt: string
    }>
  }>
}

export async function getSeedOverview(): Promise<SeedOverview> {
  const [assets, edges, assertions, docs] = await Promise.all([
    db.seedAsset.findMany(),
    db.seedLineageEdge.findMany(),
    db.seedAssertion.findMany(),
    db.seedContextDoc.findMany(),
  ])
  const scenarioIds = Array.from(new Set(assets.map((a) => a.scenarioId)))
  const scenarioMeta: Record<string, { name: string; description: string }> = {
    'nyc-taxi-freshness': {
      name: 'NYC Taxi — Freshness breach',
      description: '3-stage pipeline (S3 → Spark → dbt). Planted freshness assertion fails on the raw S3 landing.',
    },
    'showcase-ecommerce': {
      name: 'Showcase eCommerce — Schema breakage',
      description: 'Cross-platform lineage (Snowflake → Looker → dbt → Spark → S3). Used for the schema-breakage scenario.',
    },
    pii: {
      name: 'Customer PII — Governance refusal',
      description: 'A customer_pii table tagged PII. The guardrail (Phase 3) refuses to act without explicit approval.',
    },
  }
  return {
    mode: 'demo',
    scenarios: scenarioIds.map((id) => ({
      id,
      name: scenarioMeta[id]?.name ?? id,
      description: scenarioMeta[id]?.description ?? '',
      assets: assets
        .filter((a) => a.scenarioId === id)
        .map(seedAssetToEntity),
      lineageEdges: edges
        .filter((e) => e.scenarioId === id)
        .map((e) => ({ fromUrn: e.fromUrn, toUrn: e.toUrn, via: e.via ?? undefined })),
      assertions: assertions
        .filter((a) => a.scenarioId === id)
        .map((a) => ({
          urn: a.urn,
          assetUrn: a.assetUrn,
          type: a.type as AssertionRecord['type'],
          status: a.status as AssertionRecord['status'],
          description: a.description,
          slaSeconds: a.slaSeconds ?? undefined,
          lastEvaluatedAt: a.lastEvaluatedAt.toISOString(),
          lastSuccessAt: a.lastSuccessAt?.toISOString(),
          failureReason: a.failureReason ?? undefined,
          scenarioId: a.scenarioId,
        })),
      contextDocs: docs
        .filter((d) => d.scenarioId === id)
        .map((d) => ({
          urn: d.urn,
          title: d.title,
          assetUrn: d.assetUrn,
          sentinelPostMortem: d.sentinelPostMortem,
          createdAt: d.createdAt.toISOString(),
        })),
    })),
  }
}

// ---------------------------------------------------------------------------
// "Print lineage" — the deliverable ("a script that prints lineage").
// Renders a tree from a given URN, depth-first, downstream by default.
// ---------------------------------------------------------------------------

export async function printLineage(
  urn: Urn,
  direction: 'upstream' | 'downstream' = 'downstream',
  maxHops = 3,
): Promise<string> {
  const asset = await db.seedAsset.findUnique({ where: { urn } })
  const lines: string[] = []
  const rootName = asset?.name ?? urn
  lines.push(`${rootName}  [${asset?.platform ?? ''}·${asset?.type ?? 'dataset'}]`)
  const seen = new Set<Urn>([urn])
  await walk(urn, '', direction, maxHops, 1, seen, lines)
  return lines.join('\n')
}

async function walk(
  urn: Urn,
  prefix: string,
  direction: 'upstream' | 'downstream',
  maxHops: number,
  depth: number,
  seen: Set<Urn>,
  lines: string[],
): Promise<void> {
  if (depth > maxHops) return
  const edges =
    direction === 'upstream'
      ? await db.seedLineageEdge.findMany({ where: { toUrn: urn } })
      : await db.seedLineageEdge.findMany({ where: { fromUrn: urn } })
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    const nextUrn = direction === 'upstream' ? e.fromUrn : e.toUrn
    const last = i === edges.length - 1
    const branch = last ? '└─ ' : '├─ '
    const child = await db.seedAsset.findUnique({ where: { urn: nextUrn } })
    const label = child ? `${child.name}  [${child.platform}·${child.type}]` : nextUrn
    lines.push(`${prefix}${branch}${direction === 'upstream' ? '↑ ' : '↓ '}${label}`)
    if (!seen.has(nextUrn)) {
      seen.add(nextUrn)
      await walk(
        nextUrn,
        prefix + (last ? '   ' : '│  '),
        direction,
        maxHops,
        depth + 1,
        seen,
        lines,
      )
    }
  }
}
