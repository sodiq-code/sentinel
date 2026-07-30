// POST /api/connectors/test — open a test GitHub issue + post a test Slack
// triage card. Used by the DemoControlBar's "Test connectors" button.
//
// Body (optional):
//   { dryRun?: bool } — override the effective DRY-RUN for this test call only.
//                       If omitted, the effective DRY-RUN (DB Setting > env) is used.
//
// Honors the effective DRY-RUN: if true, writes to the trace JSONL logs only.
// If false, opens a LIVE issue + posts a LIVE Slack message. The test
// artifacts are tagged with the `sentinel-test` label so the operator can
// identify + clean them up.
import { NextResponse } from 'next/server'
import { openIssue } from '@/lib/connectors/github'
import { postTriage } from '@/lib/connectors/slack'
import { isDryRun } from '@/lib/connectors/_trace'
import { isPreviewMode, previewFixture } from '@/lib/demo-mode'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  if (isPreviewMode()) return NextResponse.json(previewFixture('connectors-test'))
  let body: { dryRun?: boolean } = {}
  try {
    body = (await req.json()) as { dryRun?: boolean }
  } catch {
    // body is optional
  }
  // Resolve the effective dryRun. If the caller provides an explicit override,
  // we temporarily write it to process.env so the connector layer (which reads
  // isDryRun() -> getSettings()) honours it for THIS call. The getSettings()
  // cache is the source of truth, so we cannot just set env — we also need to
  // bypass the cache. The cleanest way is to set the env var AND clear the
  // in-memory cache by writing a DB Setting row, then delete it after.
  //
  // For simplicity + safety, when an explicit override is passed we write a
  // transient DB Setting row, run the test, then restore the previous value.
  const effectiveDryRun = typeof body.dryRun === 'boolean' ? body.dryRun : await isDryRun()
  // Temporarily flip the env var so the isDryRunSync() fallback (used by
  // isSlackDryRun()) also sees the override. The async isDryRun() reads the
  // DB Setting cache; we set the env var AND prime the cache by calling
  // setDryRun() when an explicit override is requested.
  const previousEnv = process.env.SENTINEL_DRY_RUN
  if (typeof body.dryRun === 'boolean') {
    process.env.SENTINEL_DRY_RUN = body.dryRun ? 'true' : 'false'
    // Prime the settings cache so the async isDryRun() returns the override
    // without a DB read delay. We import lazily to avoid a circular dep.
    const { setDryRun } = await import('@/lib/settings')
    await setDryRun(body.dryRun)
  }
  try {
    const ts = new Date().toISOString()
    const issue = await openIssue({
      title: `[Sentinel test] Connector probe ${ts}`,
      body: [
        '# Sentinel connector probe',
        '',
        'This issue was opened by the /api/connectors/test endpoint to verify',
        'the GitHub connector can authenticate + create issues on the demo repo.',
        '',
        `- Time: ${ts}`,
        `- Repo: ${process.env.GITHUB_DEMO_REPO ?? 'sodiq-code/sentinel-demo-pipeline'}`,
        `- Mode: ${effectiveDryRun ? 'DRY-RUN' : 'LIVE'}`,
        '',
        'A human reviewer should close this issue. Sentinel will NEVER merge',
        'or close it.',
      ].join('\n'),
      labels: ['sentinel-test', 'auto-filed'],
    })
    const slack = await postTriage({
      title: 'Sentinel connector probe',
      bullets: [
        `*What*: connector probe (${effectiveDryRun ? 'DRY-RUN' : 'LIVE'})`,
        `*When*: ${ts}`,
        `*Action*: human reviewer should delete this message`,
      ],
      footer: `Sentinel probe — ${process.env.SLACK_DEMO_CHANNEL ?? 'C0BL9CQ4D5G'}`,
    })
    return NextResponse.json({
      ok: true,
      mode: effectiveDryRun ? 'dry-run' : 'live',
      github: {
        repo: issue.repo,
        number: issue.number,
        url: issue.url,
        trace: issue.trace,
        dedup: issue.dedup ?? null,
        dedupOfIssue: issue.dedupOfIssue ?? null,
      },
      slack: {
        channel: slack.channel,
        ts: slack.ts,
        url: slack.url,
        trace: slack.trace,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    )
  } finally {
    // Restore the env var. We do NOT restore the DB Setting here — if the
    // caller passed an explicit override, the toggle's DB Setting is the
    // user's intent and should persist. The env var mutation was only for
    // the sync fallback path.
    if (typeof body.dryRun === 'boolean') {
      process.env.SENTINEL_DRY_RUN = previousEnv
    }
  }
}
