// =============================================================================
// Sentinel — Slack Connector (Phase 3)
//
// PDF §10.3 Phase 3 spec:
//   postTriage(channel, summary) — Slack Web API `chat.postMessage` with a
//   structured, scannable triage card (3 bullets — what failed, who is
//   affected, what on-call should do). Trace mode writes JSONL to
//   `examples/trace/slack-posts.log`.
//
// Token scope (PDF §10.3): a single bot token scoped to one channel
// (chat:write + the bot's user identity). The bot does NOT need
// `channels:read` — chat:write is sufficient to post to a channel it has
// been invited to. Verified live: sentinel_bot2 posts to C0BL9CQ4D5G.
//
// PDF §11.1 beat 1:30–2:00 — the Slack triage card surfaces in the demo
// UI as part of <ActionsPanel>.
// =============================================================================

import { appendTraceLog, isDryRun, requireEnv } from './_trace'

const SLACK_API = 'https://slack.com/api'

export interface SlackTriageInput {
  /** Channel ID — defaults to SLACK_DEMO_CHANNEL. */
  channel?: string
  /** Short headline — the failing asset + signal type. */
  title: string
  /** 1–3 bullet strings (already formatted). Caller decides the bullets. */
  bullets: string[]
  /** Optional footer line (e.g. "Sentinel incident urn:..."). */
  footer?: string
}

export interface SlackPostResult {
  kind: 'slack.postMessage'
  channel: string
  ts: string | null
  url: string
  /** True when the action was logged to a trace file instead of hitting the live API. */
  trace: boolean
  ok: boolean
}

// ---------------------------------------------------------------------------
// Slack auth — used by /api/connectors/status for the live/trace chip.
// ---------------------------------------------------------------------------

export function slackToken(): string | null {
  const t = process.env.SLACK_BOT_TOKEN
  return t && t.trim() ? t.trim() : null
}

export function defaultChannel(): string {
  return process.env.SLACK_DEMO_CHANNEL || 'C0BL9CQ4D5G'
}

export function isSlackDryRun(): boolean {
  return isDryRun()
}

// ---------------------------------------------------------------------------
// postTriage — render the triage card + chat.postMessage.
// ---------------------------------------------------------------------------

function bulletBlock(text: string) {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text },
  }
}

export function renderTriageBlocks(input: SlackTriageInput) {
  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🛡️ ${input.title}` },
    },
    { type: 'divider' },
    ...input.bullets.map((b) => bulletBlock(`• ${b}`)),
  ]
  if (input.footer) {
    blocks.push({ type: 'divider' })
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: input.footer }],
    })
  }
  return blocks
}

export async function postTriage(input: SlackTriageInput): Promise<SlackPostResult> {
  const channel = input.channel || defaultChannel()
  const ts = new Date().toISOString()
  const blocks = renderTriageBlocks(input)
  const text = `${input.title}\n${input.bullets.map((b) => `• ${b}`).join('\n')}`

  if (isDryRun()) {
    const traceRec = {
      kind: 'slack.postMessage',
      channel,
      title: input.title,
      bullets: input.bullets,
      footer: input.footer,
      text,
      ts,
    }
    await appendTraceLog('slack', traceRec)
    return {
      kind: 'slack.postMessage',
      channel,
      ts: null,
      url: `trace://slack/${channel}/${Date.now()}`,
      trace: true,
      ok: true,
    }
  }

  // Live: chat.postMessage
  const token = requireEnv('SLACK_BOT_TOKEN', 'Slack connector')
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel, text, blocks, unfurl_links: false }),
  })
  const body = (await res.json()) as {
    ok?: boolean
    error?: string
    ts?: string
    channel?: string
  }
  if (!body.ok) {
    throw new Error(`Slack chat.postMessage failed: ${body.error ?? 'unknown error'}`)
  }
  const chan = body.channel ?? channel
  const cleanTs = body.ts ? body.ts.replace('.', '') : ''
  return {
    kind: 'slack.postMessage',
    channel: chan,
    ts: body.ts ?? null,
    url: cleanTs ? `https://slack.com/archives/${chan}/${cleanTs}` : '',
    trace: false,
    ok: true,
  }
}

// ---------------------------------------------------------------------------
// status() — surfaced by /api/connectors/status.
// ---------------------------------------------------------------------------

export async function slackStatus(): Promise<{
  mode: 'live' | 'trace'
  channel: string
  tokenPresent: boolean
  reachable: boolean
  botUser?: string
  team?: string
  error?: string
}> {
  const channel = defaultChannel()
  if (isDryRun()) {
    return {
      mode: 'trace',
      channel,
      tokenPresent: Boolean(slackToken()),
      reachable: false,
    }
  }
  const token = slackToken()
  if (!token) {
    return { mode: 'live', channel, tokenPresent: false, reachable: false, error: 'SLACK_BOT_TOKEN not set' }
  }
  try {
    const res = await fetch(`${SLACK_API}/auth.test`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = (await res.json()) as {
      ok?: boolean
      error?: string
      user?: string
      team?: string
      url?: string
    }
    if (!body.ok) {
      return { mode: 'live', channel, tokenPresent: true, reachable: false, error: body.error }
    }
    return {
      mode: 'live',
      channel,
      tokenPresent: true,
      reachable: true,
      botUser: body.user,
      team: body.team,
    }
  } catch (err) {
    return {
      mode: 'live',
      channel,
      tokenPresent: true,
      reachable: false,
      error: (err as Error).message,
    }
  }
}
