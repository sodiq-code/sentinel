// =============================================================================
// Sentinel — Runtime settings (DB-backed, UI-toggleable)
//
// Vercel serverless functions have read-only env vars (you cannot change
// process.env.SENTINEL_DRY_RUN at runtime and have it survive across requests
// or warm lambdas). To let the dashboard toggle DRY-RUN without a redeploy,
// we persist overrides in the Setting table.
//
// Resolution order for any setting:
//   1. DB Setting row (if present) — the UI toggle's source of truth
//   2. process.env.<ENV_NAME>          — the deployment default
//   3. <fallback>                      — the hardcoded safe default
//
// All settings are read server-side only. The API routes expose them via
// /api/settings (GET) and /api/settings (PATCH).
// =============================================================================

import { db } from '@/lib/db'

/** The canonical list of toggleable settings. */
export interface AppSettings {
  /** When true, GitHub + Slack actions write to trace logs (no real artifacts). */
  dryRun: boolean
  /** True when the DB override is the active source (vs the env-var default). */
  dryRunOverridden: boolean
}

/** In-memory cache (per warm lambda). TTL-bounded so a PATCH eventually
 *  propagates without a full process restart. */
let cached: { value: AppSettings; expiresAt: number } | null = null
const CACHE_TTL_MS = 3_000 // 3 seconds — short enough for a UI toggle to feel responsive

async function readDbSetting(key: string): Promise<string | null> {
  try {
    const row = await db.setting.findUnique({ where: { key } })
    return row?.value ?? null
  } catch {
    // DB unavailable (e.g. cold start race) — fall back to env.
    return null
  }
}

async function writeDbSetting(key: string, value: string): Promise<void> {
  // Use findFirst + create/update instead of upsert — the libsql/SQLite
  // adapter occasionally segfaults on upsert with a composite where clause.
  // Wrap in try/catch so a DB error NEVER crashes the serverless function.
  try {
    const existing = await db.setting.findUnique({ where: { key } })
    if (existing) {
      await db.setting.update({ where: { key }, data: { value } })
    } else {
      await db.setting.create({ data: { key, value } })
    }
  } catch (err) {
    // Log + rethrow as a plain Error so the API route returns 500 instead of
    // crashing the process. The caller already has a try/catch.
    console.error('[settings] writeDbSetting failed:', err)
    throw new Error(`Failed to persist setting: ${(err as Error).message}`)
  }
  // Invalidate the cache so the next read sees the new value.
  cached = null
}

function envDryRun(): boolean {
  return (process.env.SENTINEL_DRY_RUN ?? 'true').toLowerCase() !== 'false'
}

/** Read the current effective settings (DB override > env > default). */
export async function getSettings(): Promise<AppSettings> {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value
  }
  const dbVal = await readDbSetting('sentinel.dryRun')
  let dryRun: boolean
  let dryRunOverridden = false
  if (dbVal === 'true' || dbVal === 'false') {
    dryRun = dbVal === 'true'
    dryRunOverridden = true
  } else {
    dryRun = envDryRun()
    dryRunOverridden = false
  }
  const value: AppSettings = { dryRun, dryRunOverridden }
  cached = { value, expiresAt: Date.now() + CACHE_TTL_MS }
  return value
}

/** Toggle DRY-RUN. Writes the DB override + invalidates the cache. */
export async function setDryRun(enabled: boolean): Promise<AppSettings> {
  await writeDbSetting('sentinel.dryRun', enabled ? 'true' : 'false')
  return getSettings()
}

/** Reset DRY-RUN to the env-var default (deletes the DB override). */
export async function resetDryRun(): Promise<AppSettings> {
  try {
    await db.setting.delete({ where: { key: 'sentinel.dryRun' } })
  } catch {
    // already absent — fine
  }
  cached = null
  return getSettings()
}

/**
 * The effective DRY-RUN flag for the connector layer. Call this at the top of
 * every code path that branches on dryRun (github.ts, slack.ts, the
 * orchestrator's connector calls). This is async (DB read) — the connectors
 * were already async, so this is a non-issue.
 */
export async function isDryRunEffective(): Promise<boolean> {
  const s = await getSettings()
  return s.dryRun
}

/** Synchronous variant — returns the CACHED effective value, or the env-var
 *  default if the cache is cold. Use this ONLY in code paths that cannot be
 *  made async (e.g. a synchronous guard). Prefer isDryRunEffective(). */
export function isDryRunCached(): boolean {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value.dryRun
  }
  return envDryRun()
}
