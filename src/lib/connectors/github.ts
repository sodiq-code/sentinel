// =============================================================================
// Sentinel — GitHub connector (Phase 3)
//
// PDF §10.3 Phase 3 spec:
//   - openIssue(repo, title, body, labels) — POST /repos/{repo}/issues
//   - openPR(repo, title, body, branch, base) — POST /repos/{repo}/pulls
//   - **NEVER merges** a PR (PDF §9.3.5 no-merge policy). There is no `merge`
//     method on this connector. The PR is always left OPEN for human review.
//   - Trace mode (SENTINEL_DRY_RUN=true): writes a JSON line to
//     `examples/trace/github-actions.log`, returns a trace URL — no
//     GitHub API call is made. This is the dry-run toggle (PDF §11.3).
//
// Token scope (PDF §10.3): a single PAT scoped to the demo repo
// with `issues:write` + `pull_requests:write` only. We never ask for
// `repo:admin` or `contents:write` — so we cannot push branches, cannot
// merge, cannot delete.
//
// This file runs on the SERVER only. The token is read from process.env at
// call-time, never logged, never sent to client.
// =============================================================================

import { appendTraceLog, isDryRun, requireEnv } from './_trace'

const GITHUB_API = 'https://api.github.com'

export interface GitHubIssueInput {
  /** owner/name — defaults to GITHUB_DEMO_REPO. */
  repo?: string
  title: string
  body: string
  labels?: string[]
}

export interface GitHubIssueResult {
  kind: 'github.openIssue'
  repo: string
  number: number
  url: string
  state: 'open'
  /** True when the action was logged to a trace file instead of hitting the live API. */
  trace: boolean
  ts: string
  /** 'new' = a fresh issue was opened. 'commented' = a comment was appended to an existing open issue with the same title (dedup). */
  dedup?: 'new' | 'commented'
  /** When dedup='commented', the issue number that received the comment. */
  dedupOfIssue?: number
}

export interface GitHubPrInput {
  repo?: string
  title: string
  body: string
  /** Head branch — must already exist on the repo (Phase 3 does NOT push branches). */
  branch: string
  /** Base branch to merge into. Defaults to 'main'. */
  base?: string
}

export interface GitHubPrResult {
  kind: 'github.openPR'
  repo: string
  number: number
  url: string
  state: 'open'
  /** Sentinel NEVER merges — surfaced in UI as a NOT MERGED badge (PDF §9.3.5). */
  mergeable: boolean | null
  /** True when the action was logged to a trace file instead of hitting the live API. */
  trace: boolean
  ts: string
}

export interface GitHubConnectorStatus {
  mode: 'live' | 'trace'
  repo: string
  dryRun: boolean
  tokenPresent: boolean
  reachable: boolean
  defaultBranch?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Token + repo resolution
// ---------------------------------------------------------------------------

function getToken(): string | null {
  const t = process.env.GITHUB_TOKEN
  return t && t.trim() ? t.trim() : null
}

function defaultRepo(): string {
  return process.env.GITHUB_DEMO_REPO || 'sodiq-code/sentinel-demo-pipeline'
}

// ---------------------------------------------------------------------------
// Shared fetch with Authorization + Accept + UA headers (GitHub requires UA).
// ---------------------------------------------------------------------------

async function ghFetch(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const token = requireEnv('GITHUB_TOKEN', 'GitHub connector')
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sentinel-agent/1.0 (+https://github.com/sodiq-code/sentinel)',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: res.status, body, headers: res.headers }
}

// ---------------------------------------------------------------------------
// openIssue — POST /repos/{repo}/issues
// Idempotency (search-before-create): if an OPEN issue with the SAME title
// already exists in this repo, we append the new context as a COMMENT on
// that issue instead of opening a duplicate. This is the production-grade
// behaviour expected of an autonomous agent — repeated signals for the
// same breach surface as a threaded timeline, not as duplicate tickets.
// Set SENTINEL_GITHUB_DEDUP=false to disable (always open a new issue).
// ---------------------------------------------------------------------------

async function findOpenIssueByTitle(
  repo: string,
  title: string,
): Promise<{ number: number; url: string } | null> {
  // GitHub's REST search for issues does not support an exact-title filter
  // server-side beyond the `in:title` qualifier. We fetch the most recent 50
  // open issues and compare the title verbatim — cheap (one paginated call)
  // and precise. 50 is plenty for a demo repo; production would paginate.
  // We retry twice (with short sleeps) because GitHub's issue-list endpoint is
  // eventually consistent: a freshly-created issue may take ~5s to appear in
  // the list, even though the POST /issues call returned 201 immediately.
  // This only impacts back-to-back calls within a few seconds; real agent
  // runs are spaced by LLM thinking time (5-30s) and find the issue on the
  // first attempt.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { status, body } = await ghFetch(
      `/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=50`,
    )
    if (status === 200 && Array.isArray(body)) {
      for (const issue of body as Array<{ title: string; number: number; html_url: string; pull_request?: unknown }>) {
        // Skip PRs — the issues list includes them when state=open.
        if (issue.pull_request) continue
        if (issue.title.trim() === title.trim()) {
          return { number: issue.number, url: issue.html_url }
        }
      }
    }
    // No match this attempt — brief pause then retry (eventual consistency).
    if (attempt < 2) await new Promise((r) => setTimeout(r, 2500))
  }
  return null
}

async function appendCommentToIssue(
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  const { status, body: respBody } = await ghFetch(
    `/repos/${repo}/issues/${issueNumber}/comments`,
    { method: 'POST', body: JSON.stringify({ body }) },
  )
  if (status !== 201) {
    const detail =
      typeof respBody === 'object' && respBody && 'message' in respBody
        ? (respBody as { message: string }).message
        : `GitHub comments POST returned ${status}`
    throw new Error(`GitHub appendComment failed: ${detail}`)
  }
}

function dedupEnabled(): boolean {
  const raw = (process.env.SENTINEL_GITHUB_DEDUP ?? 'true').toLowerCase()
  return raw !== 'false' && raw !== '0' && raw !== 'off'
}

export async function openIssue(input: GitHubIssueInput): Promise<GitHubIssueResult> {
  const repo = input.repo || defaultRepo()
  const ts = new Date().toISOString()
  const labels = (input.labels || []).filter(Boolean)

  if (await isDryRun()) {
    const traceRec = {
      kind: 'github.openIssue',
      repo,
      title: input.title,
      body: input.body,
      labels,
      ts,
    }
    await appendTraceLog('github', traceRec)
    return {
      kind: 'github.openIssue',
      repo,
      number: -1,
      url: `trace://github/${repo}/issues/${Date.now()}`,
      state: 'open',
      trace: true,
      ts,
    }
  }

  // Live: search-before-create (idempotency). If an open issue with the
  // exact same title exists, append the new context as a comment instead
  // of opening a duplicate. Suppresses the "20 identical issues" pattern
  // on repeat agent runs for the same signal.
  if (dedupEnabled()) {
    const existing = await findOpenIssueByTitle(repo, input.title)
    if (existing) {
      const commentBody = [
        `**Sentinel re-detected this signal at ${ts}**`,
        '',
        'A new agent run observed the same breach and confirmed it is still open.',
        'Appending the latest context rather than opening a duplicate:',
        '',
        '---',
        '',
        input.body,
      ].join('\n')
      await appendCommentToIssue(repo, existing.number, commentBody)
      return {
        kind: 'github.openIssue',
        repo,
        number: existing.number,
        url: existing.url,
        state: 'open',
        trace: false,
        ts,
        dedup: 'commented',
        dedupOfIssue: existing.number,
      }
    }
  }

  // No existing open issue — create one. Labels are auto-created on the
  // repo if they don't exist.
  const { status, body } = await ghFetch(`/repos/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      labels,
    }),
  })
  if (status !== 201) {
    const detail =
      typeof body === 'object' && body && 'message' in body
        ? (body as { message: string }).message
        : `GitHub issues POST returned ${status}`
    throw new Error(`GitHub openIssue failed: ${detail}`)
  }
  const issue = body as { number: number; html_url: string; state: string }
  return {
    kind: 'github.openIssue',
    repo,
    number: issue.number,
    url: issue.html_url,
    state: 'open',
    trace: false,
    ts,
    dedup: 'new',
  }
}

// ---------------------------------------------------------------------------
// openPR — POST /repos/{repo}/pulls. NEVER merges.
// ---------------------------------------------------------------------------

export async function openPR(input: GitHubPrInput): Promise<GitHubPrResult> {
  const repo = input.repo || defaultRepo()
  const ts = new Date().toISOString()
  const branch = input.branch || 'sentinel/proposed-fix'
  const base = input.base || 'main'

  if (await isDryRun()) {
    const traceRec = {
      kind: 'github.openPR',
      repo,
      title: input.title,
      body: input.body,
      branch,
      base,
      neverMerged: true,
      ts,
    }
    await appendTraceLog('github', traceRec)
    return {
      kind: 'github.openPR',
      repo,
      number: -1,
      url: `trace://github/${repo}/pulls/${Date.now()}`,
      state: 'open',
      mergeable: null,
      trace: true,
      ts,
    }
  }

  // Live: open the PR. Sentinel does NOT push branches — the head branch must
  // already exist on the repo (Phase 3 only opens PRs the human can review).
  const { status, body } = await ghFetch(`/repos/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      head: branch,
      base,
      draft: false,
      maintainer_can_modify: true,
    }),
  })
  if (status !== 201) {
    const detail =
      typeof body === 'object' && body && 'message' in body
        ? (body as { message: string }).message
        : `GitHub pulls POST returned ${status}`
    throw new Error(`GitHub openPR failed: ${detail}`)
  }
  const pr = body as { number: number; html_url: string; state: string; mergeable: boolean | null }
  return {
    kind: 'github.openPR',
    repo,
    number: pr.number,
    url: pr.html_url,
    state: 'open',
    mergeable: pr.mergeable,
    trace: false,
    ts,
  }
}

// ---------------------------------------------------------------------------
// getRepoInfo — used by /api/connectors/status to verify reachability.
// ---------------------------------------------------------------------------

export async function getRepoInfo(repo?: string): Promise<{
  ok: boolean
  full_name?: string
  default_branch?: string
  private?: boolean
  error?: string
}> {
  const target = repo || defaultRepo()
  if (!getToken()) {
    return { ok: false, error: 'GITHUB_TOKEN not set' }
  }
  try {
    const { status, body } = await ghFetch(`/repos/${target}`)
    if (status !== 200) {
      const detail =
        typeof body === 'object' && body && 'message' in body
          ? (body as { message: string }).message
          : `HTTP ${status}`
      return { ok: false, error: detail }
    }
    const r = body as { full_name: string; default_branch: string; private: boolean }
    return {
      ok: true,
      full_name: r.full_name,
      default_branch: r.default_branch,
      private: r.private,
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// status() — surfaced by /api/connectors/status for the DemoControlBar chip.
// ---------------------------------------------------------------------------

export async function githubStatus(): Promise<GitHubConnectorStatus> {
  const repo = defaultRepo()
  const dryRun = await isDryRun()
  const tokenPresent = Boolean(getToken())
  if (dryRun) {
    return { mode: 'trace', repo, dryRun: true, tokenPresent, reachable: false }
  }
  if (!tokenPresent) {
    return { mode: 'live', repo, dryRun: false, tokenPresent: false, reachable: false, error: 'GITHUB_TOKEN not set' }
  }
  const info = await getRepoInfo(repo)
  return {
    mode: 'live',
    repo,
    dryRun: false,
    tokenPresent: true,
    reachable: info.ok,
    defaultBranch: info.default_branch,
    error: info.error,
  }
}
