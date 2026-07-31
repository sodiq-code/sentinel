// =============================================================================
// Sentinel — System-prompt assembler (layered prompt architecture)
//
// Assembles the four layered prompt files (role.md, workflow.md,
// governance.md, tools.md) into the single system message the orchestrator
// sends to the LLM. The layers are separated by a visible `---` fence so the
// agent can cite which layer a rule came from.
//
// The .md files are the canonical, versioned source ("committed
// to repo, versioned"). This module reads them at runtime from
// `<cwd>/src/lib/agent/prompts/` so the repo's .md files are always the live
// prompt in local dev. On Vercel the serverless function filesystem is
// read-only and has no src/ tree, so we fall back to the bundled inlined
// copies in _inline.ts (regenerated from the .md files at build time).
// A read failure NEVER crashes a run — the inlined copy always exists.
// =============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROMPT_LAYERS_INLINE } from './_inline'

const PROMPTS_DIR = join(process.cwd(), 'src', 'lib', 'agent', 'prompts')

/** Bumped when a prompt layer materially changes — emitted in the system message. */
export const PROMPT_VERSION = 'sentinel-v2.3'

function readLayer(name: string): string {
  // 1) Try the live .md file from disk (local dev — the canonical source).
  try {
    return readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8').trimEnd()
  } catch {
    // File missing or unreadable (e.g. Vercel serverless — no src/ tree).
    // Fall through to the bundled inlined copy.
  }
  // 2) Bundled fallback — always present, regenerated from the .md files.
  const inlined = PROMPT_LAYERS_INLINE[name]
  if (inlined) return inlined.trimEnd()
  // Should never happen — every layer is in _inline.ts.
  throw new Error(
    `Sentinel system-prompt: could not load layer '${name}' from disk or inline bundle.`,
  )
}

export interface SystemPromptParts {
  role: string
  workflow: string
  governance: string
  tools: string
  version: string
}

/** Read each layer. Called once per orchestrator run (cheap; small files). */
export function loadPromptParts(): SystemPromptParts {
  return {
    role: readLayer('role'),
    workflow: readLayer('workflow'),
    governance: readLayer('governance'),
    tools: readLayer('tools'),
    version: PROMPT_VERSION,
  }
}

/** Assemble the layered system message. Layers joined with `---`. */
export function assembleSystemPrompt(): string {
  const p = loadPromptParts()
  return [
    `# Sentinel — System prompt (${p.version})`,
    '',
    '---',
    '',
    p.role,
    '',
    '---',
    '',
    p.workflow,
    '',
    '---',
    '',
    p.governance,
    '',
    '---',
    '',
    p.tools,
  ].join('\n')
}
