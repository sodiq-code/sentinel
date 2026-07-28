// =============================================================================
// Sentinel — Vercel Demo Replay fixture generator
//
// Derives the Vercel-safe read-only fixtures from the Phase 7 dry-run trace
// (examples/dry-run/nyc-taxi-freshness.json). All fixtures share the same
// incident URN so the page's after-run + click-incident flows are internally
// consistent.
//
// Run: `bun run scripts/gen-demo-fixtures.ts`
// =============================================================================

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const DRY_RUN = join(process.cwd(), 'examples/dry-run/nyc-taxi-freshness.json')
const OUT_DIR = join(process.cwd(), 'examples/demo-replay')

interface Step {
  step: number
  kind: string
  ts: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: Record<string, unknown>
  reasoning?: string
  usage?: { promptTokens: number; completionTokens: number }
}

interface DryRunFixture {
  incident: {
    urn: string
    status: string
    createdAt: string
    resolvedAt: string
    signal: {
      id: string
      assetUrn: string
      type: string
      status: string
      firedAt: string
    }
  }
  steps: Step[]
  totalTokens: { promptTokens: number; completionTokens: number }
  llmModel: string
  llmProvider: string
  promptVersion: string
  auditMirrorMode: string
}

async function main() {
  const raw = await readFile(DRY_RUN, 'utf8')
  const trace = JSON.parse(raw) as DryRunFixture
  await mkdir(OUT_DIR, { recursive: true })

  const urn = trace.incident.urn
  const steps = trace.steps

  // --- incident-detail.json (hydrateIncident shape) ---
  const reasoningSteps = steps.map((s) => ({
    step: s.step,
    kind: s.kind,
    toolName: s.toolName,
    toolArgs: s.toolArgs,
    toolResult: s.toolResult,
    reasoning: s.reasoning,
    ts: s.ts,
  }))

  const toolCalls = steps
    .filter((s) => s.kind === 'tool_call' && s.toolName)
    .map((s, i) => ({
      id: `tc_dryrun_${i}`,
      tool: s.toolName as string,
      argsJson: JSON.stringify(s.toolArgs ?? {}),
      resultJson: JSON.stringify(s.toolResult ?? {}),
      status: 'ok',
      durationMs: null,
      ts: s.ts,
    }))

  const actions = steps
    .filter((s) => s.kind === 'tool_call' && s.toolName?.startsWith('action.'))
    .map((s, i) => {
      const name = s.toolName as string
      const args = s.toolArgs ?? {}
      const res = (s.toolResult ?? {}) as { url?: string; repo?: string; channel?: string }
      let kind = 'unknown'
      let target = ''
      if (name === 'action.github_open_issue') {
        kind = 'github.openIssue'
        target = (args.repo as string) ?? res.repo ?? ''
      } else if (name === 'action.slack_post_triage') {
        kind = 'slack.postMessage'
        target = (args.channel as string) ?? res.channel ?? ''
      }
      return {
        id: `act_dryrun_${i}`,
        kind,
        target,
        payload: JSON.stringify(args),
        status: 'executed',
        url: res.url ?? null,
        ts: s.ts,
      }
    })

  const writebacks = steps
    .filter((s) => s.kind === 'write_back')
    .map((s, i) => {
      const res = (s.toolResult ?? {}) as { urn?: string; kind?: string; path?: string; status?: string }
      return {
        id: `wb_dryrun_${i}`,
        kind: res.kind ?? 'context_doc',
        datahubUrn: res.urn ?? null,
        status: res.status ?? 'succeeded',
        path: res.path ?? 'agent_context_kit',
        dataJson: JSON.stringify(s.toolArgs ?? {}),
        ts: s.ts,
      }
    })

  // auditEvents — flat list: lifecycle milestones + reasoning steps (page shows count)
  const auditEvents = [
    {
      id: 'ae_dryrun_signal',
      kind: 'signal_received',
      summary: `Signal received: ${trace.incident.signal.type} on ${trace.incident.signal.assetUrn}`,
      ts: trace.incident.signal.firedAt,
    },
    {
      id: 'ae_dryrun_incident_created',
      kind: 'incident_created',
      summary: `Incident created: ${urn}`,
      ts: trace.incident.createdAt,
    },
    ...steps
      .filter((s) => s.kind === 'tool_call')
      .map((s, i) => ({
        id: `ae_dryrun_tc_${i}`,
        kind: 'tool_call',
        summary: `${s.toolName}(${Object.keys(s.toolArgs ?? {}).join(', ')})`,
        ts: s.ts,
      })),
    ...steps
      .filter((s) => s.kind === 'tool_result')
      .map((s, i) => ({
        id: `ae_dryrun_tr_${i}`,
        kind: 'tool_result',
        summary: `${s.toolName} -> ok`,
        ts: s.ts,
      })),
    ...actions.map((a, i) => ({
      id: `ae_dryrun_act_${i}`,
      kind: 'action_executed',
      summary: `${a.kind} -> ${a.target}`,
      ts: a.ts,
    })),
    ...writebacks.map((w, i) => ({
      id: `ae_dryrun_wb_${i}`,
      kind: 'writeback_succeeded',
      summary: `${w.kind} -> ${w.datahubUrn ?? '(no urn)'}`,
      ts: w.ts,
    })),
    {
      id: 'ae_dryrun_resolved',
      kind: 'incident_resolved',
      summary: `Incident resolved in ${steps.length} reasoning steps`,
      ts: trace.incident.resolvedAt,
    },
  ]

  const incidentDetail = {
    incident: {
      urn,
      signal: {
        id: trace.incident.signal.id,
        assertionUrn: `urn:li:assertion:${trace.incident.signal.type}:raw_s3_nyc_taxi_trips:sla`,
        assetUrn: trace.incident.signal.assetUrn,
        type: trace.incident.signal.type,
        status: trace.incident.signal.status,
        firedAt: trace.incident.signal.firedAt,
      },
      status: trace.incident.status,
      createdAt: trace.incident.createdAt,
      resolvedAt: trace.incident.resolvedAt,
      reasoningSteps,
      pendingApprovals: [],
    },
    toolCalls,
    actions,
    writebacks,
    auditEvents,
  }

  // --- audit.json (audit route shape) ---
  const lifecycleKinds = new Set([
    'signal_received',
    'incident_created',
    'action_executed',
    'writeback_succeeded',
    'incident_resolved',
  ])
  const lifecycleEvents = auditEvents.filter((e) => lifecycleKinds.has((e as { kind: string }).kind))
  const audit = {
    incidentUrn: urn,
    mode: 'demo',
    mirroredCount: 3,
    events: auditEvents,
    lifecycleEvents,
    reasoningSteps,
  }

  // --- incidents.json (list shape — one summary) ---
  const incidents = {
    incidents: [
      {
        urn,
        signalType: trace.incident.signal.type,
        assetUrn: trace.incident.signal.assetUrn,
        status: trace.incident.status,
        createdAt: trace.incident.createdAt,
        resolvedAt: trace.incident.resolvedAt,
        stepCount: steps.length,
        toolCallCount: toolCalls.length,
        writebackCount: writebacks.length,
      },
    ],
  }

  // --- connectors-status.json (polished: configured + reachable, sandbox mode) ---
  const connectorsStatus = {
    dryRun: true,
    demoMode: true,
    github: {
      mode: 'sandbox',
      repo: 'sodiq-code/sentinel-demo-pipeline',
      dryRun: true,
      tokenPresent: true,
      reachable: true,
      defaultBranch: 'main',
      error: null,
    },
    slack: {
      mode: 'sandbox',
      channel: 'C0BL9CQ4D5G',
      tokenPresent: true,
      reachable: true,
      botUser: 'sentinel',
      team: 'Build with DataHub',
      error: null,
    },
  }

  // --- llm-status.json (polished: healthy zai + demoMode flag) ---
  const llmStatus = {
    provider: 'zai',
    model: 'gpt-4o',
    failoverEnabled: true,
    hasNvidiaKey: true,
    circuit: { isOpen: false, consecutiveFailures: 0, msUntilReset: 0 },
    demoMode: true,
    note: 'Vercel preview runs in dry-run mode — no live LLM calls. Live agent demo runs on the sandbox link.',
  }

  // --- POST no-op fixtures ---
  const connectorsTest = {
    ok: true,
    demoMode: true,
    mode: 'sandbox',
    github: {
      repo: 'sodiq-code/sentinel-demo-pipeline',
      number: 42,
      url: 'https://github.com/sodiq-code/sentinel-demo-pipeline/issues/42',
      sandbox: true,
    },
    slack: {
      channel: 'C0BL9CQ4D5G',
      ts: '1753685655.000123',
      sandbox: true,
    },
    note: 'Vercel preview — connector test is a no-op replay of the dry-run fixture.',
  }

  // Shape matches /api/agent/writeback POST: { ok, outcome: WriteBackDocumentOutcome }
  const writeback = {
    ok: true,
    demoMode: true,
    outcome: {
      urn: 'urn:li:document:sentinel:postmortem:dryrun:0001',
      kind: 'context_doc',
      path: 'agent_context_kit',
      status: 'succeeded',
      fallback: false,
    },
    note: 'Vercel preview — writeback is a no-op replay of the dry-run fixture.',
  }

  // Shape matches /api/guardrail/pending GET: { approvals }
  const guardrailsPending = { approvals: [], demoMode: true }
  // Shape matches /api/guardrail/approve + deny POST: { decision }
  const decidedAt = trace.incident.resolvedAt
  const guardrailApprove = {
    decision: {
      id: 'demo-approval',
      status: 'approved',
      decidedAt,
      approverUrn: 'urn:li:corpUser:operator.demo',
    },
    demoMode: true,
  }
  const guardrailDeny = {
    decision: {
      id: 'demo-approval',
      status: 'denied',
      decidedAt,
      approverUrn: 'urn:li:corpUser:operator.demo',
    },
    demoMode: true,
  }

  // --- write all fixtures ---
  const writes: Array<[string, unknown]> = [
    ['incident-detail.json', incidentDetail],
    ['audit.json', audit],
    ['incidents.json', incidents],
    ['connectors-status.json', connectorsStatus],
    ['llm-status.json', llmStatus],
    ['connectors-test.json', connectorsTest],
    ['writeback.json', writeback],
    ['guardrail-pending.json', guardrailsPending],
    ['guardrail-approve.json', guardrailApprove],
    ['guardrail-deny.json', guardrailDeny],
  ]
  for (const [name, data] of writes) {
    await writeFile(join(OUT_DIR, name), JSON.stringify(data, null, 2) + '\n', 'utf8')
    const size = Buffer.byteLength(JSON.stringify(data), 'utf8')
    console.log(`  wrote ${name} (${size} bytes)`)
  }
  console.log(`\nGenerated ${writes.length} fixtures in ${OUT_DIR}`)
  console.log(`Incident URN (shared): ${urn}`)
}

main().catch((err) => {
  console.error('Fixture generation failed:', err)
  process.exit(1)
})
