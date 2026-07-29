// =============================================================================
// Sentinel — LLM client (resilience-hardened)
//
// Design: one LLM provider, temperature 0, deterministic. Retries with
// exponential backoff on any failure.
//
// Resilience hardening (this file):
//   • TokenBucket pace limiter (default 1 req / 6s per provider) — keeps
//     the agent from bursting into 429s and contributing to a shared-gateway
//     throttle.
//   • 429-specific backoff with jitter (5s → 10s → 20s ± 25%) — longer than
//     the general network/5xx backoff, because a 429 from a shared gateway is
//     a sustained throttle, not a per-account quota.
//   • CircuitBreaker — opens after 3 consecutive 429/5xx, stays open for 60s.
//     While open, calls throw CircuitOpenError immediately (no retry burn).
//   • Optional provider failover — when the primary's circuit is open AND a
//     NVIDIA key is present, the dormant NvidiaNimLlmClient takes over.
//     In local dev the NVIDIA key is dead (403 on inference), so the
//     failover surfaces a clear CircuitOpenError and the orchestrator's
//     post-loop fallback post-mortem path runs gracefully. On a real
//     deployment with a fresh NVIDIA key, the agent transparently switches
//     providers and continues.
//
// All tunables via env: LLM_RATE_LIMIT_MS, LLM_CIRCUIT_THRESHOLD,
// LLM_CIRCUIT_COOLDOWN_MS, LLM_FAILOVER_ENABLED. See .env.example.
//
// Provider selection (LLM_PROVIDER env, default 'groq'):
//
//   groq    — direct Groq API (DEFAULT). llama-3.3-70b-versatile primary,
//             llama-3.1-8b-instant fallback. OpenAI-compatible endpoint at
//             api.groq.com/openai/v1. This is the provider the live demo runs
//             on (Vercel US datacenter — Groq is geo-blocked from some regions).
//
//             When Groq is hard-throttled (sustained 429 — a shared-gateway
//             quota burn, not a per-second limit), the circuit opens and the
//             orchestrator's post-loop fallback post-mortem path runs
//             gracefully. The dashboard surfaces the circuit state to the
//             operator (header chip + /api/llm/status) without masking it.
//
//   zai     — z-ai-web-dev-sdk gateway. Works inside the build environment
//             where direct outbound to integrate.api.nvidia.com is
//             blocked. Supports OpenAI-style tool-calling + multi-turn
//             role:'tool' messages + parallel tool_calls. Kept as an
//             alternative provider (LLM_PROVIDER=zai).
//
//   nvidia  — direct NVIDIA NIM OpenAI-compatible endpoint
//             (https://integrate.api.nvidia.com/v1). PRIMARY model
//             nvidia/llama-3.3-nemotron-super-49b-v1 (parallel tool-calling),
//             FALLBACK openai/gpt-oss-120b. Selected when a valid NVIDIA key
//             is present. Kept as an alternative so the same orchestrator
//             runs against real NVIDIA hardware, and as the dormant failover
//             target for groq.
//
// Both providers expose the same OpenAI-compatible `chat/completions` surface,
// so the orchestrator is provider-agnostic. The fallback MODEL is swapped in
// only after the primary model exhausts retries on a retryable error.
//
// This file runs on the server only. No secrets are logged or sent to client.
// =============================================================================

import ZAI from 'z-ai-web-dev-sdk'
import type {
  LlmClient,
  LlmCompletion,
  LlmMessage,
  LlmTool,
  LlmToolCall,
} from './types'

export type LlmProvider = 'zai' | 'nvidia' | 'groq'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_TEMP = Number(process.env.LLM_TEMPERATURE ?? 0)
const DEFAULT_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 1500)
const MAX_RETRIES = 3

// General backoff (network / 5xx) — keeps the original aggressive curve.
const INITIAL_BACKOFF_MS = 800

// 429-specific backoff with jitter — much longer, because a 429 from a
// shared gateway is a sustained throttle, not a per-account quota.
const RATE_LIMIT_BACKOFF_BASE_MS = Number(process.env.LLM_RATE_LIMIT_BACKOFF_MS ?? 5000)
const RATE_LIMIT_BACKOFF_MAX_MS = Number(process.env.LLM_RATE_LIMIT_BACKOFF_MAX_MS ?? 20000)
const RATE_LIMIT_JITTER_PCT = 0.25

// Pace limiter — at most one call per interval per provider. Default 6s
// keeps the agent from contributing to a shared-gateway 429 pressure.
// Set to 0 (or a low value) to disable for fast dev loops.
const RATE_LIMIT_INTERVAL_MS = Number(process.env.LLM_RATE_LIMIT_MS ?? 6000)

// Circuit breaker — opens after N consecutive 429/5xx, stays open for cooldown.
const CIRCUIT_THRESHOLD = Number(process.env.LLM_CIRCUIT_THRESHOLD ?? 3)
const CIRCUIT_COOLDOWN_MS = Number(process.env.LLM_CIRCUIT_COOLDOWN_MS ?? 60000)

// Failover toggle — when 'true' (default), the z-ai primary can fail over to
// the dormant NVIDIA client when its circuit is open AND a NVIDIA key is
// present. Set LLM_FAILOVER_ENABLED=false to keep z-ai-only behavior.
const LLM_FAILOVER_ENABLED =
  (process.env.LLM_FAILOVER_ENABLED ?? 'true').toLowerCase() !== 'false'

function getProvider(): LlmProvider {
  const raw = (process.env.LLM_PROVIDER ?? 'groq').toLowerCase()
  if (raw === 'nvidia') return 'nvidia'
  if (raw === 'zai') return 'zai'
  return 'groq'
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
function jitter(ms: number, pct: number = RATE_LIMIT_JITTER_PCT): number {
  const delta = ms * pct
  return Math.round(ms + (Math.random() * 2 - 1) * delta)
}

/**
 * The z-ai-web-dev-sdk throws plain `Error` instances whose `.message` is
 * `API request failed with status 429: ...` — the HTTP status is NOT exposed
 * as a `.status` property. Extract it from the message so the retry +
 * circuit-breaker logic can recognise 429/5xx. (NVIDIA NIM uses `fetch`
 * directly and gets a real `Response.status`, so this helper is z-ai only.)
 */
function extractStatusFromMessage(msg: string): number | null {
  const m = msg.match(/status (\d{3})\b/i)
  return m ? parseInt(m[1], 10) : null
}

// ---------------------------------------------------------------------------
// Resilience primitives (shared by both providers)
// ---------------------------------------------------------------------------

/**
 * Single-capacity token bucket. Refills at `capacity` tokens per
 * `refillIntervalMs`. `acquire()` waits until a token is available.
 *
 * Used per-provider to pace calls so the agent doesn't burst into the
 * shared gateway's 429 throttle.
 */
class TokenBucket {
  private tokens: number
  private lastRefill: number
  constructor(
    private readonly capacity: number,
    private readonly refillIntervalMs: number,
  ) {
    this.tokens = capacity
    this.lastRefill = Date.now()
  }
  async acquire(): Promise<void> {
    if (this.refillIntervalMs <= 0) return // disabled
    while (true) {
      const now = Date.now()
      const elapsed = now - this.lastRefill
      const refilled = elapsed / this.refillIntervalMs
      this.tokens = Math.min(this.capacity, this.tokens + refilled)
      if (this.tokens >= 1) {
        this.tokens -= 1
        // Snap the refill clock to "now minus the fraction we used" so the
        // next acquire sees a correct partial refill.
        this.lastRefill = now - Math.max(0, (1 - this.tokens) * this.refillIntervalMs)
        return
      }
      const waitMs = Math.ceil((1 - this.tokens) * this.refillIntervalMs)
      await sleep(Math.max(100, Math.min(waitMs, this.refillIntervalMs + 500)))
    }
  }
}

/**
 * Opens after `threshold` consecutive 429/5xx failures, stays open for
 * `cooldownMs`. While open, callers should throw CircuitOpenError instead
 * of retrying.
 */
class CircuitBreaker {
  private consecutiveFailures = 0
  private openUntil = 0
  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
  ) {}
  isOpen(): boolean {
    return Date.now() < this.openUntil
  }
  /**
   * Records a failure. Returns true if THIS call opened the circuit.
   * Non-retryable statuses (4xx other than 429) do not bump the counter —
   * they are config errors, not throttle/availability signals.
   */
  recordFailure(status: number): boolean {
    if (status === 429 || status >= 500) {
      this.consecutiveFailures++
      if (this.consecutiveFailures >= this.threshold && !this.isOpen()) {
        this.openUntil = Date.now() + this.cooldownMs
        return true
      }
    }
    return false
  }
  recordSuccess(): void {
    this.consecutiveFailures = 0
    this.openUntil = 0
  }
  msUntilReset(): number {
    return Math.max(0, this.openUntil - Date.now())
  }
  /** Snapshot for the UI status chip / `/api/llm/status`. */
  snapshot(): { isOpen: boolean; consecutiveFailures: number; msUntilReset: number } {
    return {
      isOpen: this.isOpen(),
      consecutiveFailures: this.consecutiveFailures,
      msUntilReset: this.msUntilReset(),
    }
  }
}

/** Thrown when the circuit is open — distinguishes "throttled" from "failed". */
export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CircuitOpenError'
  }
}

/** LlmClient that also exposes circuit state for failover + UI status. */
interface ResilientLlmClient extends LlmClient {
  isThrottled(): boolean
  providerName(): string
  circuitSnapshot(): { isOpen: boolean; consecutiveFailures: number; msUntilReset: number }
}

// ---------------------------------------------------------------------------
// Shared response mapping (both providers return OpenAI-compatible JSON)
// ---------------------------------------------------------------------------

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}
interface OpenAiChoice {
  message: { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
  finish_reason: string
}
interface OpenAiResponse {
  choices: OpenAiChoice[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

/**
 * Sentinel's internal LlmMessage shape uses camelCase (`toolCalls`,
 * `toolCallId`) so the orchestrator's scratchpad is provider-agnostic. Real
 * OpenAI-compatible wire APIs (Groq, NVIDIA NIM) require snake_case
 * (`tool_calls`, `tool_call_id`) AND `content: null` (not `''`) on assistant
 * messages that carry tool_calls. This maps the internal shape to the wire
 * shape for any direct-fetch OpenAI-compatible provider.
 */
function toWireMessages(messages: LlmMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.function.name, arguments: c.function.arguments },
        })),
      }
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.toolCallId,
        name: m.name,
        content: m.content,
      }
    }
    return { role: m.role, content: m.content }
  })
}

function mapCompletion(res: OpenAiResponse): LlmCompletion {
  const choice = res.choices?.[0]
  if (!choice) return { content: null, toolCalls: [], finishReason: 'empty' }
  const toolCalls: LlmToolCall[] = (choice.message.tool_calls ?? []).map((c) => ({
    id: c.id,
    type: 'function',
    function: { name: c.function.name, arguments: c.function.arguments },
  }))
  return {
    content: choice.message.content ?? null,
    toolCalls,
    finishReason: choice.finish_reason ?? 'stop',
    usage: {
      promptTokens: res.usage?.prompt_tokens ?? 0,
      completionTokens: res.usage?.completion_tokens ?? 0,
    },
  }
}

// ===========================================================================
// Provider: z-ai-web-dev-sdk (works in the local build environment)
// ===========================================================================

class ZaiLlmClient implements ResilientLlmClient {
  private zaiPromise: Promise<InstanceType<typeof ZAI>> | null = null
  private readonly rateLimiter = new TokenBucket(1, RATE_LIMIT_INTERVAL_MS)
  private readonly circuit = new CircuitBreaker(CIRCUIT_THRESHOLD, CIRCUIT_COOLDOWN_MS)

  private async zai(): Promise<InstanceType<typeof ZAI>> {
    if (!this.zaiPromise) this.zaiPromise = ZAI.create()
    return this.zaiPromise
  }

  providerName(): string {
    return 'zai'
  }

  isThrottled(): boolean {
    return this.circuit.isOpen()
  }

  circuitSnapshot() {
    return this.circuit.snapshot()
  }

  async complete(input: {
    messages: LlmMessage[]
    tools?: LlmTool[]
    temperature?: number
    maxTokens?: number
  }): Promise<LlmCompletion> {
    // If circuit is open, throw immediately so the failover (or the
    // orchestrator's post-loop fallback) can take over without burning
    // 60s on retries that will all fail.
    if (this.circuit.isOpen()) {
      throw new CircuitOpenError(
        `z-ai circuit open for ${this.circuit.msUntilReset()}ms ` +
          `(sustained 429 from the shared gateway). ` +
          `Sentinel will fail over to NVIDIA if a key is present, otherwise ` +
          `the orchestrator's fallback post-mortem path runs (PDF §9.4.2).`,
      )
    }

    const model = process.env.LLM_MODEL || 'gpt-4o'
    const fallbackModel = process.env.LLM_FALLBACK_MODEL || 'gpt-4o-mini'
    const zai = await this.zai()

    const call = async (m: string): Promise<LlmCompletion> => {
      let lastErr: Error | null = null
      let sawRateLimit = false
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          // 429s use longer backoff with jitter; other retryables use the
          // original aggressive curve.
          const baseBackoff = sawRateLimit
            ? Math.min(
                RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (attempt - 1),
                RATE_LIMIT_BACKOFF_MAX_MS,
              )
            : INITIAL_BACKOFF_MS * 2 ** (attempt - 1)
          await sleep(jitter(baseBackoff))
        }
        await this.rateLimiter.acquire()
        try {
          // The SDK body has an index signature; we cast to pass tools/tool_choice
          // and to allow role:'tool' + assistant.tool_calls on messages.
          const res = (await zai.chat.completions.create({
            model: m,
            messages: input.messages as unknown as Record<string, unknown>[],
            tools: input.tools as unknown as Record<string, unknown>[] | undefined,
            tool_choice: input.tools?.length ? 'auto' : undefined,
            temperature: input.temperature ?? DEFAULT_TEMP,
            max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
            stream: false,
            thinking: { type: 'disabled' },
          } as Record<string, unknown>)) as unknown as OpenAiResponse
          this.circuit.recordSuccess()
          return mapCompletion(res)
        } catch (err) {
          const e = err as { status?: number; statusCode?: number; message?: string }
          const msg = e.message ?? String(err)
          // The z-ai SDK throws plain Errors with the HTTP status embedded in
          // the message — extract it so the retry + circuit-breaker logic
          // recognises 429/5xx. Real fetch Errors keep their .status.
          const status =
            e.status ?? e.statusCode ?? extractStatusFromMessage(msg) ?? 0
          if (status === 429) sawRateLimit = true
          lastErr = new Error(`z-ai LLM (model ${m}) failed: ${msg}`)
          const openedNow = this.circuit.recordFailure(status || 503)
          if (openedNow) {
            // Circuit just opened — stop retrying, let failover take over.
            throw new CircuitOpenError(
              `z-ai circuit opened after ${CIRCUIT_THRESHOLD} consecutive 429/5xx. ` +
                `Cooldown ${CIRCUIT_COOLDOWN_MS}ms. Last error: ${msg.slice(0, 120)}`,
            )
          }
          // Retry on 429/5xx or network errors; otherwise throw.
          if (
            (status && isRetryableStatus(status)) ||
            /network|fetch|ECONN|ETIMEDOUT|timeout/i.test(msg)
          ) {
            if (attempt < MAX_RETRIES) continue
          }
          throw lastErr
        }
      }
      throw lastErr ?? new Error('z-ai LLM call failed after retries')
    }

    try {
      return await call(model)
    } catch (primaryErr) {
      if (primaryErr instanceof CircuitOpenError) throw primaryErr
      if (model === fallbackModel) throw primaryErr
      // Fallback model attempt.
      try {
        return await call(fallbackModel)
      } catch (fallbackErr) {
        if (fallbackErr instanceof CircuitOpenError) throw fallbackErr
        const pm = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
        const fm = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
        throw new Error(
          `LLM unavailable: primary '${model}' (${pm.slice(0, 160)}) and ` +
            `fallback '${fallbackModel}' (${fm.slice(0, 160)}) both failed.`,
        )
      }
    }
  }
}

// ===========================================================================
// Provider: NVIDIA NIM direct (OpenAI-compatible)
// Kept for deployments where the NVIDIA key is valid. Also
// serves as the dormant failover target when the z-ai circuit opens.
// ===========================================================================

const NVIDIA_BASE_URL = process.env.LLM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1'

class NvidiaNimLlmClient implements ResilientLlmClient {
  private readonly rateLimiter = new TokenBucket(1, RATE_LIMIT_INTERVAL_MS)
  private readonly circuit = new CircuitBreaker(CIRCUIT_THRESHOLD, CIRCUIT_COOLDOWN_MS)

  providerName(): string {
    return 'nvidia'
  }

  isThrottled(): boolean {
    return this.circuit.isOpen()
  }

  circuitSnapshot() {
    return this.circuit.snapshot()
  }

  async complete(input: {
    messages: LlmMessage[]
    tools?: LlmTool[]
    temperature?: number
    maxTokens?: number
  }): Promise<LlmCompletion> {
    if (this.circuit.isOpen()) {
      throw new CircuitOpenError(
        `nvidia circuit open for ${this.circuit.msUntilReset()}ms ` +
          `(sustained 429/5xx from the NVIDIA NIM endpoint).`,
      )
    }

    const model = process.env.LLM_MODEL || 'nvidia/llama-3.3-nemotron-super-49b-v1'
    const fallbackModel = process.env.LLM_FALLBACK_MODEL || 'openai/gpt-oss-120b'
    const apiKey = process.env.NVIDIA_API_KEY
    if (!apiKey) throw new Error('NVIDIA_API_KEY is not set in the environment')

    const call = async (m: string): Promise<LlmCompletion> => {
      const body = {
        model: m,
        messages: toWireMessages(input.messages),
        tools: input.tools,
        tool_choice: input.tools?.length ? 'auto' : undefined,
        temperature: input.temperature ?? DEFAULT_TEMP,
        max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: false,
      }
      let lastErr: Error | null = null
      let sawRateLimit = false
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const baseBackoff = sawRateLimit
            ? Math.min(
                RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (attempt - 1),
                RATE_LIMIT_BACKOFF_MAX_MS,
              )
            : INITIAL_BACKOFF_MS * 2 ** (attempt - 1)
          await sleep(jitter(baseBackoff))
        }
        await this.rateLimiter.acquire()
        let res: Response
        try {
          res = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(body),
          })
        } catch (err) {
          // Network error — treat as a 503 for the circuit (transient infra).
          const openedNow = this.circuit.recordFailure(503)
          const e = err instanceof Error ? err : new Error(String(err))
          if (openedNow) {
            throw new CircuitOpenError(
              `nvidia circuit opened after ${CIRCUIT_THRESHOLD} consecutive ` +
                `failures (last: network error: ${e.message.slice(0, 120)})`,
            )
          }
          lastErr = e
          if (attempt < MAX_RETRIES) continue
          throw lastErr
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          if (res.status === 429) sawRateLimit = true
          const err = new Error(`LLM ${m} HTTP ${res.status}: ${text.slice(0, 300)}`)
          const openedNow = this.circuit.recordFailure(res.status)
          if (openedNow) {
            throw new CircuitOpenError(
              `nvidia circuit opened after ${CIRCUIT_THRESHOLD} consecutive 429/5xx. ` +
                `Last error: HTTP ${res.status}`,
            )
          }
          if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
            lastErr = err
            continue
          }
          throw err
        }
        this.circuit.recordSuccess()
        return mapCompletion((await res.json()) as OpenAiResponse)
      }
      throw lastErr ?? new Error('NVIDIA LLM call failed after retries')
    }

    try {
      return await call(model)
    } catch (primaryErr) {
      if (primaryErr instanceof CircuitOpenError) throw primaryErr
      if (model === fallbackModel) throw primaryErr
      try {
        return await call(fallbackModel)
      } catch (fallbackErr) {
        if (fallbackErr instanceof CircuitOpenError) throw fallbackErr
        const pm = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
        const fm = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
        throw new Error(
          `LLM unavailable: primary '${model}' (${pm.slice(0, 160)}) and ` +
            `fallback '${fallbackModel}' (${fm.slice(0, 160)}) both failed.`,
        )
      }
    }
  }
}

// ===========================================================================
// Provider: Groq (OpenAI-compatible, real outbound LLM — DEFAULT)
//
// Groq's chat/completions endpoint is a drop-in OpenAI-compatible surface
// (same request/response shape as NVIDIA NIM), so it reuses the exact same
// resilience primitives (TokenBucket, CircuitBreaker, retry/backoff). This
// is the provider actually reachable from outside the build environment — no
// z-ai gateway, no dead NVIDIA key. Get a free key at console.groq.com/keys.
// ===========================================================================

const GROQ_BASE_URL = process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1'

class GroqLlmClient implements ResilientLlmClient {
  private readonly rateLimiter = new TokenBucket(1, RATE_LIMIT_INTERVAL_MS)
  private readonly circuit = new CircuitBreaker(CIRCUIT_THRESHOLD, CIRCUIT_COOLDOWN_MS)

  providerName(): string {
    return 'groq'
  }

  isThrottled(): boolean {
    return this.circuit.isOpen()
  }

  circuitSnapshot() {
    return this.circuit.snapshot()
  }

  async complete(input: {
    messages: LlmMessage[]
    tools?: LlmTool[]
    temperature?: number
    maxTokens?: number
  }): Promise<LlmCompletion> {
    if (this.circuit.isOpen()) {
      throw new CircuitOpenError(
        `groq circuit open for ${this.circuit.msUntilReset()}ms ` +
          `(sustained 429/5xx from the Groq endpoint).`,
      )
    }

    const model = process.env.LLM_MODEL || 'llama-3.3-70b-versatile'
    const fallbackModel = process.env.LLM_FALLBACK_MODEL || 'llama-3.1-8b-instant'
    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) throw new Error('GROQ_API_KEY is not set in the environment')

    const call = async (m: string): Promise<LlmCompletion> => {
      const body = {
        model: m,
        messages: toWireMessages(input.messages),
        tools: input.tools,
        tool_choice: input.tools?.length ? 'auto' : undefined,
        temperature: input.temperature ?? DEFAULT_TEMP,
        max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: false,
      }
      let lastErr: Error | null = null
      let sawRateLimit = false
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const baseBackoff = sawRateLimit
            ? Math.min(
                RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (attempt - 1),
                RATE_LIMIT_BACKOFF_MAX_MS,
              )
            : INITIAL_BACKOFF_MS * 2 ** (attempt - 1)
          await sleep(jitter(baseBackoff))
        }
        await this.rateLimiter.acquire()
        let res: Response
        try {
          res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(body),
          })
        } catch (err) {
          const openedNow = this.circuit.recordFailure(503)
          const e = err instanceof Error ? err : new Error(String(err))
          if (openedNow) {
            throw new CircuitOpenError(
              `groq circuit opened after ${CIRCUIT_THRESHOLD} consecutive ` +
                `failures (last: network error: ${e.message.slice(0, 120)})`,
            )
          }
          lastErr = e
          if (attempt < MAX_RETRIES) continue
          throw lastErr
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          if (res.status === 429) sawRateLimit = true
          const err = new Error(`LLM ${m} HTTP ${res.status}: ${text.slice(0, 300)}`)
          const openedNow = this.circuit.recordFailure(res.status)
          if (openedNow) {
            throw new CircuitOpenError(
              `groq circuit opened after ${CIRCUIT_THRESHOLD} consecutive 429/5xx. ` +
                `Last error: HTTP ${res.status}`,
            )
          }
          if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
            lastErr = err
            continue
          }
          throw err
        }
        this.circuit.recordSuccess()
        return mapCompletion((await res.json()) as OpenAiResponse)
      }
      throw lastErr ?? new Error('Groq LLM call failed after retries')
    }

    try {
      return await call(model)
    } catch (primaryErr) {
      if (primaryErr instanceof CircuitOpenError) throw primaryErr
      if (model === fallbackModel) throw primaryErr
      try {
        return await call(fallbackModel)
      } catch (fallbackErr) {
        if (fallbackErr instanceof CircuitOpenError) throw fallbackErr
        const pm = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
        const fm = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
        throw new Error(
          `LLM unavailable: primary '${model}' (${pm.slice(0, 160)}) and ` +
            `fallback '${fallbackModel}' (${fm.slice(0, 160)}) both failed.`,
        )
      }
    }
  }
}

// ===========================================================================
// Failover wrapper — wires the dormant NVIDIA path in front of z-ai without
// breaking the single-LlmClient contract the orchestrator expects. Used only
// when LLM_PROVIDER=zai AND a NVIDIA key looks configured.
// ===========================================================================

class FailoverLlmClient implements LlmClient {
  constructor(
    private readonly primary: ResilientLlmClient,
    private readonly fallback: ResilientLlmClient,
  ) {}

  async complete(input: {
    messages: LlmMessage[]
    tools?: LlmTool[]
    temperature?: number
    maxTokens?: number
  }): Promise<LlmCompletion> {
    // Proactive failover: if primary is throttled and fallback is healthy,
    // go straight to the fallback without burning a primary attempt.
    if (this.primary.isThrottled() && !this.fallback.isThrottled()) {
      try {
        return await this.fallback.complete(input)
      } catch {
        // Fallback also failed — fall through to try the primary (its
        // circuit may have cooled down by the time we get here).
      }
    }
    try {
      return await this.primary.complete(input)
    } catch (err) {
      if (!(err instanceof CircuitOpenError)) throw err
      // Primary circuit just opened — try the fallback once.
      try {
        return await this.fallback.complete(input)
      } catch (fallbackErr) {
        const fe = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
        throw new CircuitOpenError(
          `Primary '${this.primary.providerName()}' circuit open AND ` +
            `fallback '${this.fallback.providerName()}' failed: ${fe.slice(0, 160)}`,
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton — stored on `globalThis` so it survives Next.js dev-mode module
// re-evaluations. (Each route can re-evaluate the module on hot reload, but
// `globalThis` is per-process, so the LLM client + circuit state persists
// across routes. Production builds don't re-evaluate modules, but using
// globalThis is harmless there.)
// ---------------------------------------------------------------------------

interface SentinelLlmSingleton {
  client: LlmClient | null
  zai: ZaiLlmClient | null
  nvidia: NvidiaNimLlmClient | null
  groq: GroqLlmClient | null
}

function getSingleton(): SentinelLlmSingleton {
  const g = globalThis as unknown as { __sentinelLlm?: SentinelLlmSingleton }
  if (!g.__sentinelLlm) g.__sentinelLlm = { client: null, zai: null, nvidia: null, groq: null }
  return g.__sentinelLlm
}

export function getLlm(): LlmClient {
  const s = getSingleton()
  if (!s.client) {
    const provider = getProvider()
    if (provider === 'nvidia') {
      s.nvidia = new NvidiaNimLlmClient()
      s.client = s.nvidia
    } else if (provider === 'groq') {
      s.groq = new GroqLlmClient()
      s.client = s.groq
    } else {
      s.zai = new ZaiLlmClient()
      const nvidiaKey = process.env.NVIDIA_API_KEY
      // Optional dormant failover — only if a NVIDIA key looks configured.
      // In local dev this key is dead (401 on inference), so the failover
      // surfaces a clear CircuitOpenError instead of masking it; the
      // orchestrator's post-loop fallback post-mortem path runs gracefully.
      if (LLM_FAILOVER_ENABLED && nvidiaKey && nvidiaKey.startsWith('nvapi-')) {
        s.nvidia = new NvidiaNimLlmClient()
        s.client = new FailoverLlmClient(s.zai, s.nvidia)
      } else {
        s.client = s.zai
      }
    }
  }
  return s.client
}

export function getLlmProvider(): LlmProvider {
  return getProvider()
}

export function getLlmModel(): string {
  if (process.env.LLM_MODEL) return process.env.LLM_MODEL
  const provider = getProvider()
  if (provider === 'nvidia') return 'nvidia/llama-3.3-nemotron-super-49b-v1'
  if (provider === 'groq') return 'llama-3.3-70b-versatile'
  return 'gpt-4o'
}

/**
 * Phase 3 resilience — expose circuit state for the UI status chip and the
 * `/api/llm/status` endpoint. Read-only; never throws.
 *
 * In local dev (z-ai + dead NVIDIA key), `failoverEnabled` is true but
 * `nvidiaHealthy` is false — the UI shows the operator that the agent will
 * degrade gracefully via the post-loop fallback path, not via live NVIDIA.
 */
export function getLlmResilienceStatus(): {
  provider: LlmProvider
  model: string
  failoverEnabled: boolean
  hasNvidiaKey: boolean
  circuit: {
    isOpen: boolean
    consecutiveFailures: number
    msUntilReset: number
  } | null
} {
  const hasNvidiaKey = !!(
    process.env.NVIDIA_API_KEY && process.env.NVIDIA_API_KEY.startsWith('nvapi-')
  )
  const s = getSingleton()
  let circuit: { isOpen: boolean; consecutiveFailures: number; msUntilReset: number } | null = null
  if (s.zai && getProvider() === 'zai') circuit = s.zai.circuitSnapshot()
  else if (s.nvidia && getProvider() === 'nvidia') circuit = s.nvidia.circuitSnapshot()
  else if (s.groq && getProvider() === 'groq') circuit = s.groq.circuitSnapshot()
  return {
    provider: getProvider(),
    model: getLlmModel(),
    failoverEnabled: LLM_FAILOVER_ENABLED && hasNvidiaKey && getProvider() === 'zai',
    hasNvidiaKey,
    circuit,
  }
}
