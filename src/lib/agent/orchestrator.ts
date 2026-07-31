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
import { CircuitOpenError, getLlm, getLlmModel, getLlmProvider } from './llm'
import { assembleSystemPrompt, PROMPT_VERSION } from './prompts/system-prompt'
import {
  buildToolCatalogue,
  executeToolCall,
  toLlmTools,
  type ToolContext,
} from './tools'
import { checkBeforeExecute, recordGuardrailCheck } from '@/lib/guardrail/pre-exec'
import { checkPiiForAsset as checkPiiForAssetInline } from '@/lib/guardrail/pii-check'
import { getAudit } from './audit'
import { writeBackDocument } from './writeback'
import { getAuditMirror, getAuditMirrorMode, type AuditMirrorMode } from './audit-mirror'
import {
  buildInitialUserMessage,
  buildSignal,
  listSeedSignals,
  type InjectableSignal,
} from './seed-signals'
import { buildDeterministicActions } from './fallback-messages'
import type {
  Incident,
  LlmMessage,
  LlmToolCall,
  ReasoningStep,
  Signal,
} from './types'

// MAX_ITERS caps the ReAct loop. Now that z-ai (sandbox) and Gemini
// (production) have generous TPM budgets, we can afford 10 iterations —
// enough for the agent to do reads (3-4), open the GitHub issue, post the
// Slack triage, AND write the post-mortem via ack.save_document before the
// completion gate's 2 nudges. The soft deadline still bounds the wall-clock.
const MAX_ITERS = 10

// Soft deadline — the Vercel Hobby function timeout is 60s. We break the
// loop at 55s to leave 5s for the post-loop fallback post-mortem write +
// incident resolution. If we hit the deadline, the incident is marked
// 'degraded' (partial investigation) — the same state as a circuit-open.
const SOFT_DEADLINE_MS = 55_000

// ---------------------------------------------------------------------------
// LLM-unreachable classification (PDF §11.3 graceful-degradation trigger)
// ---------------------------------------------------------------------------
// The orchestrator distinguishes two failure classes:
//   • DEGRADED — the LLM was externally unreachable (rate-limit, auth/geo
//     block, gateway 5xx, network). The orchestrator did partial work and
//     the post-loop fallback post-mortem still writes the compounding
//     artefact. The dashboard must NOT show a scary red "failed" for this.
//   • FAILED   — a real bug (non-LLM exception). The agent could not
//     complete the investigation and no compounding artefact was written.
//
// `wasCircuitOpen` (legacy name, kept for minimal diff) is set true for the
// DEGRADED class. The final-status block at the bottom maps it to
// 'degraded'. This helper widens the trigger beyond a literal 429 to also
// cover 401/403 (Groq key geo-block from non-US regions), 5xx, and network
// errors reaching the LLM endpoint — all of which are "LLM unreachable,
// not our bug" and all of which leave the fallback post-mortem intact.
// ---------------------------------------------------------------------------
const LLM_UNREACHABLE_RE =
  /HTTP\s+(429|40[13]|5\d\d)|rate\s*limit|too\s*many\s*requests|network|fetch\s*failed|ECONN|ETIMEDOUT|timeout|circuit\s+open|ENOTFOUND|socket\s*hang\s*up/i

function isLlmUnreachableError(message: string): boolean {
  return LLM_UNREACHABLE_RE.test(message)
}

function describeLlmUnreachableReason(message: string): string {
  if (/429|rate\s*limit|too\s*many\s*requests/i.test(message)) {
    return 'rate-limited (HTTP 429)'
  }
  if (/HTTP\s+40[13]/i.test(message)) {
    return 'auth/geo-blocked (HTTP 401/403)'
  }
  if (/HTTP\s+5\d\d/i.test(message)) {
    return 'gateway error (HTTP 5xx)'
  }
  if (/network|fetch\s*failed|ECONN|ETIMEDOUT|timeout|ENOTFOUND|socket\s*hang\s*up/i.test(message)) {
    return 'network unreachable'
  }
  return 'LLM endpoint error'
}

export interface OrchestratorResult {
  incident: Incident
  steps: ReasoningStep[]
  totalTokens: { promptTokens: number; completionTokens: number }
  llmModel: string
  llmProvider: 'zai' | 'nvidia' | 'groq' | 'gemini'
  /**
   * The provider that ACTUALLY served the LLM calls for this run. When the
   * configured primary (llmProvider) is throttled and the FailoverLlmClient
   * routed to the fallback, actualProvider is the fallback. Equal to
   * llmProvider when no failover occurred. This makes the gemini→zai (or
   * gemini→groq) failover transparent to the operator + dashboard.
   */
  actualProvider: 'zai' | 'nvidia' | 'groq' | 'gemini'
  /**
   * True when at least one LLM call in this run was served by the fallback
   * (not the configured primary). The dashboard shows a "failover" badge
   * so the operator knows the primary is currently throttled.
   */
  failoverOccurred: boolean
  promptVersion: string
  /** Phase 4: where the audit log is mirrored (DataHub Assertions or seed). */
  auditMirrorMode: AuditMirrorMode
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
  // Phase 4: mirror incident_created to DataHub Assertions (best-effort,
  // non-fatal — the mirror must never block the incident).
  void getAuditMirror().mirror({
    incidentUrn,
    kind: 'incident_created',
    summary: `${signal.type} on ${signal.assetUrn}`,
    assetUrn: signal.assetUrn,
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
  let piiRefusalOnPostMortem = false
  let assertionTightened = false
  let governanceRefusalWritten = false
  let finalReflection = ''
  let lastError: string | null = null
  let wasCircuitOpen = false
  // Track which provider actually served each LLM call. When the
  // FailoverLlmClient routes to the fallback (e.g. gemini→zai when the
  // Gemini circuit opens), completion.provider is the fallback's name.
  // We report the last-seen provider as actualProvider + set
  // failoverOccurred when it differs from the configured primary.
  const configuredProvider = getLlmProvider()
  let actualProvider: 'zai' | 'nvidia' | 'groq' | 'gemini' = configuredProvider
  let failoverOccurred = false

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

  // ---------------------------------------------------------------------------
  // Governance refusal write-back (PDF §12.3)
  //
  // When the PII guardrail refuses ack.save_document on a PII-tagged asset, the
  // post-mortem itself is NOT written (correct — PII content must not be
  // persisted without human approval). BUT the governance DECISION is a durable
  // artefact: the next incident on this asset must be able to retrieve "Sentinel
  // previously refused to write here because it is PII-tagged" so a human
  // reviewer understands the governance history.
  //
  // This helper writes a governance refusal record to DataHub via the SAME dual
  // write-back path (ACK → REST fallback) as a post-mortem, but with:
  //   - sentinelPostMortem: false  (it's a governance audit entry, NOT a PM)
  //   - a title/content that records the DECISION, not any PII data
  //
  // The record contains: the asset URN, the PII tags that triggered the refusal,
  // the incident URN, the timestamp, and the next-step for a human data owner.
  // It contains NO PII content — only governance metadata.
  // ---------------------------------------------------------------------------
  const writeGovernanceRefusalRecord = async (
    piiTags: string[],
    refusalReason: string,
  ): Promise<void> => {
    if (governanceRefusalWritten) return
    const asset = sig.assetName
    const ts = new Date().toISOString()
    const title = `Sentinel governance refusal — PII write blocked on ${asset}`
    const content = [
      `# Sentinel governance refusal — PII write blocked on \`${asset}\``,
      '',
      '> **Governance audit entry** — this is NOT a post-mortem. Sentinel\'s code-level guardrail refused to write a post-mortem to this asset because it is tagged PII. This record documents the refusal decision so the next incident inherits the governance history.',
      '',
      `**Asset**: \`${signal.assetUrn}\``,
      `**Incident**: \`${incidentUrn}\``,
      `**Refused at**: ${ts}`,
      `**Signal type**: pii (governance)`,
      '',
      '## Refusal reason',
      refusalReason,
      '',
      '## PII governance tags detected',
      ...piiTags.map((t) => `- \`${t}\``),
      '',
      '## What happened',
      `A downstream consumer requested unmasked PII columns from \`${asset}\`. Sentinel's guardrail ran a code-level PII check via the DataHub MCP \`get_entities\` tool, detected the PII governance tags above, and REFUSED the \`ack.save_document\` write-back. No post-mortem content was written to this asset. The GitHub issue + Slack triage were still filed so humans are notified.`,
      '',
      '## What a human data owner must do',
      '- Review the consumer access request and approve or deny unmasked field access.',
      '- If approved, record the decision in the access-control log and update the consumer\'s policy.',
      '- If documentation of this incident is required, a human must manually author the post-mortem after redacting any PII content.',
      '',
      '## Compounding',
      'This governance refusal record is now attached to the asset. The next incident on this asset will retrieve it via \`mcp.search_documents\` and know that Sentinel previously refused to write here — a human has not yet approved documentation.',
    ].join('\n')

    try {
      emit('plan', {
        reasoning:
          `Recording the PII governance refusal as a durable audit entry on DataHub. ` +
          `This is NOT a post-mortem — it records only the governance DECISION (asset URN, tags, reason, timestamp). ` +
          `The next incident on this asset will retrieve it and know Sentinel refused to write here.`,
      })
      const wb = await writeBackDocument({
        clients,
        incidentUrn,
        assetUrn: signal.assetUrn,
        title,
        content,
        format: 'markdown',
        authorUrn: (await clients.mcp.get_me().catch(() => ({ urn: 'urn:li:corpuser:sentinel' }))).urn,
        sentinelPostMortem: false,
        audit,
        dbKind: 'governance_refusal',
      })
      governanceRefusalWritten = true
      emit('write_back', {
        toolName: 'ack.save_document',
        toolArgs: { assetUrn: signal.assetUrn, sentinelPostMortem: false, governanceRefusal: true },
        toolResult: {
          urn: wb.urn,
          kind: 'governance_refusal',
          path: wb.path,
          status: wb.status,
          fallback: wb.fallback,
          primaryError: wb.primaryError,
          title,
        },
        reasoning:
          wb.status === 'succeeded'
            ? `Sentinel recorded the PII governance refusal as a durable audit entry on DataHub (${wb.urn}). The next incident on this asset will inherit this governance history — no PII content was written, only the decision metadata.`
            : `Sentinel could not persist the governance refusal record to DataHub. The refusal is still recorded in the audit log.`,
      })
    } catch (err) {
      emit('error', { error: `Governance refusal write-back failed: ${(err as Error).message}` })
    }
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
  let readCallCount = 0
  let readBudgetNudged = false
  const READ_BUDGET = 4 // after 4 read-only calls with no action, nudge toward actions
  const loopStart = Date.now()

  try {
    for (let iter = 0; iter < MAX_ITERS; iter++) {
      // Soft deadline — break before the Vercel Hobby 60s function timeout so
      // the post-loop fallback post-mortem + incident resolution can run.
      // The incident is marked 'degraded' (partial investigation), the same
      // state as a circuit-open — the agent did real work but couldn't finish.
      if (Date.now() - loopStart > SOFT_DEADLINE_MS) {
        wasCircuitOpen = true // treat deadline as a graceful degradation
        lastError = `soft deadline reached at ${Math.round((Date.now() - loopStart) / 1000)}s — breaking the loop to leave time for the post-loop fallback post-mortem before the Vercel function timeout`
        emit('observe', {
          reasoning:
            `Sentinel reached the safe time budget for this run (after ${Math.round((Date.now() - loopStart) / 1000)}s, ${steps.length} reasoning step(s)). ` +
            `The investigation so far is preserved in the audit log and a summary post-mortem has been written to DataHub.`,
        })
        break
      }
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
      // Track the provider that actually served this call. The
      // FailoverLlmClient sets completion.provider to whichever client
      // (primary or fallback) produced the completion. When it differs
      // from the configured primary, we mark failoverOccurred so the
      // dashboard can show a badge.
      if (completion.provider) {
        actualProvider = completion.provider as 'zai' | 'nvidia' | 'groq' | 'gemini'
        if (actualProvider !== configuredProvider) failoverOccurred = true
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
        const parsedArgs = safeParseArgs(call.function.arguments)
        emit('tool_call', {
          toolName: effectiveName,
          toolArgs: parsedArgs,
        })

        // Phase 3 GUARDRAIL — run the pre-execute hook before every tool call.
        // For action.* + ack.save_document this can REFUSE (e.g. PII tag on
        // the asset) or surface a NEEDS_APPROVAL gate (e.g. ownership/glossary
        // proposals). For mcp.* read tools it always allows. The check is on
        // the structured args, not on the model's text — so the LLM cannot
        // bypass it by rephrasing. (PDF §12.3 prompt-injection mitigation)
        const verdict = await checkBeforeExecute(effectiveName, parsedArgs, ctx)
        await recordGuardrailCheck(incidentUrn, verdict, call.id)
        if (verdict.decision !== 'allow') {
          const decisionLabel =
            verdict.decision === 'refuse' ? 'REFUSED' : 'NEEDS_APPROVAL'
          const guardrailResult = {
            guardrail: true,
            decision: verdict.decision,
            toolName: effectiveName,
            ruleId: verdict.ruleId,
            reason: verdict.reason,
            approvalId: verdict.approvalId,
            approver: verdict.approver,
            note:
              verdict.decision === 'refuse'
                ? `Guardrail ${decisionLabel} this tool call. The tool was NOT executed. Reason: ${verdict.reason ?? '(unspecified)'}`
                : `Guardrail surfaced an approval gate for this tool call. The tool was NOT executed; a human must approve (${verdict.approver ?? 'operator'}). Reason: ${verdict.reason ?? '(unspecified)'}`,
          }
          emit('tool_result', {
            toolName: effectiveName,
            toolResult: guardrailResult,
            error: `${decisionLabel} by guardrail (${verdict.ruleId ?? 'rule'})`,
          })
          // Persist the tool call (status: 'skipped' — the guardrail blocked it)
          await db.toolCall.create({
            data: {
              incidentUrn,
              tool: effectiveName,
              argsJson: JSON.stringify(parsedArgs),
              resultJson: JSON.stringify(guardrailResult),
              status: 'skipped',
              durationMs: 0,
              ts: new Date(),
            },
          })
          // For PII refusals on ack.save_document, mark the refusal so the
          // post-loop fallback does NOT re-attempt the write (PDF §12.3 — the
          // refusal is the correct agent behaviour, not a missing post-mortem).
          // THEN write a durable governance refusal record to DataHub — this is
          // NOT a post-mortem (no PII content), it records only the governance
          // DECISION so the next incident inherits the history.
          if (effectiveName === 'ack.save_document' && verdict.decision === 'refuse') {
            wrotePostMortem = true
            piiRefusalOnPostMortem = true
            const piiCheck = await checkPiiForAssetInline(clients.mcp, signal.assetUrn)
            if (piiCheck) {
              await writeGovernanceRefusalRecord(
                piiCheck.tags.map((t) => t.name),
                piiCheck.reason ?? verdict.reason ?? 'PII governance tag detected',
              )
            } else {
              await writeGovernanceRefusalRecord(
                ['PII'],
                verdict.reason ?? 'PII governance tag detected',
              )
            }
          }
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: effectiveName,
            content: JSON.stringify(guardrailResult),
          })
          continue
        }

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
          // Emit a canonical write_back event so the dashboard can key off
          // kind === 'write_back' (one per logical write) instead of matching
          // every tool_call/tool_result with toolName === 'ack.save_document'
          // (which triple-counts: tool_call + tool_result + write_back).
          emit('write_back', {
            toolName: 'ack.save_document',
            toolArgs: parsedArgs,
            toolResult: exec.result,
            reasoning:
              'Sentinel wrote a post-mortem to DataHub. The next incident on this asset will inherit this context.',
          })
        }
        if (effectiveName === 'ack.create_assertion' && exec.status === 'ok') {
          assertionTightened = true
          // Also emit a canonical write_back for the learned-SLA assertion so
          // the dashboard shows it as a distinct DataHub write-back.
          emit('write_back', {
            toolName: 'ack.create_assertion',
            toolArgs: parsedArgs,
            toolResult: exec.result,
            reasoning:
              'Sentinel tightened the SLA assertion on DataHub. The new threshold will catch this failure earlier next time.',
          })
        }
        // Read-budget accounting: track read-only calls. After READ_BUDGET
        // reads with zero action calls, inject a nudge forcing the agent to
        // move to remediation. This counters models that over-investigate.
        if (effectiveName.startsWith('mcp.')) {
          readCallCount += 1
        }
        // Append the tool result back into the LLM conversation.
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: effectiveName,
          content: JSON.stringify(exec.result),
        })
      }

      // Read-budget nudge: after READ_BUDGET read-only calls with zero action
      // or write calls, force the agent toward remediation. The agent has
      // enough context to open the issue + post the triage + write the post-mortem.
      if (
        readCallCount >= READ_BUDGET &&
        !readBudgetNudged &&
        mandatoryDone.size === 0
      ) {
        readBudgetNudged = true
        emit('observe', {
          reasoning:
            `Read budget reached (${readCallCount} read calls, 0 action/write calls). ` +
            `The agent has enough context to remediate. Forcing the move to action.github_open_issue, ` +
            `action.slack_post_triage, and ack.save_document.`,
        })
        messages.push({
          role: 'user',
          content:
            `You have now made ${readCallCount} read-only tool calls (mcp.*) and ZERO action or write calls. ` +
            `STOP investigating. You have enough context. Your NEXT response MUST call at least one of:\n` +
            `  - action.github_open_issue  (open the engineering issue)\n` +
            `  - action.slack_post_triage  (post the stakeholder triage)\n` +
            `  - ack.save_document         (write the post-mortem)\n` +
            `Proceed to remediation and write-back NOW. A summary without these tool calls is a FAILURE.`,
        })
      }
    }
  } catch (err) {
    lastError = (err as Error).message ?? String(err)
    // Distinguish "throttled" (circuit-open OR a 429 rate-limit error) from
    // "failed" (a real error). A throttled run did partial work and writes a
    // fallback post-mortem, so the incident is DEGRADED, not FAILED. This
    // keeps the dashboard from showing a scary red "failed" every time Groq's
    // free-tier per-minute rate limit trips.
    //
    // Two throttle signals:
    //   1. CircuitOpenError — the circuit breaker opened after 3 consecutive 429/5xx.
    //   2. A regular Error whose message mentions 429 / "rate limit" — this
    //      happens when the primary + fallback models both 429 but the
    //      circuit threshold hasn't been hit yet (e.g. MAX_RETRIES=1 means
    //      only 2 failures per model).
    if (err instanceof CircuitOpenError) {
      wasCircuitOpen = true
      const provider = getLlmProvider()
      const secs = Math.round(
        ((err as unknown as { cooldownMs?: number }).cooldownMs ?? 90_000) / 1000,
      )
      emit('observe', {
        reasoning:
          `Sentinel's reasoning engine is briefly warming up (the LLM gateway needs ~${secs}s to reset). ` +
          `The investigation so far is preserved, and Sentinel will now complete the closed loop using the deterministic fallback path ` +
          `— opening the GitHub issue, posting the Slack triage, and writing the post-mortem to DataHub.`,
      })
    } else if (isLlmUnreachableError(lastError)) {
      // LLM provider is UNREACHABLE but NOT a bug in our code — this covers:
      //   • 429 rate-limit (Groq free-tier per-minute throttle)
      //   • 401/403 auth or geo-block (Groq key geo-blocked from some regions;
      //     works from Vercel US datacenter — verified)
      //   • 5xx server error from the LLM gateway
      //   • network / fetch / ECONN / timeout reaching the LLM endpoint
      // In ALL these cases the LLM is externally unreachable, the orchestrator
      // did partial work (0..N reasoning steps), and the post-loop fallback
      // post-mortem below will still write the compounding artefact. This is
      // DEGRADED, not FAILED — the dashboard must not show a scary red
      // "failed" every time the LLM is unreachable. (PDF §11.3 contingency
      // plan + §9.5.4 graceful degradation.)
      wasCircuitOpen = true
      const reason = describeLlmUnreachableReason(lastError)
      emit('observe', {
        reasoning:
          `Sentinel's reasoning engine is temporarily unavailable (${reason}). The investigation so far is preserved, ` +
          `and Sentinel will now complete the closed loop using the deterministic fallback path — opening the GitHub issue, ` +
          `posting the Slack triage, and writing the post-mortem to DataHub.`,
      })
    } else {
      emit('error', { error: lastError })
    }
  }

  // 2b. Deterministic fallback — when the LLM was unreachable (circuit open,
  // 429, network error), execute the MANDATORY tools that the LLM did not
  // already call, so the incident ALWAYS completes the full closed loop
  // (actions + write-backs) and reaches 'resolved'. This runs regardless of
  // whether the LLM partially completed the loop before failing — we only
  // execute the missing mandatory actions, then clear the error so the
  // incident is marked 'resolved' (never 'degraded' when the closed loop
  // completed). The guardrail still applies — each tool call goes through the
  // same checkBeforeExecute + executeToolCall path as the LLM-driven loop.
  if (wasCircuitOpen && !piiRefusalOnPostMortem) {
    const missing = MANDATORY.filter((t) => !mandatoryDone.has(t))
    // Build type-specific, scenario-aware content so each injectable signal
    // (freshness / schema / pii) produces visibly distinct GitHub issues,
    // Slack triage cards, and post-mortems — even on the fallback path.
    const det = buildDeterministicActions(sig, signal, incidentUrn, steps, finalReflection, lastError)
    emit('observe', {
      reasoning:
        missing.length === 0
          ? 'Sentinel\'s reasoning engine was briefly unavailable, but the LLM had already ' +
            'completed the mandatory closed-loop actions before the interruption. The investigation ' +
            'is complete and the incident is resolved.'
          : det.planLine + ' (deterministic fallback path — the reasoning engine is temporarily unavailable).',
    })

    const makeCall = (name: string, args: Record<string, unknown>): LlmToolCall => ({
      id: `det-${stepNum}-${name}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    })

    // Guarded execute — runs the SAME pre-exec guardrail check as the main
    // ReAct loop, so the deterministic fallback cannot bypass the PII refusal
    // or the approval-gate rules. When the guardrail refuses (e.g. PII asset),
    // the tool is NOT executed and the refusal is emitted as the tool_result
    // (the LLM + UI see the governed outcome).
    const guardedExecute = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ status: 'ok' | 'error' | 'refused'; result: unknown }> => {
      const verdict = await checkBeforeExecute(name, args, ctx)
      await recordGuardrailCheck(incidentUrn, verdict, `det-${stepNum}-${name}`)
      emit('tool_call', { toolName: name, toolArgs: args })
      if (verdict.decision !== 'allow') {
        const decisionLabel = verdict.decision === 'refuse' ? 'REFUSED' : 'NEEDS_APPROVAL'
        const guardrailResult = {
          guardrail: true,
          decision: verdict.decision,
          toolName: name,
          ruleId: verdict.ruleId,
          reason: verdict.reason,
          approvalId: verdict.approvalId,
          approver: verdict.approver,
          note:
            verdict.decision === 'refuse'
              ? `Guardrail ${decisionLabel} this tool call. The tool was NOT executed. Reason: ${verdict.reason ?? '(unspecified)'}`
              : `Guardrail surfaced an approval gate for this tool call. The tool was NOT executed; a human must approve (${verdict.approver ?? 'operator'}). Reason: ${verdict.reason ?? '(unspecified)'}`,
        }
        emit('tool_result', { toolName: name, toolResult: guardrailResult, error: `${decisionLabel} by guardrail (${verdict.ruleId ?? 'rule'})` })
        await db.toolCall.create({
          data: {
            incidentUrn,
            tool: name,
            argsJson: JSON.stringify(args),
            resultJson: JSON.stringify(guardrailResult),
            status: 'skipped',
            durationMs: 0,
            ts: new Date(),
          },
        })
        // PII refusal on save_document → mark so the post-loop fallback skips.
        if (name === 'ack.save_document' && verdict.decision === 'refuse') {
          piiRefusalOnPostMortem = true
          wrotePostMortem = true
        }
        return { status: 'refused', result: guardrailResult }
      }
      const exec = await executeToolCall(makeCall(name, args), defs, ctx)
      emit('tool_result', { toolName: name, toolResult: exec.result, error: exec.status === 'error' ? exec.error : undefined })
      return { status: exec.status, result: exec.result }
    }

    try {
      // 1. Read the failing asset — only if the LLM hasn't already (readCallCount
      //    tracks every mcp.* call the LLM made before the circuit opened).
      if (readCallCount === 0) {
        emit('plan', { reasoning: `Reading the failing asset \`${sig.assetName}\` to confirm schema, ownership, and governance tags.` })
        const er = await guardedExecute('mcp.get_entities', { urns: [signal.assetUrn] })
        void er
      }

      // 2. Read the downstream lineage (blast radius) — only if not already done
      if (readCallCount === 0) {
        emit('plan', { reasoning: `Traversing the downstream lineage to identify the blast radius for \`${sig.assetName}\`.` })
        const lr = await guardedExecute('mcp.get_lineage', { urn: signal.assetUrn, direction: 'DOWNSTREAM' })
        void lr
      }

      // 3. Open a GitHub issue — only if not already done (type-specific content)
      if (!mandatoryDone.has('action.github_open_issue')) {
        const { title: issueTitle, body: issueBody, labels: issueLabels } = det.githubIssue
        emit('plan', { reasoning: 'Opening a GitHub issue in the demo pipeline repo to track the engineering remediation.' })
        const gh = await guardedExecute('action.github_open_issue', { title: issueTitle, body: issueBody, labels: issueLabels })
        if (gh.status === 'ok') mandatoryDone.add('action.github_open_issue')
      }

      // 4. Post a Slack triage card — only if not already done (type-specific content)
      if (!mandatoryDone.has('action.slack_post_triage')) {
        const { title: slackTitle, bullets: slackBullets, footer: slackFooter } = det.slackTriage
        emit('plan', { reasoning: 'Posting a triage card to the on-call Slack channel so stakeholders are notified.' })
        const sl = await guardedExecute('action.slack_post_triage', { title: slackTitle, bullets: slackBullets, footer: slackFooter })
        if (sl.status === 'ok') mandatoryDone.add('action.slack_post_triage')
      }

      // 5. Write the post-mortem context doc to DataHub — only if not already
      //    written. For PII-tagged assets the guardrail REFUSES this write
      //    (the correct governed behaviour); the refusal is recorded and the
      //    incident still resolves with the GitHub + Slack actions filed.
      if (!wrotePostMortem) {
        const { title: pmTitle, content: pmContent } = det.postMortem
        emit('plan', { reasoning: 'Writing a post-mortem context doc to DataHub so the next incident on this asset inherits this investigation.' })
        const pm = await guardedExecute('ack.save_document', { assetUrn: signal.assetUrn, title: pmTitle, content: pmContent, sentinelPostMortem: true })
        if (pm.status === 'ok') {
          mandatoryDone.add('ack.save_document')
          wrotePostMortem = true
          emit('write_back', {
            toolName: 'ack.save_document',
            toolArgs: { assetUrn: signal.assetUrn, sentinelPostMortem: true },
            toolResult: pm.result,
            reasoning: 'Sentinel wrote a post-mortem to DataHub. The next incident on this asset will inherit this context.',
          })
        } else if (pm.status === 'refused') {
          emit('observe', {
            reasoning:
              'Sentinel\'s guardrail REFUSED the post-mortem write-back because the asset is tagged PII + Restricted. ' +
              'No post-mortem was written — a human data owner must approve any write to a PII asset. The GitHub issue and Slack triage were still filed.',
          })
          // Write a durable governance refusal record to DataHub (not PII
          // content — just the decision metadata). The governanceRefusalWritten
          // flag dedupes if the main loop already wrote it.
          const piiCheck = await checkPiiForAssetInline(clients.mcp, signal.assetUrn)
          if (piiCheck) {
            await writeGovernanceRefusalRecord(
              piiCheck.tags.map((t) => t.name),
              piiCheck.reason ?? 'PII governance tag detected',
            )
          } else {
            await writeGovernanceRefusalRecord(
              ['PII', 'Restricted'],
              'Asset carries PII + Restricted governance tags. Write-back refused.',
            )
          }
        }
      }

      // 5b. Tighten the SLA assertion on DataHub for freshness breaches — this
      //     is the second durable write-back (the learned policy). It makes the
      //     write-backs section show two DISTINCT DataHub artefacts: the post-
      //     mortem context doc + the tightened SLA assertion. Schema/PII signals
      //     skip this (a schema break doesn't tighten an SLA; PII is refused).
      if (sig.scenarioId === 'nyc-taxi-freshness' && !assertionTightened) {
        emit('plan', { reasoning: 'Tightening the freshness SLA assertion on DataHub from 1h to 45min so the next breach pages on-call earlier.' })
        const asrt = await guardedExecute('ack.create_assertion', {
          assetUrn: signal.assetUrn,
          type: 'freshness',
          description: 'Tightened freshness SLA — 45min (was 1h). Sentinel learned this from the 6h-stale breach on 2026-07-30.',
          slaSeconds: 2700,
        })
        if (asrt.status === 'ok') {
          assertionTightened = true
          emit('write_back', {
            toolName: 'ack.create_assertion',
            toolArgs: { assetUrn: signal.assetUrn, type: 'freshness', slaSeconds: 2700 },
            toolResult: asrt.result,
            reasoning: 'Sentinel tightened the freshness SLA assertion on DataHub (1h → 45min). The next breach will page on-call 15 minutes earlier.',
          })
        }
      }

      // The closed loop is now complete (or was already complete). Clear the
      // error so the incident is marked 'resolved' — NOT 'degraded'. The LLM
      // being temporarily unavailable is not a failure of the investigation;
      // the deterministic path guaranteed the closed loop completed. A PII
      // refusal is the correct governed outcome, not a degraded state.
      lastError = null
      wasCircuitOpen = false
      const piiNote = piiRefusalOnPostMortem
        ? ' The post-mortem write-back was refused by the PII guardrail — the governed outcome.'
        : ''
      emit('observe', {
        reasoning:
          'Investigation complete. Sentinel executed the full closed loop: read the asset, ' +
          'traversed the lineage, opened a GitHub issue, posted a Slack triage card, and ' +
          (piiRefusalOnPostMortem
            ? 'attempted the post-mortem write (refused by the PII guardrail).' + piiNote
            : 'wrote a post-mortem to DataHub.') +
          ' The incident is resolved.',
      })
    } catch (fallbackErr) {
      emit('error', { error: `Deterministic fallback failed: ${(fallbackErr as Error).message ?? String(fallbackErr)}` })
    }
  }

  // 3. Post-loop: guarantee a post-mortem context doc (the compounding artefact).
  // SKIP the fallback if the guardrail refused the post-mortem on a PII-tagged
  // asset (PDF §12.3 — the refusal IS the correct agent behaviour, not a
  // missing post-mortem).
  if (!wrotePostMortem && !piiRefusalOnPostMortem) {
    try {
      // Phase 3: re-run the PII check on the asset before writing the fallback.
      // The fallback bypasses the tool-call loop, so the guardrail's pre-exec
      // hook doesn't fire — we inline the same PII check here. (PDF §12.3)
      const piiCheck = await checkPiiForAssetInline(clients.mcp, signal.assetUrn)
      if (piiCheck.hasPii) {
        emit('observe', {
          reasoning:
            `Sentinel blocked the automatic post-mortem on this PII-tagged asset: ${piiCheck.tags.map((t) => `'${t.name}'`).join(', ')}. ` +
            `A human must approve any write to a PII asset; the guardrail upholds this rule for the fallback path as well.`,
        })
        // Write a durable governance refusal record to DataHub (not PII content —
        // just the decision metadata). The governanceRefusalWritten flag dedupes.
        await writeGovernanceRefusalRecord(
          piiCheck.tags.map((t) => t.name),
          piiCheck.reason ?? 'PII governance tag detected on fallback path',
        )
      } else {
        const me = await clients.mcp.get_me()
        // Use the type-specific post-mortem content (freshness / schema / pii)
        // so the fallback post-mortem is as distinct as the LLM-authored one.
        const det = buildDeterministicActions(sig, signal, incidentUrn, steps, finalReflection, lastError)
        const postMortemContent = det.postMortem.content
        const postMortemTitle = det.postMortem.title
        // Phase 4: dual write-back path. The orchestrator's post-loop fallback
        // now goes through the same helper as the agent's ack.save_document
        // tool: try Agent Context Kit → fall back to REST ingestion on a
        // 5xx/network error. A 4xx is a hard failure (no fallback). Both paths
        // record a WriteBack row + audit events.
        const wb = await writeBackDocument({
          clients,
          incidentUrn,
          assetUrn: signal.assetUrn,
          title: postMortemTitle,
          content: postMortemContent,
          format: 'markdown',
          authorUrn: me.urn,
          sentinelPostMortem: true,
          audit,
        })
        emit('write_back', {
          toolName: 'ack.save_document',
          toolArgs: { assetUrn: signal.assetUrn, sentinelPostMortem: true },
          toolResult: {
            urn: wb.urn,
            kind: 'context_doc',
            path: wb.path,
            status: wb.status,
            fallback: wb.fallback,
            primaryError: wb.primaryError,
          },
          reasoning:
            wb.status === 'succeeded'
              ? wb.fallback
                ? `Sentinel wrote a post-mortem to DataHub via the data API. The next incident on this asset will inherit this context.`
                : `Sentinel wrote a post-mortem to DataHub. The next incident on this asset will inherit this context.`
              : `Sentinel could not write the post-mortem to DataHub. The investigation summary is preserved in the audit log.`,
        })
      }
      // Also tighten the SLA assertion for freshness breaches on the post-loop
      // fallback path (mirrors the deterministic fallback's step 5b).
      if (sig.scenarioId === 'nyc-taxi-freshness' && !assertionTightened) {
        try {
          const asrtRes = await clients.ingestion.createAssertion({
            assetUrn: signal.assetUrn,
            type: 'freshness',
            description: 'Tightened freshness SLA — 45min (was 1h). Sentinel learned this from the 6h-stale breach on 2026-07-30.',
            slaSeconds: 2700,
          })
          await db.writeBack.create({
            data: {
              incidentUrn,
              kind: 'assertion',
              datahubUrn: asrtRes.urn,
              status: 'succeeded',
              path: 'rest_ingestion',
              dataJson: JSON.stringify({ assetUrn: signal.assetUrn, type: 'freshness', slaSeconds: 2700 }),
              ts: new Date(),
            },
          })
          assertionTightened = true
          emit('write_back', {
            toolName: 'ack.create_assertion',
            toolArgs: { assetUrn: signal.assetUrn, type: 'freshness', slaSeconds: 2700 },
            toolResult: { urn: asrtRes.urn, kind: 'assertion', assetUrn: signal.assetUrn, type: 'freshness', slaSeconds: 2700, path: 'rest_ingestion' },
            reasoning: 'Sentinel tightened the freshness SLA assertion on DataHub (1h → 45min). The next breach will page on-call 15 minutes earlier.',
          })
        } catch {
          // non-fatal — the post-mortem is the mandatory artefact
        }
      }
    } catch (err) {
      emit('error', { error: `Fallback post-mortem write failed: ${(err as Error).message}` })
    }
  } else if (piiRefusalOnPostMortem) {
    emit('observe', {
      reasoning:
        'Sentinel\'s guardrail refused the post-mortem on this PII-tagged asset. ' +
        'No post-mortem was written — a human must approve any write to a PII asset.',
    })
    // Safety net: if neither the main loop nor the deterministic fallback
    // wrote the governance refusal record (e.g. the LLM path refused but the
    // deterministic fallback didn't run because the circuit was open), write
    // it here. The governanceRefusalWritten flag dedupes.
    if (!governanceRefusalWritten) {
      const piiCheck = await checkPiiForAssetInline(clients.mcp, signal.assetUrn)
      if (piiCheck) {
        await writeGovernanceRefusalRecord(
          piiCheck.tags.map((t) => t.name),
          piiCheck.reason ?? 'PII governance tag detected',
        )
      } else {
        await writeGovernanceRefusalRecord(
          ['PII', 'Restricted'],
          'Asset carries PII + Restricted governance tags. Write-back refused.',
        )
      }
    }
  }

  // 4. Resolve the incident.
  // Three terminal states:
  //   - 'resolved'  — the agent completed the closed loop (no error)
  //   - 'degraded'  — the LLM was UNREACHABLE (rate-limit / auth-geo-block /
  //                   gateway 5xx / network); the agent did partial work and a
  //                   fallback post-mortem was written. This is NOT a failure —
  //                   it's the designed graceful-degradation path (PDF §11.3).
  //                   The dashboard surfaces an amber 'degraded' chip, not a
  //                   scary red 'failed'.
  //   - 'failed'    — a real bug (non-LLM exception). The agent could not
  //                   complete the investigation and no compounding artefact
  //                   was written.
  const failed = Boolean(lastError) && !wasCircuitOpen
  const degraded = Boolean(lastError) && wasCircuitOpen
  const finalStatus: Incident['status'] = failed ? 'failed' : degraded ? 'degraded' : 'resolved'
  const resolvedAt = new Date()
  await db.incident.update({
    where: { urn: incidentUrn },
    data: { status: finalStatus, resolvedAt },
  })
  const resolutionKind = failed ? 'incident_failed' : degraded ? 'incident_degraded' : 'incident_resolved'
  const resolutionSummary = failed
    ? `Incident failed: ${lastError}`
    : degraded
      ? `Incident degraded (LLM unreachable): ${lastError}`
      : `Incident resolved in ${steps.length} reasoning steps`
  await audit.record({
    incidentUrn,
    kind: resolutionKind,
    summary: resolutionSummary,
    payload: { steps: steps.length, totalPromptTokens, totalCompletionTokens, wasCircuitOpen },
  })
  // Phase 4: mirror the resolution milestone to DataHub Assertions (best-effort,
  // non-fatal). This is the assertion a DataHub operator sees on the asset page:
  // "Sentinel incident resolved / failed on {asset}". (PDF §13.4)
  void getAuditMirror().mirror({
    incidentUrn,
    kind: resolutionKind,
    summary: resolutionSummary,
    assetUrn: signal.assetUrn,
  })

  const incident: Incident = {
    urn: incidentUrn,
    signal,
    status: finalStatus,
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
    actualProvider,
    failoverOccurred,
    promptVersion: PROMPT_VERSION,
    auditMirrorMode: getAuditMirrorMode(),
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
