// =============================================================================
// Sentinel — LLM client
//
// PDF §10.2: one LLM provider, temperature 0, deterministic.
// PDF §9.5.4: retries with exponential backoff on any failure.
//
// Provider selection (LLM_PROVIDER env, default 'zai'):
//
//   zai     — z-ai-web-dev-sdk gateway (DEFAULT). Works inside the build sandbox
//             where direct outbound to integrate.api.nvidia.com is blocked
//             (HTTP 403). Verified to support OpenAI-style tool-calling +
//             multi-turn role:'tool' messages + parallel tool_calls. This is
//             the provider the live demo runs on.
//
//   nvidia  — direct NVIDIA NIM OpenAI-compatible endpoint
//             (https://integrate.api.nvidia.com/v1). PRIMARY model
//             nvidia/llama-3.3-nemotron-super-49b-v1 (parallel tool-calling),
//             FALLBACK openai/gpt-oss-120b. Selected when a valid NVIDIA key is
//             present in a non-sandboxed deployment. Kept as an alternative
//             so the same orchestrator runs against real NVIDIA hardware.
//
// Both providers expose the same OpenAI-compatible `chat/completions` surface,
// so the orchestrator is provider-agnostic. The fallback model is swapped in
// only after the primary exhausts retries on a retryable error.
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

export type LlmProvider = 'zai' | 'nvidia'

const DEFAULT_TEMP = Number(process.env.LLM_TEMPERATURE ?? 0)
const DEFAULT_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 1500)
const MAX_RETRIES = 3
const INITIAL_BACKOFF_MS = 800

function getProvider(): LlmProvider {
  const raw = (process.env.LLM_PROVIDER ?? 'zai').toLowerCase()
  return raw === 'nvidia' ? 'nvidia' : 'zai'
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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
// Provider: z-ai-web-dev-sdk (DEFAULT — works in-sandbox)
// ===========================================================================

class ZaiLlmClient implements LlmClient {
  private zaiPromise: Promise<InstanceType<typeof ZAI>> | null = null
  private async zai(): Promise<InstanceType<typeof ZAI>> {
    if (!this.zaiPromise) this.zaiPromise = ZAI.create()
    return this.zaiPromise
  }

  async complete(input: {
    messages: LlmMessage[]
    tools?: LlmTool[]
    temperature?: number
    maxTokens?: number
  }): Promise<LlmCompletion> {
    const model = process.env.LLM_MODEL || 'gpt-4o'
    const fallbackModel = process.env.LLM_FALLBACK_MODEL || 'gpt-4o-mini'
    const zai = await this.zai()

    const call = async (m: string): Promise<LlmCompletion> => {
      let lastErr: Error | null = null
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) await sleep(INITIAL_BACKOFF_MS * 2 ** (attempt - 1))
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
          return mapCompletion(res)
        } catch (err) {
          const e = err as { status?: number; statusCode?: number; message?: string }
          const status = e.status ?? e.statusCode ?? 0
          const msg = e.message ?? String(err)
          lastErr = new Error(`z-ai LLM (model ${m}) failed: ${msg}`)
          // Retry on 429/5xx or network errors; otherwise throw.
          if ((status && isRetryableStatus(status)) || /network|fetch|ECONN|ETIMEDOUT|timeout/i.test(msg)) {
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
      if (model === fallbackModel) throw primaryErr
      // Fallback model attempt.
      try {
        return await call(fallbackModel)
      } catch (fallbackErr) {
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
// Kept for non-sandboxed deployments where the NVIDIA key is valid.
// ===========================================================================

const NVIDIA_BASE_URL = process.env.LLM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1'

class NvidiaNimLlmClient implements LlmClient {
  async complete(input: {
    messages: LlmMessage[]
    tools?: LlmTool[]
    temperature?: number
    maxTokens?: number
  }): Promise<LlmCompletion> {
    const model = process.env.LLM_MODEL || 'nvidia/llama-3.3-nemotron-super-49b-v1'
    const fallbackModel = process.env.LLM_FALLBACK_MODEL || 'openai/gpt-oss-120b'
    const apiKey = process.env.NVIDIA_API_KEY
    if (!apiKey) throw new Error('NVIDIA_API_KEY is not set in the environment')

    const call = async (m: string): Promise<LlmCompletion> => {
      const body = {
        model: m,
        messages: input.messages,
        tools: input.tools,
        tool_choice: input.tools?.length ? 'auto' : undefined,
        temperature: input.temperature ?? DEFAULT_TEMP,
        max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: false,
      }
      let lastErr: Error | null = null
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) await sleep(INITIAL_BACKOFF_MS * 2 ** (attempt - 1))
        try {
          const res = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(body),
          })
          if (!res.ok) {
            const text = await res.text().catch(() => '')
            const err = new Error(`LLM ${m} HTTP ${res.status}: ${text.slice(0, 300)}`)
            if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
              lastErr = err
              continue
            }
            throw err
          }
          return mapCompletion((await res.json()) as OpenAiResponse)
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') throw err
          lastErr = err instanceof Error ? err : new Error(String(err))
          if (attempt < MAX_RETRIES) continue
          throw lastErr
        }
      }
      throw lastErr ?? new Error('NVIDIA LLM call failed after retries')
    }

    try {
      return await call(model)
    } catch (primaryErr) {
      if (model === fallbackModel) throw primaryErr
      try {
        return await call(fallbackModel)
      } catch (fallbackErr) {
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

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _client: LlmClient | null = null
export function getLlm(): LlmClient {
  if (!_client) {
    _client = getProvider() === 'nvidia' ? new NvidiaNimLlmClient() : new ZaiLlmClient()
  }
  return _client
}

export function getLlmProvider(): LlmProvider {
  return getProvider()
}

export function getLlmModel(): string {
  return process.env.LLM_MODEL || (getProvider() === 'nvidia'
    ? 'nvidia/llama-3.3-nemotron-super-49b-v1'
    : 'gpt-4o')
}
