// POST /api/connectors/test — open a test GitHub issue + post a test Slack
// triage card. Used by the DemoControlBar's "Test connectors" button.
//
// Body (optional):
//   { dryRun?: bool } — override SENTINEL_DRY_RUN for this test call only.
//
// Honors SENTINEL_DRY_RUN: if true, writes to the sandbox JSONL logs only.
// If false, opens a LIVE issue + posts a LIVE Slack message. The test
// artifacts are tagged with the `sentinel-test` label so the operator can
// identify + clean them up.
import { NextResponse } from 'next/server'
import { openIssue } from '@/lib/connectors/github'
import { postTriage } from '@/lib/connectors/slack'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  let body: { dryRun?: boolean } = {}
  try {
    body = (await req.json()) as { dryRun?: boolean }
  } catch {
    // body is optional
  }
  // If the caller wants to override for this one call, set the env var
  // transiently. This is a server-side state change scoped to the request.
  const previous = process.env.SENTINEL_DRY_RUN
  if (typeof body.dryRun === 'boolean') {
    process.env.SENTINEL_DRY_RUN = body.dryRun ? 'true' : 'false'
  }
  try {
    const ts = new Date().toISOString()
    const issue = await openIssue({
      title: `[Sentinel test] Connector probe ${ts}`,
      body: [
        '# Sentinel connector probe',
        '',
        'This issue was opened by the /api/connectors/test endpoint to verify',
        'the GitHub connector can authenticate + create issues on the sandbox',
        'repo.',
        '',
        `- Time: ${ts}`,
        `- Repo: ${process.env.GITHUB_DEMO_REPO}`,
        `- Mode: ${process.env.SENTINEL_DRY_RUN === 'false' ? 'LIVE' : 'SANDBOX'}`,
        '',
        'A human reviewer should close this issue. Sentinel will NEVER merge',
        'or close it (PDF §9.3.5).',
      ].join('\n'),
      labels: ['sentinel-test', 'auto-filed'],
    })
    const slack = await postTriage({
      title: 'Sentinel connector probe',
      bullets: [
        `*What*: connector probe (${process.env.SENTINEL_DRY_RUN === 'false' ? 'LIVE' : 'SANDBOX'})`,
        `*When*: ${ts}`,
        `*Action*: human reviewer should delete this message`,
      ],
      footer: `Sentinel probe — ${process.env.SLACK_DEMO_CHANNEL}`,
    })
    return NextResponse.json({
      ok: true,
      mode: process.env.SENTINEL_DRY_RUN === 'false' ? 'live' : 'sandbox',
      github: {
        repo: issue.repo,
        number: issue.number,
        url: issue.url,
        sandbox: issue.sandbox,
      },
      slack: {
        channel: slack.channel,
        ts: slack.ts,
        url: slack.url,
        sandbox: slack.sandbox,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    )
  } finally {
    // Restore the previous env var
    if (typeof body.dryRun === 'boolean') {
      process.env.SENTINEL_DRY_RUN = previous
    }
  }
}
