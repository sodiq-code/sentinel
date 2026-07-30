// GET /api/test-groq — minimal proof that the Groq provider works.
// Calls GroqLlmClient directly with a simple prompt, returns the raw
// completion + token usage. No DB, no orchestrator — just the LLM call.
// This proves the GROQ_API_KEY works from Vercel's US region (where
// serverless functions run), bypassing the geo-block that affects some
// non-US build environments.

import { NextResponse } from 'next/server'
import { getLlm } from '@/lib/agent/llm'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET() {
  const start = Date.now()
  try {
    const client = getLlm()
    const response = await client.complete({
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Reply concisely.' },
        { role: 'user', content: 'Say "Groq is working" and nothing else.' },
      ],
      tools: [],
      maxTokens: 50,
    })
    return NextResponse.json({
      ok: true,
      provider: 'groq',
      model: process.env.LLM_MODEL ?? 'llama-3.3-70b-versatile',
      content: response.content,
      usage: response.usage,
      finishReason: response.finishReason,
      latencyMs: Date.now() - start,
    })
  } catch (err) {
    const message = (err as Error).message ?? String(err)
    return NextResponse.json(
      {
        ok: false,
        provider: 'groq',
        error: message,
        latencyMs: Date.now() - start,
      },
      { status: 200 },
    )
  }
}
