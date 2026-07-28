import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { Urn } from '@/lib/datahub/types'

export const dynamic = 'force-dynamic'

// =============================================================================
// GET /api/datahub/lineage-graph?urn=<urn>&maxHops=<n>
//
// Phase 5 — Incident Console UI. Returns the full lineage graph (root +
// upstream + downstream nodes + explicit edges) so the SVG <LineageGraph>
// component can render the asset's context graph in one shot, with the
// failing asset highlighted in the centre and traversal edges animated as
// the agent calls `mcp.get_lineage` in the reasoning trace.
//
// Unlike /api/datahub/lineage (which returns a flat BFS node list per
// direction), this endpoint returns explicit `edges: [{from, to, via}]`
// so the SVG can draw arrows. Upstream and downstream are merged into one
// bidirectional graph centred on `urn` (upstream degree is negative,
// downstream positive).
// =============================================================================

interface GraphNode {
  urn: string
  name: string
  type: string
  platform: string
  degree: number // negative = upstream, 0 = root, positive = downstream
  scenarioId: string
}

interface GraphEdge {
  from: string
  to: string
  via: string | null
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const urn = searchParams.get('urn')
  if (!urn) {
    return NextResponse.json({ error: 'missing required `urn` query param' }, { status: 400 })
  }
  const maxHops = Math.min(Number(searchParams.get('maxHops') ?? '3'), 4)

  const rootRow = await db.seedAsset.findUnique({ where: { urn } })
  const rootScenario = rootRow?.scenarioId ?? 'nyc-taxi-freshness'

  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const edgeKey = new Set<string>()

  if (rootRow) {
    nodes.set(urn, {
      urn,
      name: rootRow.name,
      type: rootRow.type,
      platform: rootRow.platform,
      degree: 0,
      scenarioId: rootRow.scenarioId,
    })
  } else {
    nodes.set(urn, { urn, name: urn, type: 'dataset', platform: '', degree: 0, scenarioId: rootScenario })
  }

  // Walk downstream (positive degree).
  const downQueue: Array<{ urn: Urn; degree: number }> = [{ urn, degree: 0 }]
  const downSeen = new Set<string>([urn])
  while (downQueue.length) {
    const cur = downQueue.shift()!
    if (cur.degree >= maxHops) continue
    const out = await db.seedLineageEdge.findMany({ where: { fromUrn: cur.urn } })
    for (const e of out) {
      const to = e.toUrn
      const ek = `${e.fromUrn}->${to}`
      if (!edgeKey.has(ek)) {
        edgeKey.add(ek)
        edges.push({ from: e.fromUrn, to, via: e.via })
      }
      if (downSeen.has(to)) continue
      downSeen.add(to)
      const row = await db.seedAsset.findUnique({ where: { urn: to } })
      nodes.set(to, {
        urn: to,
        name: row?.name ?? to,
        type: row?.type ?? 'dataset',
        platform: row?.platform ?? '',
        degree: cur.degree + 1,
        scenarioId: row?.scenarioId ?? rootScenario,
      })
      downQueue.push({ urn: to, degree: cur.degree + 1 })
    }
  }

  // Walk upstream (negative degree).
  const upQueue: Array<{ urn: Urn; degree: number }> = [{ urn, degree: 0 }]
  const upSeen = new Set<string>([urn])
  while (upQueue.length) {
    const cur = upQueue.shift()!
    if (-cur.degree >= maxHops) continue
    const inc = await db.seedLineageEdge.findMany({ where: { toUrn: cur.urn } })
    for (const e of inc) {
      const from = e.fromUrn
      const ek = `${from}->${e.toUrn}`
      if (!edgeKey.has(ek)) {
        edgeKey.add(ek)
        edges.push({ from, to: e.toUrn, via: e.via })
      }
      if (upSeen.has(from)) continue
      upSeen.add(from)
      const row = await db.seedAsset.findUnique({ where: { urn: from } })
      nodes.set(from, {
        urn: from,
        name: row?.name ?? from,
        type: row?.type ?? 'dataset',
        platform: row?.platform ?? '',
        degree: cur.degree - 1,
        scenarioId: row?.scenarioId ?? rootScenario,
      })
      upQueue.push({ urn: from, degree: cur.degree - 1 })
    }
  }

  return NextResponse.json({
    root: urn,
    rootScenario,
    nodes: Array.from(nodes.values()),
    edges,
  })
}
