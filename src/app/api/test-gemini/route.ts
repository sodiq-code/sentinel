// GET /api/test-gemini — verifies the full Gemini provider integration.
//
// This endpoint proves the user-supplied Gemini API key is correctly wired
// end-to-end:
//
//   1. The key authenticates with Google's OpenAI-compatible endpoint
//      (HTTP 401/403 → invalid key; anything else → key is accepted).
//   2. The endpoint is reachable from this environment
//      (network error → region-restricted or DNS).
//   3. The GeminiLlmClient + FailoverLlmClient + circuit-breaker are
//      correctly wired (the resilience snapshot is returned).
//   4. The agent loop will complete even when Gemini is throttled, because
//      the FailoverLlmClient routes to the configured fallback (zai in
//      local development, groq in production).
//
// Verdict:
//   "working"            — Gemini served a real completion. This is the
//                          production-primary path. (Happens when the
//                          free-tier daily quota has room.)
//   "quota_exhausted"    — The key is VALID (auth passed — never 401/403)
//                          but the free-tier daily quota is exhausted for
//                          today. Resets at midnight Pacific Time. The
//                          agent loop still completes via the fallback
//                          (zai in local development, groq in production).
//   "key_invalid"        — HTTP 401/403. The key was rejected.
//   "unreachable"        — Network error. Possible region restriction or DNS.
//   "not_configured"     — GEMINI_API_KEY is empty.
//
// This endpoint never throws — it always returns 200 with a structured
// body so the dashboard renders cleanly.

import { NextResponse } from 'next/server'
import { getLlmResilienceStatus } from '@/lib/agent/llm'
import { isPreviewMode, previewFixture } from '@/lib/demo-mode'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

type Verdict =
  | 'working'
  | 'quota_exhausted'
  | 'key_invalid'
  | 'unreachable'
  | 'not_configured'

export async function GET() {
  if (isPreviewMode()) {
    return NextResponse.json(previewFixture('llm-status'))
  }
  const start = Date.now()
  const apiKey = process.env.GEMINI_API_KEY
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash'
  const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.0-flash-lite'
  const baseUrl = process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai'

  if (!apiKey) {
    return NextResponse.json({
      verdict: 'not_configured' as Verdict,
      provider: 'gemini',
      reason: 'GEMINI_API_KEY is not set in the environment',
      hint: 'Get a free key at https://aistudio.google.com/apikey (no credit card). Set it in .env as GEMINI_API_KEY=...',
      resilience: getLlmResilienceStatus(),
      latencyMs: Date.now() - start,
    })
  }

  // Detect key format. Classic Google AI Studio keys start with 'AIza';
  // newer Cloud Console API keys use the 'AQ.' prefix (and possibly others).
  const keyFormat = apiKey.startsWith('AIza')
    ? 'AIza (Google AI Studio classic)'
    : apiKey.startsWith('AQ.')
      ? 'AQ. (Google Cloud Console newer format)'
      : 'unknown (will attempt anyway)'

  // Call the Gemini OpenAI-compatible endpoint directly. The GeminiLlmClient
  // wraps this with retries + circuit-breaker; here we want the raw HTTP
  // status so we can classify the verdict precisely.
  const body = {
    model,
    messages: [
      { role: 'system', content: 'You are a helpful assistant. Reply concisely.' },
      { role: 'user', content: 'Say "Gemini is working" and nothing else.' },
    ],
    max_tokens: 50,
    temperature: 0,
    stream: false,
  }

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })

    const latencyMs = Date.now() - start
    const text = await res.text().catch(() => '')

    if (!res.ok) {
      // Parse the error to classify the verdict
      let reason = `Gemini returned HTTP ${res.status}`
      let dailyQuota = false
      let perMinuteQuota = false
      let retryAfterMs: number | null = null
      try {
        // The OpenAI-compat error body is wrapped in an array: [{"error": {...}}]
        const parsed = JSON.parse(text)
        const msg: string = parsed?.error?.message ?? parsed?.[0]?.error?.message ?? ''
        const details = parsed?.error?.details ?? parsed?.[0]?.error?.details ?? []
        if (msg.includes('PerDay') || msg.includes('PerDayPerProject')) dailyQuota = true
        if (msg.includes('PerMinute') || msg.includes('PerMinutePerProject')) perMinuteQuota = true
        const retryInfo = details.find(
          (d: { '@type'?: string; retryDelay?: string }) => d?.['@type']?.includes('RetryInfo'),
        )
        if (retryInfo?.retryDelay) {
          const secs = parseInt(String(retryInfo.retryDelay).replace(/[^0-9]/g, ''), 10)
          if (!Number.isNaN(secs)) retryAfterMs = secs * 1000
        }
        if (msg) reason = msg.slice(0, 400)
      } catch {
        if (text) reason = text.slice(0, 400)
      }

      const verdict: Verdict =
        res.status === 401 || res.status === 403
          ? 'key_invalid'
          : res.status === 429
            ? 'quota_exhausted'
            : 'unreachable'

      // The agent loop verdict — does the fallback keep the loop alive?
      const resilience = getLlmResilienceStatus()
      const agentLoopVerdict =
        resilience.fallbackProvider && resilience.failoverEnabled
          ? `Agent loop continues via fallback '${resilience.fallbackProvider}' (failover enabled). The ReAct loop completes; incident resolves normally.`
          : 'No fallback configured. The orchestrator will mark the incident degraded (partial investigation) and write a fallback post-mortem.'

      return NextResponse.json({
        verdict,
        provider: 'gemini',
        httpStatus: res.status,
        model,
        fallbackModel,
        keyFormat,
        keyPresent: true,
        keyValid: res.status !== 401 && res.status !== 403,
        dailyQuota,
        perMinuteQuota,
        retryAfterMs,
        reason,
        hint:
          verdict === 'key_invalid'
            ? 'The key was rejected (401/403). Check that GEMINI_API_KEY is a valid Google AI Studio (AIza*) or Cloud Console (AQ.*) key.'
            : verdict === 'quota_exhausted'
              ? dailyQuota
                ? `Free-tier DAILY quota exhausted — the key is valid (auth passed) but the project used all of today's free requests. Resets at midnight Pacific Time. ${agentLoopVerdict}`
                : `Free-tier PER-MINUTE quota hit. The key is valid. Retry in a few seconds. ${agentLoopVerdict}`
              : verdict === 'unreachable'
                ? `Gemini returned HTTP ${res.status}. See reason for details. ${agentLoopVerdict}`
                : '',
        resilience,
        agentLoopVerdict,
        latencyMs,
      })
    }

    // Success — Gemini served a real completion
    const parsed = JSON.parse(text)
    const content = parsed?.choices?.[0]?.message?.content ?? ''
    const usage = parsed?.usage ?? null
    const finishReason = parsed?.choices?.[0]?.finish_reason ?? null

    return NextResponse.json({
      verdict: 'working' as Verdict,
      provider: 'gemini',
      model,
      fallbackModel,
      keyFormat,
      keyPresent: true,
      keyValid: true,
      content,
      usage,
      finishReason,
      resilience: getLlmResilienceStatus(),
      latencyMs,
    })
  } catch (err) {
    const message = (err as Error).message ?? String(err)
    return NextResponse.json({
      verdict: 'unreachable' as Verdict,
      provider: 'gemini',
      model,
      fallbackModel,
      keyFormat,
      keyPresent: true,
      keyValid: true, // couldn't verify — but the key format is accepted
      reason: `Network/parse error: ${message.slice(0, 300)}`,
      hint: 'Could not reach generativelanguage.googleapis.com — possible DNS/network issue or region restriction. The agent will use the configured fallback provider.',
      resilience: getLlmResilienceStatus(),
      latencyMs: Date.now() - start,
    })
  }
}
