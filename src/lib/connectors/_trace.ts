// =============================================================================
// Sentinel — Connector environment helpers
//
// Tiny shared helpers used by both connectors (github, slack):
//   - requireEnv(name, who) — fail loudly if a secret is missing, so the
//     operator sees "SLACK_BOT_TOKEN not set" not "401 from Slack".
//   - isDryRun() — honors SENTINEL_DRY_RUN (default true).
//   - traceLogPath(kind) — resolves a writable trace path. On Vercel the
//     function filesystem is read-only (/var/task), so we redirect to /tmp.
//     Locally we keep examples/trace/*.log (gitignored).
//   - appendTraceLog(kind, record) — append-only JSONL; mkdir -p the dir.
//     ALWAYS also pushes into an in-memory ring buffer so the trace log
//     works even on a fully read-only serverless filesystem.
//   - readTraceLog(kind, limit) — read the last N entries (newest last).
//     Reads from disk when available, falls back to the in-memory buffer.
//
// Trace log files are gitignored (.gitignore), so live demo runs never leak
// secrets or transient IO into the repo.
// =============================================================================

import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { isDryRunEffective, isDryRunCached } from '@/lib/settings'

export function requireEnv(name: string, who: string): string {
  const v = process.env[name]
  if (!v || !v.trim()) {
    throw new Error(
      `${who}: environment variable '${name}' is not set. ` +
        `Set it in .env (see .env.example).`,
    )
  }
  return v.trim()
}

/**
 * The effective DRY-RUN flag. Resolution order:
 *   1. DB Setting row (UI toggle) — if set
 *   2. process.env.SENTINEL_DRY_RUN — the deployment default
 *   3. true (safe-by-default)
 *
 * The async variant is preferred for code paths that can await. The sync
 * variant returns the cached value (or the env default if the cache is cold)
 * and is only for code that cannot be made async.
 */
export async function isDryRun(): Promise<boolean> {
  return isDryRunEffective()
}

/** Synchronous variant — see isDryRunEffective() docs. */
export function isDryRunSync(): boolean {
  return isDryRunCached()
}

// True on Vercel serverless (and any read-only-cwd environment). Vercel sets
// VERCEL=1 and runs the function from /var/task which is NOT writable.
function isServerlessReadOnly(): boolean {
  if (process.env.VERCEL === '1') return true
  // Defensive: /var/task is Vercel's lambda root; if cwd is under it, treat
  // the filesystem as read-only.
  if (process.cwd().startsWith('/var/task')) return true
  return false
}

export function traceLogPath(kind: 'github' | 'slack'): string {
  // On Vercel, /tmp is the only writable directory in a serverless function.
  // Locally, keep examples/trace/*.log (gitignored) so the repo stays clean.
  const dir = isServerlessReadOnly()
    ? path.join(os.tmpdir(), 'sentinel-trace')
    : path.join(process.cwd(), 'examples', 'trace')
  return path.join(dir, `${kind}-actions.log`)
}

// In-memory ring buffer — the ALWAYS-AVAILABLE fallback. On a read-only
// serverless filesystem (or if the mkdir/appendFile throws for any reason),
// we still retain the last N trace records so /api/connectors/trace-log can
// surface them in the dashboard. This is process-scoped, so on Vercel each
// warm lambda instance has its own buffer — acceptable for a demo trace log.
const MEM_BUFFER: Record<'github' | 'slack', Array<Record<string, unknown>>> = {
  github: [],
  slack: [],
}
const MEM_BUFFER_MAX = 200

/** Append a trace log record as one JSON line per call (JSONL).
 *  NEVER throws — if the filesystem is read-only or the write fails, the
 *  record is retained in the in-memory buffer instead. */
export async function appendTraceLog(
  kind: 'github' | 'slack',
  record: Record<string, unknown>,
): Promise<void> {
  // 1) Always keep the in-memory copy (works on every environment).
  MEM_BUFFER[kind].push(record)
  if (MEM_BUFFER[kind].length > MEM_BUFFER_MAX) {
    MEM_BUFFER[kind] = MEM_BUFFER[kind].slice(-MEM_BUFFER_MAX)
  }

  // 2) Best-effort filesystem append. Swallow errors so a read-only
  //    serverless filesystem never breaks the agent run.
  try {
    const file = traceLogPath(kind)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf8')
  } catch {
    // Filesystem not writable (e.g. Vercel /var/task) — the in-memory
    // buffer already holds the record. No action needed.
  }
}

/** Read the last N trace log entries (newest last). Merges the on-disk
 *  JSONL log with the in-memory buffer (deduped by ts), so the dashboard
 *  always sees the freshest entries regardless of where they were stored. */
export async function readTraceLog(
  kind: 'github' | 'slack',
  limit = 50,
): Promise<Record<string, unknown>[]> {
  let disk: Record<string, unknown>[] = []
  try {
    const file = traceLogPath(kind)
    const txt = await fs.readFile(file, 'utf8')
    const lines = txt.split('\n').filter(Boolean)
    disk = lines.map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>
      } catch {
        return { _raw: l }
      }
    })
  } catch {
    // File missing or unreadable — fall through to the memory buffer.
  }

  // Merge disk + memory, dedupe by a stable key (ts|toolName|repo), then
  // return the newest `limit` entries in chronological order.
  const seen = new Set<string>()
  const merged: Record<string, unknown>[] = []
  for (const r of [...disk, ...MEM_BUFFER[kind]]) {
    const key = `${r.ts ?? ''}|${r.toolName ?? r.kind ?? ''}|${r.repo ?? r.channel ?? ''}|${r.url ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(r)
  }
  const start = Math.max(0, merged.length - limit)
  return merged.slice(start)
}
