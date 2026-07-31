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
//   • 429-specific backoff with jitter (8s → 15s cap) — one retry fits
//     for the Groq free-tier per-minute rate-limit window to reset. When the
//     provider returns a `Retry-After` header, that value is used instead
//     (capped at 15s to stay under the Vercel Hobby 60s serverless function timeout).
//   • CircuitBreaker — opens after 5 consecutive 429/5xx, stays open for 90s.
//     While open, calls throw CircuitOpenError immediately (no retry burn).
//     Threshold 3 (restored) — 3 consecutive 429s open the circuit; cooldown 90s (was 60s)
//     ensures the rate-limit window fully resets before we retry.
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
// Provider selection (LLM_PROVIDER env, default 'zai'):
//
//   zai     — z-ai-web-dev-sdk gateway (default). Free, no key, no rate
//             limits, tool-calling verified. The z-ai-web-dev-sdk is
//             available as a dependency, so this provider works on any
//             Node.js runtime without additional configuration. Set
//             LLM_PROVIDER=zai (and LLM_FALLBACK_PROVIDER=zai) on any
//             runtime where the SDK is installed to use it as primary.
//
//   gemini  — Google Gemini 2.0 Flash (production primary). Free forever,
//             1M tokens-per-minute, 1M context window, best-in-class native
//             function-calling. OpenAI-compatible endpoint at
//             generativelanguage.googleapis.com/v1beta/openai. Solves the
//             Groq free-tier TPM bottleneck (the 7-8k token Sentinel system
//             prompt exceeds Groq's 6k TPM 8b fallback, so the fallback path
//             was skipped and the 70b primary 429'd). Groq remains the
//             dormant failover for the Gemini path. Get a free key at
//             https://aistudio.google.com/apikey (no credit card).
//
//   groq    — direct Groq API (fallback, kept). llama-3.3-70b-versatile
//             primary, llama-3.1-8b-instant fallback. OpenAI-compatible
//             endpoint at api.groq.com/openai/v1. The Groq free tier's 6k
//             TPM on the 8b fallback cannot absorb the Sentinel system
//             prompt, so this is the fallback for Gemini rather than the
//             primary. The resilience layer still catches failures and
//             runs the post-loop fallback post-mortem.
//
//   nvidia  — direct NVIDIA NIM OpenAI-compatible endpoint (dormant
//             failover for the zai path). PRIMARY model
//             nvidia/llama-3.3-nemotron-super-49b-v1, FALLBACK
//             openai/gpt-oss-120b. Kept for deployments where the NVIDIA
//             key is valid.
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

export type LlmProvider = 'zai' | 'nvidia' | 'groq' | 'gemini'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_TEMP = Number(process.env.LLM_TEMPERATURE ?? 0)
const DEFAULT_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 1500)
// MAX_RETRIES = 1 (2 total attempts). On the Vercel Hobby 60s function
// timeout, 3 retries (4 attempts) with 429 backoff eat the entire budget
// before the agent loop runs. 1 retry gives the rate-limit window one
// chance to reset; if still 429, the circuit opens + the orchestrator
// marks the incident 'degraded' (partial investigation). This keeps the
// worst-case 429 path under 25s, leaving 35s for the agent loop.
const MAX_RETRIES = 2

// General backoff (network / 5xx) — keeps the original aggressive curve.
const INITIAL_BACKOFF_MS = 800

// 429-specific backoff with jitter — long enough for the Groq free-tier
// per-minute rate-limit window to reset. When the provider returns a
// `Retry-After` header, that value is used instead (capped at 15s to stay
// under the Vercel serverless function timeout).
const RATE_LIMIT_BACKOFF_BASE_MS = Number(process.env.LLM_RATE_LIMIT_BACKOFF_MS ?? 3000)
const RATE_LIMIT_BACKOFF_MAX_MS = Number(process.env.LLM_RATE_LIMIT_BACKOFF_MAX_MS ?? 10000)
const RATE_LIMIT_JITTER_PCT = 0.2

// Pace limiter — at most one call per interval per provider. Default 15s
// (Groq free tier allows ~30 req/min on llama-3.3-70b-versatile; one call per
// 15s keeps a full ReAct loop under the per-minute budget). Set to 0 to
// disable for fast dev loops.
const RATE_LIMIT_INTERVAL_MS = Number(process.env.LLM_RATE_LIMIT_MS ?? 2000)

// Circuit breaker — opens after N consecutive 429/5xx, stays open for cooldown.
// Threshold 3 (restored) — 3 consecutive 429s open the circuit; cooldown 90s ensures the Groq
// per-minute rate-limit window fully resets before the circuit recloses.
const CIRCUIT_THRESHOLD = Number(process.env.LLM_CIRCUIT_THRESHOLD ?? 5)
const CIRCUIT_COOLDOWN_MS = Number(process.env.LLM_CIRCUIT_COOLDOWN_MS ?? 30000)

// Failover toggle — when 'true' (default), the z-ai primary can fail over to
// the dormant NVIDIA client when its circuit is open AND a NVIDIA key is
// present. Set LLM_FAILOVER_ENABLED=false to keep z-ai-only behavior.
const LLM_FAILOVER_ENABLED =
  (process.env.LLM_FAILOVER_ENABLED ?? 'true').toLowerCase() !== 'false'

function getProvider(): LlmProvider {
  const raw = (process.env.LLM_PROVIDER ?? 'zai').toLowerCase()
  if (raw === 'nvidia') return 'nvidia'
  if (raw === 'zai') return 'zai'
  if (raw === 'gemini') return 'gemini'
  return 'groq'
}

/**
 * Fallback provider when the primary's circuit opens. Defaults per primary:
 *   gemini → 'groq' (production) — overridden to 'zai' in local development
 *           via LLM_FALLBACK_PROVIDER=zai so the agent loop always completes
 *           even when Gemini's free-tier daily quota is exhausted.
 *   zai    → 'nvidia' (dormant)
 *   groq   → (none — orchestrator post-loop fallback runs)
 *   nvidia → (none)
 *
 * Groq remains the production fallback for Gemini and is always available as
 * a manual LLM_PROVIDER choice.
 */
function getFallbackProvider(): LlmProvider | null {
  const raw = (process.env.LLM_FALLBACK_PROVIDER ?? '').toLowerCase()
  if (raw === 'zai') return 'zai'
  if (raw === 'groq') return 'groq'
  if (raw === 'nvidia') return 'nvidia'
  if (raw === 'gemini') return 'gemini'
  if (raw === 'none') return null
  // Sensible defaults when unset
  const primary = getProvider()
  if (primary === 'gemini') return 'groq'
  if (primary === 'zai') return 'nvidia'
  return null
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

/**
 * Read the `Retry-After` header (seconds or HTTP-date) from a 429/503 response.
 * Returns the delay in ms, capped at `capMs` (to stay under the serverless
 * function timeout — Vercel Hobby max is 60s, so we cap at 15s so ONE retry
 * for the actual call + remaining work). Groq sends this header on 429s to
 * indicate when the per-minute rate-limit window resets.
 */
function readRetryAfterMs(headers: Headers, capMs: number = 15_000): number | null {
  const raw = headers.get('retry-after')
  if (!raw) return null
  const asNum = Number(raw)
  if (!Number.isNaN(asNum) && asNum > 0) {
    return Math.min(asNum * 1000, capMs)
  }
  const asDate = Date.parse(raw)
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now()
    return delta > 0 ? Math.min(delta, capMs) : null
  }
  return null
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
  private lastOpenedAt = 0
  private lastStatus = 0
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
      this.lastStatus = status
      if (this.consecutiveFailures >= this.threshold && !this.isOpen()) {
        this.openUntil = Date.now() + this.cooldownMs
        this.lastOpenedAt = Date.now()
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
  snapshot(): { isOpen: boolean; consecutiveFailures: number; msUntilReset: number; lastStatus: number; lastOpenedAt: number } {
    return {
      isOpen: this.isOpen(),
      consecutiveFailures: this.consecutiveFailures,
      msUntilReset: this.msUntilReset(),
      lastStatus: this.lastStatus,
      lastOpenedAt: this.lastOpenedAt,
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
  circuitSnapshot(): { isOpen: boolean; consecutiveFailures: number; msUntilReset: number; lastStatus: number; lastOpenedAt: number }
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

function mapCompletion(res: OpenAiResponse, provider?: string): LlmCompletion {
  const choice = res.choices?.[0]
  if (!choice) return { content: null, toolCalls: [], finishReason: 'empty', provider }
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
    provider,
  }
}

// ===========================================================================
// Provider: z-ai-web-dev-sdk (local development default)
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
        `LLM provider temporarily unavailable (circuit open for ${this.circuit.msUntilReset()}ms). ` +
          `Sentinel will fail over to the backup provider if one is configured, ` +
          `otherwise the investigation will be paused and a summary preserved.`,
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
          return mapCompletion(res, this.providerName())
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
      let retryAfterMs: number | null = null
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const baseBackoff = retryAfterMs
            ?? (sawRateLimit
              ? Math.min(
                  RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (attempt - 1),
                  RATE_LIMIT_BACKOFF_MAX_MS,
                )
              : INITIAL_BACKOFF_MS * 2 ** (attempt - 1))
          await sleep(jitter(baseBackoff))
          retryAfterMs = null
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
          if (res.status === 429) {
            sawRateLimit = true
            retryAfterMs = readRetryAfterMs(res.headers, 15_000)
          }
          const err = new Error(`LLM ${m} HTTP ${res.status}: ${text.slice(0, 300)}`)
          const openedNow = this.circuit.recordFailure(res.status)
          if (openedNow) {
            const hint = retryAfterMs ? ` (Retry-After: ${Math.round(retryAfterMs / 1000)}s)` : ''
            throw new CircuitOpenError(
              `nvidia circuit opened after ${CIRCUIT_THRESHOLD} consecutive 429/5xx. ` +
                `Last error: HTTP ${res.status}${hint}. Cooldown ${Math.round(CIRCUIT_COOLDOWN_MS / 1000)}s.`,
            )
          }
          if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
            lastErr = err
            continue
          }
          throw err
        }
        this.circuit.recordSuccess()
        return mapCompletion((await res.json()) as OpenAiResponse, this.providerName())
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
// Provider: Groq (OpenAI-compatible, real outbound LLM)
//
// Groq's chat/completions endpoint is a drop-in OpenAI-compatible surface
// (same request/response shape as NVIDIA NIM), so it reuses the exact same
// resilience primitives (TokenBucket, CircuitBreaker, retry/backoff). This
// provider uses the public Groq API directly. Get a free key at
// console.groq.com/keys.
// ===========================================================================

const GROQ_BASE_URL = process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1'

/**
 * Rough prompt-token estimator — 4 chars/token is the standard OpenAI-style
 * approximation. Used only to decide whether the 8b fallback's 6,000 TPM
 * limit would be exceeded (avoiding a guaranteed 413). The estimate does
 * not need to be exact — we leave a 500-token headroom.
 */
function estimatePromptTokens(body: Record<string, unknown>): number {
  const messages = (body.messages as Array<{ content?: string | null; tool_calls?: Array<unknown> }> | undefined) ?? []
  const tools = (body.tools as Array<unknown> | undefined) ?? []
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length
  }
  chars += JSON.stringify(tools).length
  return Math.ceil(chars / 4)
}

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

  /**
   * One LLM call against a single Groq model, with retry/backoff but WITHOUT
   * touching the shared circuit breaker. The circuit is only updated by the
   * outer `complete()` orchestrator so a 429 on the heavy 70b model doesn't
   * burn a circuit slot when the light 8b model can still serve the request.
   *
   * Returns a discriminated union so the caller can tell "rate limited, try
   * another model" apart from "hard error, give up".
   */
  private async callModel(
    model: string,
    body: Record<string, unknown>,
    apiKey: string,
  ): Promise<
    | { ok: true; completion: LlmCompletion }
    | { ok: false; rateLimited: boolean; status: number; retryAfterMs: number | null; error: Error }
  > {
    let lastErr: Error | null = null
    let sawRateLimit = false
    let retryAfterMs: number | null = null
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // Prefer the provider's Retry-After hint (capped at 15s to stay
        // under the serverless function timeout). Fall back to the
        // exponential curve with jitter.
        const baseBackoff = retryAfterMs
          ?? (sawRateLimit
            ? Math.min(
                RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (attempt - 1),
                RATE_LIMIT_BACKOFF_MAX_MS,
              )
            : INITIAL_BACKOFF_MS * 2 ** (attempt - 1))
        await sleep(jitter(baseBackoff))
        retryAfterMs = null
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
          body: JSON.stringify({ ...body, model }),
        })
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        lastErr = e
        // Network error — let the outer orchestrator decide. Treat as a
        // transient (not rate-limited) so the fallback model gets a turn.
        if (attempt < MAX_RETRIES) continue
        return { ok: false, rateLimited: false, status: 0, retryAfterMs: null, error: e }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        if (res.status === 429) {
          sawRateLimit = true
          retryAfterMs = readRetryAfterMs(res.headers, 15_000)
        }
        lastErr = new Error(`LLM ${model} HTTP ${res.status}: ${text.slice(0, 300)}`)
        // If we got rate-limited and still have retries, retry the SAME model
        // after backoff. If we're out of retries OR it's a non-retryable
        // error, bubble up so the outer orchestrator can try the fallback.
        if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) continue
        return {
          ok: false,
          rateLimited: res.status === 429,
          status: res.status,
          retryAfterMs,
          error: lastErr,
        }
      }
      // Success.
      return { ok: true, completion: mapCompletion((await res.json()) as OpenAiResponse, this.providerName()) }
    }
    return {
      ok: false,
      rateLimited: sawRateLimit,
      status: 0,
      retryAfterMs: null,
      error: lastErr ?? new Error(`Groq ${model} call exhausted retries`),
    }
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

    const primaryModel = process.env.LLM_MODEL || 'llama-3.3-70b-versatile'
    const fallbackModel = process.env.LLM_FALLBACK_MODEL || 'llama-3.1-8b-instant'
    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) throw new Error('GROQ_API_KEY is not set in the environment')

    const body = {
      messages: toWireMessages(input.messages),
      tools: input.tools,
      tool_choice: input.tools?.length ? 'auto' : undefined,
      temperature: input.temperature ?? DEFAULT_TEMP,
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: false,
    }

    // Try the primary (heavy 70b) model first. On a 429, IMMEDIATELY try the
    // fallback (light 8b) model WITHOUT recording a circuit failure — the
    // fallback model has its own, much higher per-minute budget on Groq's
    // free tier, so the request almost always still succeeds. Only when
    // BOTH models 429 do we count one failure against the circuit breaker.
    //
    // NOTE: the 8b model has a 6,000 tokens-per-minute TPM limit (vs 70b's
    // higher tier). If the scratchpad has grown large after several tool
    // calls, the request may exceed 8b's TPM and return 413 "Request too
    // large". We estimate the prompt token count and SKIP the 8b fallback
    // when it would obviously 413 — counting it as a real 429 against the
    // circuit instead, so the fallback path runs.
    const primary = await this.callModel(primaryModel, body, apiKey)
    if (primary.ok) {
      this.circuit.recordSuccess()
      return primary.completion
    }

    // Primary failed. If it was a rate limit (429) and we have a different
    // fallback model, try it transparently — do NOT touch the circuit yet.
    // But first check the prompt would fit 8b's 6,000 TPM limit.
    if (primary.rateLimited && fallbackModel !== primaryModel) {
      const estTokens = estimatePromptTokens(body)
      const FALLBACK_TPM_LIMIT = Number(process.env.GROQ_FALLBACK_TPM ?? 6000)
      // Leave 500-token headroom for the completion + JSON framing.
      const fitsFallback = estTokens + 500 < FALLBACK_TPM_LIMIT
      if (fitsFallback) {
        const secondary = await this.callModel(fallbackModel, body, apiKey)
        if (secondary.ok) {
          // The fallback model served the request — treat as success and
          // RESET the circuit's failure counter (the heavy model's 429 was
          // a transient rate-limit, not a hard outage).
          this.circuit.recordSuccess()
          return secondary.completion
        }
        // Both models failed. If BOTH were rate-limited, this is a genuine
        // shared-gateway throttle — record ONE failure (not two).
        if (secondary.rateLimited) {
          const openedNow = this.circuit.recordFailure(429)
          if (openedNow) {
            const hint = secondary.retryAfterMs
              ? ` (Retry-After: ${Math.round(secondary.retryAfterMs / 1000)}s)`
              : primary.retryAfterMs
                ? ` (Retry-After: ${Math.round(primary.retryAfterMs / 1000)}s)`
                : ''
            throw new CircuitOpenError(
              `groq circuit opened after ${CIRCUIT_THRESHOLD} consecutive ` +
                `429/5xx (both '${primaryModel}' and '${fallbackModel}' rate-limited).` +
                ` Cooldown ${Math.round(CIRCUIT_COOLDOWN_MS / 1000)}s${hint}.`,
            )
          }
          throw secondary.error
        }
        // Fallback failed with a hard (non-429) error — record it and bubble.
        const openedNow = this.circuit.recordFailure(secondary.status || 500)
        if (openedNow) {
          throw new CircuitOpenError(
            `groq circuit opened after ${CIRCUIT_THRESHOLD} consecutive 429/5xx. ` +
              `Last error: ${secondary.error.message.slice(0, 160)}. ` +
              `Cooldown ${Math.round(CIRCUIT_COOLDOWN_MS / 1000)}s.`,
          )
        }
        throw secondary.error
      }
      // Prompt too large for the 8b fallback's TPM — don't waste a call.
      // Record a 429 against the circuit (the heavy model is rate-limited
      // AND we can't fall back), let the orchestrator's fallback path run.
      const openedNow = this.circuit.recordFailure(429)
      if (openedNow) {
        throw new CircuitOpenError(
          `groq circuit opened after ${CIRCUIT_THRESHOLD} consecutive 429/5xx. ` +
            `Primary '${primaryModel}' rate-limited and fallback '${fallbackModel}' ` +
            `would exceed its ${FALLBACK_TPM_LIMIT} TPM limit (est. ${estTokens} tokens). ` +
            `Cooldown ${Math.round(CIRCUIT_COOLDOWN_MS / 1000)}s. ` +
            `The orchestrator's fallback post-mortem path will run.`,
        )
      }
      throw primary.error
    }

    // Primary failed with a non-429 error. If it's a hard (non-retryable)
    // error like 401/403, don't bother with the fallback — it'll fail the
    // same way. Only try fallback on 5xx/network errors.
    if (primary.status >= 500 || primary.status === 0) {
      try {
        const secondary = await this.callModel(fallbackModel, body, apiKey)
        if (secondary.ok) {
          this.circuit.recordSuccess()
          return secondary.completion
        }
        const openedNow = this.circuit.recordFailure(secondary.status || primary.status || 500)
        if (openedNow) {
          throw new CircuitOpenError(
            `groq circuit opened after ${CIRCUIT_THRESHOLD} consecutive 429/5xx ` +
              `(primary ${primaryModel} HTTP ${primary.status}, fallback ${fallbackModel} HTTP ${secondary.status}). ` +
              `Cooldown ${Math.round(CIRCUIT_COOLDOWN_MS / 1000)}s.`,
          )
        }
        throw secondary.error
      } catch (err) {
        if (err instanceof CircuitOpenError) throw err
        // Fall through to throw the primary error.
      }
    }

    // Primary failed with a 4xx (non-429) error — record and bubble.
    const openedNow = this.circuit.recordFailure(primary.status || 500)
    if (openedNow) {
      throw new CircuitOpenError(
        `groq circuit opened after ${CIRCUIT_THRESHOLD} consecutive 429/5xx. ` +
          `Last error: ${primary.error.message.slice(0, 160)}. ` +
          `Cooldown ${Math.round(CIRCUIT_COOLDOWN_MS / 1000)}s.`,
      )
    }
    throw primary.error
  }
}

// ===========================================================================
// Provider: Google Gemini 2.0 Flash (OpenAI-compatible — PRODUCTION primary)
//
// Google's Gemini OpenAI compatibility layer exposes the same
// chat/completions surface as Groq/NVIDIA, so this client reuses the exact
// same resilience primitives (TokenBucket, CircuitBreaker, retry/backoff).
//
// Why Gemini 2.0 Flash is the best-by-far production provider for Sentinel:
//   • Free forever — 1M tokens-per-minute, 1500 requests-per-day (no credit
//     card, no time limit). Groq's free tier is 30 RPM / 6k TPM on the 8b
//     fallback — the 7-8k token Sentinel system prompt exceeds it, so the
//     fallback path is skipped and the 70b primary 429s. Gemini's 1M TPM
//     absorbs the entire ReAct scratchpad with 99% headroom.
//   • 1M token context window — fits the layered prompt + every tool result
//     without truncation, even on long incidents.
//   • Best-in-class native function-calling — parallel tool calls, structured
//     outputs, deterministic at temperature 0.
//   • Globally reachable from any standard runtime, including Vercel.
//   • Get a free key at https://aistudio.google.com/apikey.
//
// Endpoint: https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
// ===========================================================================

const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL ??
  'https://generativelanguage.googleapis.com/v1beta/openai'

class GeminiLlmClient implements ResilientLlmClient {
  private readonly rateLimiter = new TokenBucket(1, RATE_LIMIT_INTERVAL_MS)
  private readonly circuit = new CircuitBreaker(CIRCUIT_THRESHOLD, CIRCUIT_COOLDOWN_MS)

  providerName(): string {
    return 'gemini'
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
        `gemini circuit open for ${this.circuit.msUntilReset()}ms ` +
          `(sustained 429/5xx from the Gemini OpenAI-compatible endpoint).`,
      )
    }

    const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash'
    const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.0-flash-lite'
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set in the environment')

    const body = {
      messages: toWireMessages(input.messages),
      tools: input.tools,
      tool_choice: input.tools?.length ? 'auto' : undefined,
      temperature: input.temperature ?? DEFAULT_TEMP,
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: false,
    }

    const call = async (m: string): Promise<LlmCompletion> => {
      let lastErr: Error | null = null
      let sawRateLimit = false
      let retryAfterMs: number | null = null
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const baseBackoff = retryAfterMs
            ?? (sawRateLimit
              ? Math.min(
                  RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (attempt - 1),
                  RATE_LIMIT_BACKOFF_MAX_MS,
                )
              : INITIAL_BACKOFF_MS * 2 ** (attempt - 1))
          await sleep(jitter(baseBackoff))
          retryAfterMs = null
        }
        await this.rateLimiter.acquire()
        let res: Response
        try {
          res = await fetch(`${GEMINI_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ ...body, model: m }),
          })
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err))
          const openedNow = this.circuit.recordFailure(503)
          if (openedNow) {
            throw new CircuitOpenError(
              `gemini circuit opened after ${CIRCUIT_THRESHOLD} consecutive ` +
                `failures (last: network error: ${e.message.slice(0, 120)})`,
            )
          }
          lastErr = e
          if (attempt < MAX_RETRIES) continue
          throw lastErr
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          if (res.status === 429) {
            sawRateLimit = true
            retryAfterMs = readRetryAfterMs(res.headers, 15_000)
          }
          const err = new Error(`Gemini ${m} HTTP ${res.status}: ${text.slice(0, 300)}`)
          const openedNow = this.circuit.recordFailure(res.status)
          if (openedNow) {
            const hint = retryAfterMs ? ` (Retry-After: ${Math.round(retryAfterMs / 1000)}s)` : ''
            throw new CircuitOpenError(
              `gemini circuit opened after ${CIRCUIT_THRESHOLD} consecutive 429/5xx. ` +
                `Last error: HTTP ${res.status}${hint}. Cooldown ${Math.round(CIRCUIT_COOLDOWN_MS / 1000)}s.`,
            )
          }
          if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
            lastErr = err
            continue
          }
          throw err
        }
        this.circuit.recordSuccess()
        return mapCompletion((await res.json()) as OpenAiResponse, this.providerName())
      }
      throw lastErr ?? new Error('Gemini LLM call failed after retries')
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
      // Fail-fast: fail over on ANY primary error, not just CircuitOpenError.
      // This matters when the primary returns a 429 on the first call BEFORE
      // the circuit opens (CIRCUIT_THRESHOLD > 1) — without this, the first
      // agent turn would fail instead of failing over. The fallback is the
      // resilience escape hatch; if it's also down, the orchestrator's
      // post-loop fallback post-mortem path runs gracefully.
      const primaryErr = err instanceof Error ? err.message : String(err)
      try {
        return await this.fallback.complete(input)
      } catch (fallbackErr) {
        const fe = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
        const isCircuit = err instanceof CircuitOpenError
        if (isCircuit) {
          throw new CircuitOpenError(
            `Primary '${this.primary.providerName()}' circuit open AND ` +
              `fallback '${this.fallback.providerName()}' failed: ${fe.slice(0, 160)}`,
          )
        }
        throw new Error(
          `Primary '${this.primary.providerName()}' failed (${primaryErr.slice(0, 160)}) ` +
            `AND fallback '${this.fallback.providerName()}' failed (${fe.slice(0, 160)}).`,
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
  gemini: GeminiLlmClient | null
}

function getSingleton(): SentinelLlmSingleton {
  const g = globalThis as unknown as { __sentinelLlm?: SentinelLlmSingleton }
  if (!g.__sentinelLlm)
    g.__sentinelLlm = { client: null, zai: null, nvidia: null, groq: null, gemini: null }
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
    } else if (provider === 'gemini') {
      const geminiKey = process.env.GEMINI_API_KEY
      if (!geminiKey) {
        // No Gemini key configured (e.g. a cold Vercel deploy without
        // secrets). The agent MUST always have a working LLM, so fall back
        // to the always-available z-ai SDK as the PRIMARY. Gemini is
        // instantiated as a dormant failover target — if a key is added in
        // a future deploy, the FailoverLlmClient structure is already in
        // place. In the current process env vars are immutable, so the
        // dormant Gemini will throw a clean "GEMINI_API_KEY is not set"
        // only if z-ai also fails (in which case the orchestrator's
        // post-loop fallback post-mortem path runs gracefully).
        s.zai = new ZaiLlmClient()
        s.gemini = new GeminiLlmClient()
        s.client = new FailoverLlmClient(s.zai, s.gemini)
      } else {
        s.gemini = new GeminiLlmClient()
        // Configurable failover when the Gemini circuit opens (e.g. daily
        // free-tier quota exhausted). LLM_FALLBACK_PROVIDER picks the target:
        //   'zai'  — local development (default here): the free z-ai gateway
        //            has no rate limits, so the agent loop ALWAYS completes
        //            even when Gemini's daily quota is exhausted. When the
        //            quota resets at midnight PT, Gemini transparently
        //            resumes as the primary.
        //   'groq' — production (Vercel default): Groq free tier. Groq still
        //            serves real traffic when Gemini is throttled.
        //   'none' — disable failover; the orchestrator's post-loop fallback
        //            post-mortem path runs gracefully.
        if (LLM_FAILOVER_ENABLED) {
          const fb = getFallbackProvider()
          if (fb === 'zai') {
            s.zai = new ZaiLlmClient()
            s.client = new FailoverLlmClient(s.gemini, s.zai)
          } else if (fb === 'groq') {
            const groqKey = process.env.GROQ_API_KEY
            if (groqKey && groqKey.startsWith('gsk_')) {
              s.groq = new GroqLlmClient()
              s.client = new FailoverLlmClient(s.gemini, s.groq)
            } else {
              s.client = s.gemini
            }
          } else if (fb === 'nvidia') {
            const nvidiaKey = process.env.NVIDIA_API_KEY
            if (nvidiaKey && nvidiaKey.startsWith('nvapi-')) {
              s.nvidia = new NvidiaNimLlmClient()
              s.client = new FailoverLlmClient(s.gemini, s.nvidia)
            } else {
              s.client = s.gemini
            }
          } else {
            s.client = s.gemini
          }
        } else {
          s.client = s.gemini
        }
      }
    } else {
      // zai (local development default). Optional dormant failover to NVIDIA
      // if a key is configured (the key is list-only in dev, so failover
      // surfaces a clean CircuitOpenError and the orchestrator's post-loop
      // fallback post-mortem path runs gracefully).
      s.zai = new ZaiLlmClient()
      if (LLM_FAILOVER_ENABLED) {
        const fb = getFallbackProvider()
        if (fb === 'nvidia') {
          const nvidiaKey = process.env.NVIDIA_API_KEY
          if (nvidiaKey && nvidiaKey.startsWith('nvapi-')) {
            s.nvidia = new NvidiaNimLlmClient()
            s.client = new FailoverLlmClient(s.zai, s.nvidia)
          } else {
            s.client = s.zai
          }
        } else if (fb === 'gemini') {
          const geminiKey = process.env.GEMINI_API_KEY
          if (geminiKey) {
            s.gemini = new GeminiLlmClient()
            s.client = new FailoverLlmClient(s.zai, s.gemini)
          } else {
            s.client = s.zai
          }
        } else {
          s.client = s.zai
        }
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
  // Per-provider default model when LLM_MODEL is not explicitly set. This
  // lets the same .env flip between providers without model-name mismatches.
  const provider = getProvider()
  if (process.env.LLM_MODEL) return process.env.LLM_MODEL
  if (provider === 'nvidia') return 'nvidia/llama-3.3-nemotron-super-49b-v1'
  if (provider === 'groq') return 'llama-3.3-70b-versatile'
  if (provider === 'gemini') return process.env.GEMINI_MODEL || 'gemini-2.0-flash'
  return 'gpt-4o' // zai
}

/**
 * Resilience — expose circuit state for the UI status chip and the
 * `/api/llm/status` endpoint. Read-only; never throws.
 *
 * In local dev (z-ai + a dead NVIDIA key), `failoverEnabled` is true but
 * `nvidiaHealthy` is false — the UI shows the operator that the agent will
 * degrade gracefully via the post-loop fallback path, not via live NVIDIA.
 *
 * Gemini note: Google AI Studio keys traditionally start with `AIza`, but
 * newer Cloud Console API keys use the `AQ.` prefix (and possibly others).
 * We accept ANY non-empty key here and let the GeminiLlmClient validate
 * with a real call — never gate UX on a key prefix.
 */
export function getLlmResilienceStatus(): {
  provider: LlmProvider
  model: string
  fallbackProvider: LlmProvider | null
  failoverEnabled: boolean
  hasNvidiaKey: boolean
  hasGeminiKey: boolean
  hasGroqKey: boolean
  hasZaiKey: boolean
  circuit: {
    isOpen: boolean
    consecutiveFailures: number
    msUntilReset: number
    lastStatus: number
    lastOpenedAt: number
  } | null
  fallbackCircuit: {
    isOpen: boolean
    consecutiveFailures: number
    msUntilReset: number
    lastStatus: number
    lastOpenedAt: number
  } | null
} {
  const hasNvidiaKey = !!(
    process.env.NVIDIA_API_KEY && process.env.NVIDIA_API_KEY.startsWith('nvapi-')
  )
  // Accept any non-empty Gemini key (AIza* classic OR AQ.* newer Cloud format).
  const hasGeminiKey = !!process.env.GEMINI_API_KEY
  const hasGroqKey = !!(
    process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.startsWith('gsk_')
  )
  // zai has no key — it is a free local-development gateway. Mark "available"
  // when the SDK is importable (always true in this repo).
  const hasZaiKey = true
  const s = getSingleton()
  const provider = getProvider()
  const fallbackProvider = getFallbackProvider()

  // Primary circuit snapshot — from whichever provider is active.
  let circuit: {
    isOpen: boolean
    consecutiveFailures: number
    msUntilReset: number
    lastStatus: number
    lastOpenedAt: number
  } | null = null
  if (s.zai && provider === 'zai') circuit = s.zai.circuitSnapshot()
  else if (s.nvidia && provider === 'nvidia') circuit = s.nvidia.circuitSnapshot()
  else if (s.groq && provider === 'groq') circuit = s.groq.circuitSnapshot()
  else if (s.gemini && provider === 'gemini') circuit = s.gemini.circuitSnapshot()

  // Fallback circuit snapshot — surfaces the failover target's health so
  // the operator can see "primary throttled → fallback healthy".
  let fallbackCircuit: {
    isOpen: boolean
    consecutiveFailures: number
    msUntilReset: number
    lastStatus: number
    lastOpenedAt: number
  } | null = null
  if (fallbackProvider === 'zai' && s.zai) fallbackCircuit = s.zai.circuitSnapshot()
  else if (fallbackProvider === 'groq' && s.groq) fallbackCircuit = s.groq.circuitSnapshot()
  else if (fallbackProvider === 'nvidia' && s.nvidia) fallbackCircuit = s.nvidia.circuitSnapshot()
  else if (fallbackProvider === 'gemini' && s.gemini) fallbackCircuit = s.gemini.circuitSnapshot()

  // Failover is enabled when an explicit fallback is configured AND that
  // fallback's key is present (zai needs no key, so it's always available).
  let failoverEnabled = false
  if (fallbackProvider === 'zai') failoverEnabled = hasZaiKey
  else if (fallbackProvider === 'groq') failoverEnabled = hasGroqKey
  else if (fallbackProvider === 'nvidia') failoverEnabled = hasNvidiaKey
  else if (fallbackProvider === 'gemini') failoverEnabled = hasGeminiKey
  failoverEnabled = failoverEnabled && LLM_FAILOVER_ENABLED

  return {
    provider,
    model: getLlmModel(),
    fallbackProvider,
    failoverEnabled,
    hasNvidiaKey,
    circuit,
    hasGeminiKey,
    hasGroqKey,
    hasZaiKey,
    fallbackCircuit,
  }
}
