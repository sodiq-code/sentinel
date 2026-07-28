// GET /api/connectors/status — connector reachability for the DemoControlBar.
//
// Returns:
//   github:  { mode, repo, dryRun, tokenPresent, reachable, defaultBranch, error }
//   slack:   { mode, channel, tokenPresent, reachable, botUser, team, error }
//   dryRun:  bool
//
// PDF §11.3 contingency plan: the demo shows live/sandbox chips so the
// operator knows whether the next "Inject & run" will write to GitHub +
// Slack or to the sandbox JSONL log.
import { NextResponse } from 'next/server'
import { githubStatus } from '@/lib/connectors/github'
import { slackStatus } from '@/lib/connectors/slack'
import { isDryRun } from '@/lib/connectors/_sandbox'
import { isDemoMode, demoFixture } from '@/lib/demo-mode'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (isDemoMode()) return NextResponse.json(demoFixture('connectors-status'))
  const [github, slack] = await Promise.all([githubStatus(), slackStatus()])
  return NextResponse.json({
    dryRun: isDryRun(),
    github,
    slack,
  })
}
