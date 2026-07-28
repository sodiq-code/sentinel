// =============================================================================
// Sentinel — Orchestrator (the ReAct reasoning loop)
//
// PDF §9.3.2 Option A: single orchestrator + tools.
// PDF §9.4.2 incident lifecycle, implemented as a ReAct loop:
//   detect → triage → diagnose → remediate → document → write-back.
// PDF §9.4.4: layered system prompt.
// PDF §9.5.4: retries with exponential backoff on tool failure.
// PDF §5.3: visible reasoning — every step is emitted + recorded.
//
// The loop:
//   1. Create the Incident + SignalRecord in the DB; emit signal_received.
//   2. Build the layered system prompt + tool catalogue + initial user msg.
//   3. while not done (≤ MAX_ITERS):
//        - call the LLM (NVIDIA Nemotron Super 49B; gpt-oss-120b fallback)
//        - if the LLM returned reasoning text, emit a plan/reflect step
//        - if there are no tool_calls and the LLM signalled stop → done
//        - execute each tool_call (structured args, schema-validated),
//          emit tool_call + tool_result steps, append results to the scratchpad
//   4. Post-loop: ensure a post-mortem context doc was written (the compounding
//      artefact, PDF §12.2). If the agent did not call ack.save_document, the
//      orchestrator writes one from the final reflection.
//   5. Mark the incident resolved (or failed) and emit incident_resolved.
// =============================================================================

import { db } from '@/lib/db'
import { getDataHub } from '@/lib/datahub'
import { getLlm, getLlmModel, getLlmProvider } from './llm'
import { assembleSystemPrompt, PROMPT_VERSION } from './prompts/system-prompt'
import {
  buildToolCatalogue,
  executeToolCall,
  toLlmTools,
  type ToolContext,
} from './tools'
import { getAudit } from './audit'
import {
  buildInitialUserMessage,
  buildSignal,
  listSeedSignals,
  type InjectableSignal,
} from './seed-signals'
import type {
  Incident,
  LlmMessage,
  ReasoningStep,
  Signal,
} from './types'

const MAX_ITERS = 12

export interface OrchestratorResult {
  incident: Incident
  steps: ReasoningStep[]
  totalTokens: { promptTokens: number; completionTokens: number }
  llmModel: string
  llmProvider: 'zai' | 'nvidia'
  promptVersion: string
}

export interface RunOptions {
  /** Emitted on every reasoning step (for live SSE in Phase 5). */
  onStep?: (step: ReasoningStep) => void
}

// ---------------------------------------------------------------------------
// Top-level entry: inject a seed signal by id and run the full loop.
// ---------------------------------------------------------------------------

export async function runSentinelOnSeedSignal(
  signalId: string,
  opts: RunOptions = {},
): Promise<OrchestratorResult> {
  const signals = await listSeedSignals()
  const sig = signals.find((s) => s.id === signalId)
  if (!sig) {
    throw new Error(`Unknown seed signal: '${signalId}'. Available: ${signals.map((s) => s.id).join(', ')}`)
  }
  await sig.prime()
  const signal = await buildSignal(sig)
  return runSentinel(signal, sig, opts)
}

// ---------------------------------------------------------------------------
// The loop itself.
// ---------------------------------------------------------------------------

export async function runSentinel(
  signal: Signal,
  sig: InjectableSignal,
  opts: RunOptions = {},
): Promise<OrchestratorResult> {
  const audit = getAudit()
  const llm = getLlm()
  const clients = await getDataHub()
  const dryRun = (process.env.SENTINEL_DRY_RUN ?? 'true').toLowerCase() !== 'false'

  // 1. Persist the Incident + SignalRecord + signal_received audit.
  const incidentUrn = `urn:li:incident:sentinel:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  await db.incident.create({
    data: {
      urn: incidentUrn,
      signalType: signal.type,
      assetUrn: signal.assetUrn,
      status: 'investigating',
      createdAt: new Date(),
    },
  })
  await db.signalRecord.create({
    data: {
      incidentUrn,
      assertionUrn: signal.assertionUrn,
      assetUrn: signal.assetUrn,
      type: signal.type,
      status: signal.status,
      firedAt: new Date(signal.firedAt),
      rawPayload: JSON.stringify(signal.rawPayload ?? {}),
      processed: true,
    },
  })
  await audit.record({
    incidentUrn,
    kind: 'signal_received',
    summary: `Signal received: ${signal.type} on ${signal.assetUrn}`,
    payload: { signal },
  })
  await audit.record({
    incidentUrn,
    kind: 'incident_created',
    summary: `Incident created: ${incidentUrn}`,
    payload: { incidentUrn, signalType: signal.type },
  })

  const ctx: ToolContext = { clients, incidentUrn, dryRun }
  const defs = buildToolCatalogue()
  const ltools = toLlmTools(defs)
  const systemPrompt = assembleSystemPrompt()
  const initialUser = buildInitialUserMessage(sig, signal)

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: initialUser },
  ]

  const steps: ReasoningStep[] = []
  let stepNum = 0
  let totalPromptTokens = 0
  let totalCompletionTokens = 0
  let wrotePostMortem = false
  let finalReflection = ''
  let lastError: string | null = null

  const emit = (kind: ReasoningStep['kind'], partial: Omit<ReasoningStep, 'step' | 'kind' | 'ts'>) => {
    const step: ReasoningStep = {
      step: stepNum++,
      kind,
      ts: new Date().toISOString(),
      ...partial,
    }
    steps.push(step)
    opts.onStep?.(step)
    // Persist to audit (fire-and-forget; the audit table is the durable trace).
    void audit.record({
      incidentUrn,
      kind,
      summary: partial.reasoning ?? partial.toolName ?? kind,
      payload: {
        toolName: partial.toolName,
        toolArgs: partial.toolArgs,
        toolResult: partial.toolResult,
        reasoning: partial.reasoning,
        error: partial.error,
        usage: partial.usage,
      },
    })
  }

  // 2. The ReAct loop.
  //
  // Completion gate (autonomous-agent contract): the workflow defines MANDATORY
  // tool calls — action.github_open_issue, action.slack_post_triage,
  // ack.save_document. The orchestrator refuses a premature 'stop' from the
  // LLM until these have been called (or the agent has been nudged twice, to
  // respect an explicit governance refusal such as PII). This makes the closed
  // loop a contract, not a suggestion — the agent cannot 'summarise and stop'
  // before the write-back (PDF §9.4.2 lifecycle steps 12-14).
  const MANDATORY = ['action.github_open_issue', 'action.slack_post_triage', 'ack.save_document']
  const mandatoryDone = new Set<string>()
  let nudgeCount = 0
  const MAX_NUDGES = 2

  try {
    for (let iter = 0; iter < MAX_ITERS; iter++) {
      const completion = await llm.complete({
        messages,
        tools: ltools,
        temperature: 0,
        maxTokens: 1500,
      })
      if (completion.usage) {
        totalPromptTokens += completion.usage.promptTokens
        totalCompletionTokens += completion.usage.completionTokens
      }

      // Reasoning text → plan or reflect step.
      const hasToolCalls = completion.toolCalls.length > 0
      if (completion.content && completion.content.trim()) {
        const premature = !hasToolCalls && (completion.finishReason === 'stop' || completion.finishReason === 'length')
          && !allMandatoryDone(mandatoryDone, MANDATORY) && nudgeCount < MAX_NUDGES
        const kind: ReasoningStep['kind'] =
          !hasToolCalls && (completion.finishReason === 'stop' || completion.finishReason === 'length') && !premature
            ? 'reflect'
            : 'plan'
        emit(kind, {
          reasoning: completion.content,
          usage: completion.usage,
        })
        if (kind === 'reflect') finalReflection = completion.content
      }

      // Termination conditions.
      if (!hasToolCalls) {
        const isStop = completion.finishReason === 'stop' || completion.finishReason === 'length' || completion.finishReason === 'empty'
        if (isStop) {
          // Completion gate: refuse a premature stop until mandatory tools are
          // called (or the agent has been nudged MAX_NUDGES times — e.g. an
          // explicit PII refusal where stopping IS the correct behaviour).
          if (allMandatoryDone(mandatoryDone, MANDATORY) || nudgeCount >= MAX_NUDGES) {
            break // agent is genuinely done
          }
          const missing = MANDATORY.filter((t) => !mandatoryDone.has(t))
          nudgeCount += 1
          emit('observe', {
            reasoning:
              `Agent attempted to conclude before the mandatory write-back. ` +
              `Still missing: ${missing.join(', ')}. Nudging (attempt ${nudgeCount}/${MAX_NUDGES}) to continue the closed loop.`,
          })
          // Keep the conversation coherent: append the assistant's stop message,
          // then a user nudge demanding the remaining tool calls.
          messages.push({ role: 'assistant', content: completion.content ?? '' })
          messages.push({
            role: 'user',
            content:
              `You stopped before completing the Sentinel closed loop. ` +
              `The following mandatory tool calls are still required (call them now, then give your final summary):
` +
              missing.map((m) => `  - ${m}`).join('\n') +
              (nudgeCount >= MAX_NUDGES
                ? '\n\nIf you are refusing for a governance reason (e.g. a PII tag), state the refusal clearly and stop.'
                : ''),
          })
          continue
        }
        // No tools and not stop — unknown state; break to avoid infinite loop.
        emit('error', { error: `Unexpected finish_reason '${completion.finishReason}' with no tool_calls` })
        break
      }

      // Append the assistant message (with tool_calls) to the scratchpad.
      messages.push({
        role: 'assistant',
        content: completion.content ?? '',
        toolCalls: completion.toolCalls,
      })

      // Execute each tool call in order; append results to the scratchpad.
      for (const call of completion.toolCalls) {
        const effectiveName = call.function.name
        emit('tool_call', {
          toolName: effectiveName,
          toolArgs: safeParseArgs(call.function.arguments),
        })
        const exec = await executeToolCall(call, defs, ctx)
        emit('tool_result', {
          toolName: effectiveName,
          toolResult: exec.result,
          error: exec.status === 'error' ? exec.error : undefined,
        })
        if (exec.status === 'ok' && MANDATORY.includes(effectiveName)) {
          mandatoryDone.add(effectiveName)
        }
        if (effectiveName === 'ack.save_document' && exec.status === 'ok') {
          wrotePostMortem = true
        }
        // Append the tool result back into the LLM conversation.
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: effectiveName,
          content: JSON.stringify(exec.result),
        })
      }
    }
  } catch (err) {
    lastError = (err as Error).message ?? String(err)
    emit('error', { error: lastError })
  }

  // 3. Post-loop: guarantee a post-mortem context doc (the compounding artefact).
  if (!wrotePostMortem) {
    try {
      const me = await clients.mcp.get_me()
      const postMortemContent = buildFallbackPostMortem(sig, signal, steps, finalReflection, lastError)
      const res = await clients.contextKit.save_document({
        assetUrn: signal.assetUrn,
        title: `Sentinel Post-Mortem — ${sig.assetName} — ${signal.type}`,
        content: postMortemContent,
        format: 'markdown',
        authorUrn: me.urn,
        sentinelPostMortem: true,
      })
      await db.writeBack.create({
        data: {
          incidentUrn,
          kind: 'context_doc',
          datahubUrn: res.urn,
          status: 'succeeded',
          path: 'agent_context_kit',
          dataJson: JSON.stringify({ title: `Sentinel Post-Mortem — ${sig.assetName}` }),
          ts: new Date(),
        },
      })
      emit('write_back', {
        toolName: 'ack.save_document',
        toolArgs: { assetUrn: signal.assetUrn, sentinelPostMortem: true },
        toolResult: { urn: res.urn, kind: 'context_doc', fallback: true },
        reasoning: 'Orchestrator wrote a fallback post-mortem (agent did not call ack.save_document).',
      })
    } catch (err) {
      emit('error', { error: `Fallback post-mortem write failed: ${(err as Error).message}` })
    }
  }

  // 4. Resolve the incident.
  const failed = Boolean(lastError)
  const resolvedAt = new Date()
  await db.incident.update({
    where: { urn: incidentUrn },
    data: { status: failed ? 'failed' : 'resolved', resolvedAt },
  })
  await audit.record({
    incidentUrn,
    kind: failed ? 'incident_failed' : 'incident_resolved',
    summary: failed
      ? `Incident failed: ${lastError}`
      : `Incident resolved in ${steps.length} reasoning steps`,
    payload: { steps: steps.length, totalPromptTokens, totalCompletionTokens },
  })

  const incident: Incident = {
    urn: incidentUrn,
    signal,
    status: failed ? 'failed' : 'resolved',
    createdAt: steps[0]?.ts ?? resolvedAt.toISOString(),
    resolvedAt: resolvedAt.toISOString(),
    reasoningSteps: steps,
    pendingApprovals: [],
  }

  return {
    incident,
    steps,
    totalTokens: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
    llmModel: getLlmModel(),
    llmProvider: getLlmProvider(),
    promptVersion: PROMPT_VERSION,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    return { __raw: raw }
  }
}

/** True when every mandatory tool has been successfully called. */
function allMandatoryDone(done: Set<string>, mandatory: string[]): boolean {
  return mandatory.every((m) => done.has(m))
}

function buildFallbackPostMortem(
  sig: InjectableSignal,
  signal: Signal,
  steps: ReasoningStep[],
  finalReflection: string,
  lastError: string | null,
): string {
  const lines: string[] = [
    `# Sentinel Post-Mortem — ${sig.assetName} — ${signal.type}`,
    '',
    '> Auto-generated by the Sentinel orchestrator because the agent did not call `ack.save_document`.',
    '',
    `**Signal**: ${signal.assertionUrn}  `,
    `**Type**: ${signal.type}  `,
    `**Status**: ${signal.status}  `,
    `**Fired at**: ${signal.firedAt}  `,
    `**Failure reason**: ${sig.failureReason ?? '(none)'}`,
    '',
    '## Reasoning trace',
    '',
    ...steps.map((s, i) => `- **Step ${i}** (${s.kind})${s.toolName ? ` ${s.toolName}` : ''}: ${(s.reasoning ?? JSON.stringify(s.toolResult ?? s.error ?? '')).slice(0, 240)}`),
    '',
    '## Final reflection',
    '',
    finalReflection || '(agent produced no final reflection)',
    '',
  ]
  if (lastError) {
    lines.push('## Error', '', `**${lastError}**`, '')
  }
  lines.push('## Compounding', '', 'This post-mortem is now part of the asset context. The next incident on this asset should cite it.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Read-only view for the API: hydrate a full incident (with reconstructed
// reasoning trace) from the DB. Used by GET /api/agent/incident/[urn].
// ---------------------------------------------------------------------------

export async function hydrateIncident(incidentUrn: string): Promise<{
  incident: Incident
  toolCalls: Array<{ id: string; tool: string; argsJson: string; resultJson: string | null; status: string; durationMs: number | null; ts: string }>
  actions: Array<{ id: string; kind: string; target: string; payload: string; status: string; url: string | null; ts: string }>
  writebacks: Array<{ id: string; kind: string; datahubUrn: string | null; status: string; path: string; dataJson: string; ts: string }>
  auditEvents: Array<{ id: string; kind: string; summary: string; ts: string }>
} | null> {
  const row = await db.incident.findUnique({ where: { urn: incidentUrn } })
  if (!row) return null
  const [signal, toolCalls, actions, writebacks, auditEvents] = await Promise.all([
    db.signalRecord.findFirst({ where: { incidentUrn } }),
    db.toolCall.findMany({ where: { incidentUrn }, orderBy: { ts: 'asc' } }),
    db.action.findMany({ where: { incidentUrn }, orderBy: { ts: 'asc' } }),
    db.writeBack.findMany({ where: { incidentUrn }, orderBy: { ts: 'asc' } }),
    db.auditEvent.findMany({ where: { incidentUrn }, orderBy: { ts: 'asc' } }),
  ])
  // Reconstruct reasoning steps from audit events (plan/tool_call/tool_result/reflect/write_back/error).
  const stepKinds = new Set(['plan', 'tool_call', 'tool_result', 'observe', 'reflect', 'write_back', 'error'])
  const reasoningSteps: ReasoningStep[] = auditEvents
    .filter((e) => stepKinds.has(e.kind))
    .map((e, i) => {
      const p = e.payloadJson ? (JSON.parse(e.payloadJson) as Record<string, unknown>) : {}
      return {
        step: i,
        kind: e.kind as ReasoningStep['kind'],
        toolName: p.toolName as string | undefined,
        toolArgs: p.toolArgs as Record<string, unknown> | undefined,
        toolResult: p.toolResult,
        reasoning: p.reasoning as string | undefined,
        error: p.error as string | undefined,
        ts: e.ts.toISOString(),
      }
    })
  const incident: Incident = {
    urn: row.urn,
    signal: {
      id: signal?.id ?? row.urn,
      assertionUrn: signal?.assertionUrn ?? '',
      assetUrn: row.assetUrn,
      type: row.signalType as Signal['type'],
      status: signal?.status ?? 'failing',
      firedAt: signal?.firedAt.toISOString() ?? row.createdAt.toISOString(),
    },
    status: row.status as Incident['status'],
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString(),
    reasoningSteps,
    pendingApprovals: [],
  }
  return {
    incident,
    toolCalls: toolCalls.map((t) => ({
      id: t.id,
      tool: t.tool,
      argsJson: t.argsJson,
      resultJson: t.resultJson,
      status: t.status,
      durationMs: t.durationMs,
      ts: t.ts.toISOString(),
    })),
    actions: actions.map((a) => ({
      id: a.id,
      kind: a.kind,
      target: a.target,
      payload: a.payload,
      status: a.status,
      url: a.url,
      ts: a.ts.toISOString(),
    })),
    writebacks: writebacks.map((w) => ({
      id: w.id,
      kind: w.kind,
      datahubUrn: w.datahubUrn,
      status: w.status,
      path: w.path,
      dataJson: w.dataJson,
      ts: w.ts.toISOString(),
    })),
    auditEvents: auditEvents.map((e) => ({
      id: e.id,
      kind: e.kind,
      summary: e.summary,
      ts: e.ts.toISOString(),
    })),
  }
}

export async function listIncidents(limit = 20): Promise<Array<{
  urn: string
  signalType: string
  assetUrn: string
  status: string
  createdAt: string
  resolvedAt: string | null
  stepCount: number
  toolCallCount: number
  writebackCount: number
}>> {
  const rows = await db.incident.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  const urns = rows.map((r) => r.urn)
  const [auditCounts, toolCounts, writebackCounts] = await Promise.all([
    db.auditEvent.groupBy({ by: ['incidentUrn'], where: { incidentUrn: { in: urns } }, _count: { _all: true } }),
    db.toolCall.groupBy({ by: ['incidentUrn'], where: { incidentUrn: { in: urns } }, _count: { _all: true } }),
    db.writeBack.groupBy({ by: ['incidentUrn'], where: { incidentUrn: { in: urns } }, _count: { _all: true } }),
  ])
  const auditMap = new Map(auditCounts.map((a) => [a.incidentUrn, a._count._all]))
  const toolMap = new Map(toolCounts.map((a) => [a.incidentUrn, a._count._all]))
  const wbMap = new Map(writebackCounts.map((a) => [a.incidentUrn, a._count._all]))
  return rows.map((r) => ({
    urn: r.urn,
    signalType: r.signalType,
    assetUrn: r.assetUrn,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    stepCount: auditMap.get(r.urn) ?? 0,
    toolCallCount: toolMap.get(r.urn) ?? 0,
    writebackCount: wbMap.get(r.urn) ?? 0,
  }))
}
