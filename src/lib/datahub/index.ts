// =============================================================================
// Sentinel — DataHub client factory
//
// Phase 1 (PDF §10.3 / v2 plan §"Phase 1 — Switch by DATAHUB_MODE env var")
//
//   import { getDataHub } from '@/lib/datahub'
//   const { mcp, contextKit, ingestion, mode } = await getDataHub()
//
// `getDataHub()` returns a `DataHubClients` bundle. In DEMO mode all three
// clients are backed by the Prisma seed (./mock/mock-datahub.ts). In LIVE
// mode they are the real HTTP/GraphQL clients (./live/*). The orchestrator
// (Phase 2) calls the same methods either way — flipping the env var flips
// the whole agent from a local SQLite demo to a real DataHub deployment.
// =============================================================================

import { db } from '@/lib/db'
import type { DataHubClients } from './types'
import {
  MockContextKitClient,
  MockIngestionClient,
  MockMcpClient,
} from './mock/mock-datahub'
import { LiveContextKitClient } from './live/live-contextkit'
import { LiveIngestionClient } from './live/live-ingestion'
import { LiveMcpClient } from './live/live-mcp'

export type DataHubMode = 'demo' | 'live'

let cached: DataHubClients | null = null

export function getDataHubMode(): DataHubMode {
  const raw = (process.env.DATAHUB_MODE ?? 'demo').toLowerCase()
  if (raw === 'live' && process.env.DATAHUB_GMS_URL) return 'live'
  return 'demo'
}

/** True if the Prisma seed has been applied (≥1 SeedAsset row exists). */
export async function isSeeded(): Promise<boolean> {
  try {
    const n = await db.seedAsset.count()
    return n > 0
  } catch {
    return false
  }
}

export async function getDataHub(): Promise<DataHubClients> {
  if (cached) return cached
  const mode = getDataHubMode()
  if (mode === 'live') {
    const gms = process.env.DATAHUB_GMS_URL!
    const token = process.env.DATAHUB_TOKEN
    cached = {
      mode: 'live',
      mcp: new LiveMcpClient({ endpoint: `${gms}/mcp`, token }),
      contextKit: new LiveContextKitClient({ endpoint: `${gms}/ack`, token }),
      ingestion: new LiveIngestionClient({ gmsUrl: gms, token }),
    }
    return cached
  }
  cached = {
    mode: 'demo',
    mcp: new MockMcpClient(),
    contextKit: new MockContextKitClient(),
    ingestion: new MockIngestionClient(),
  }
  return cached
}

/** Test/reset hook — used by the API routes to drop the cached clients. */
export function resetDataHubCache(): void {
  cached = null
}
