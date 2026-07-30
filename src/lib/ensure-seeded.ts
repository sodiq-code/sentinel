// =============================================================================
// Sentinel — ensure the DB has seed data before the orchestrator runs.
//
// On the local dev server, `bun run db:seed` is run manually once and the
// data persists. On Vercel's serverless runtime with Turso (libSQL) the
// data also persists across cold starts (managed DB), but this helper
// remains a safety net: it detects an empty DB and runs the idempotent
// seed inline on the first request after a cold start. Subsequent warm
// requests skip the re-seed (the module-level `seeded` flag is cached
// for the lifetime of the serverless instance).
//
// The seed takes ~200-500ms (9 assets, 6 edges, 4 assertions, 1 context
// doc) — negligible on cold start, zero on warm starts.
// =============================================================================

import { db } from './db'

let seeded = false

export async function ensureSeeded(): Promise<void> {
  if (seeded) return
  const count = await db.seedAsset.count()
  if (count > 0) {
    seeded = true
    return
  }
  // Dynamic import so the seed module (heavy: 500 lines of fixtures) is only
  // loaded when actually needed — keeps warm starts fast.
  const { runSeed } = await import('../../prisma/seed')
  await runSeed()
  seeded = true
}
