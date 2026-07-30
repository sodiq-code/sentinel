// GET /api/connectors/status — connector reachability for the DemoControlBar.
//
// Returns:
//   github:  { mode, repo, dryRun, tokenPresent, reachable, defaultBranch, error }
//   slack:   { mode, channel, tokenPresent, reachable, botUser, team, error }
//   dryRun:  bool
//   dryRunOverridden: bool  — true when the UI toggle (DB Setting) is active
//
// The dryRun flag is resolved from the DB Setting (UI toggle) > env > default,
// so the dashboard reflects the runtime toggle without a redeploy.
import { NextResponse } from 'next/server'
import { githubStatus } from '@/lib/connectors/github'
import { slackStatus } from '@/lib/connectors/slack'
import { getSettings } from '@/lib/settings'
import { isPreviewMode, previewFixture } from '@/lib/demo-mode'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (isPreviewMode()) return NextResponse.json(previewFixture('connectors-status'))
  const [github, slack, settings] = await Promise.all([githubStatus(), slackStatus(), getSettings()])
  return NextResponse.json({
    dryRun: settings.dryRun,
    dryRunOverridden: settings.dryRunOverridden,
    github,
    slack,
  })
}
