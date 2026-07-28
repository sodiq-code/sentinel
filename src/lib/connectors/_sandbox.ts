// =============================================================================
// Sentinel — Connector environment helpers (Phase 3)
//
// Tiny shared helpers used by both connectors (github, slack):
//   - requireEnv(name, who) — fail loudly if a secret is missing, so the
//     operator sees "SLACK_BOT_TOKEN not set" not "401 from Slack".
//   - sandboxLogPath(kind) — `examples/sandbox/{kind}-actions.log` JSONL
//   - appendSandboxLog(kind, record) — append-only JSONL; mkdir -p the dir.
//   - readSandboxLog(kind, limit) — read the last N entries (newest last).
//
// Sandbox log files are gitignored (Phase 3 .gitignore update), so live demo
// runs never leak secrets or transient IO into the repo.
// =============================================================================

import { promises as fs } from 'fs'
import * as path from 'path'

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

export function isDryRun(): boolean {
  return (process.env.SENTINEL_DRY_RUN ?? 'true').toLowerCase() !== 'false'
}

export function sandboxLogPath(kind: 'github' | 'slack'): string {
  return path.join(process.cwd(), 'examples', 'sandbox', `${kind}-actions.log`)
}

/** Append a sandbox log record as one JSON line per call (JSONL). */
export async function appendSandboxLog(
  kind: 'github' | 'slack',
  record: Record<string, unknown>,
): Promise<void> {
  const file = sandboxLogPath(kind)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf8')
}

/** Read the last N sandbox log entries (newest last). Returns [] if file missing. */
export async function readSandboxLog(
  kind: 'github' | 'slack',
  limit = 50,
): Promise<Record<string, unknown>[]> {
  const file = sandboxLogPath(kind)
  try {
    const txt = await fs.readFile(file, 'utf8')
    const lines = txt.split('\n').filter(Boolean)
    const start = Math.max(0, lines.length - limit)
    return lines.slice(start).map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>
      } catch {
        return { _raw: l }
      }
    })
  } catch {
    return []
  }
}
