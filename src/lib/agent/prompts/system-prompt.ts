// =============================================================================
// Sentinel — System-prompt assembler (PDF §9.4.4 layered prompt architecture)
//
// Assembles the four layered prompt files (role.md, workflow.md,
// governance.md, tools.md) into the single system message the orchestrator
// sends to the LLM. The layers are separated by a visible `---` fence so the
// agent can cite which layer a rule came from.
//
// The .md files are the canonical, versioned source (PDF §10.2: "committed
// to repo, versioned"). This module reads them at runtime from
// `<cwd>/src/lib/agent/prompts/` so the repo's .md files are always the live
// prompt. A read failure throws — fail-fast, never silently fall back to a
// stale prompt.
// =============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PROMPTS_DIR = join(process.cwd(), 'src', 'lib', 'agent', 'prompts')

/** Bumped when a prompt layer materially changes — emitted in the system message. */
export const PROMPT_VERSION = 'sentinel-v2-phase3-1'

function readLayer(name: string): string {
  try {
    return readFileSync(join(PROMPTS_DIR, name), 'utf8').trimEnd()
  } catch (err) {
    throw new Error(
      `Sentinel system-prompt: could not read layer '${name}' from ${PROMPTS_DIR}. ` +
        `Ensure the prompt files are committed. Cause: ${(err as Error).message}`,
    )
  }
}

export interface SystemPromptParts {
  role: string
  workflow: string
  governance: string
  tools: string
  version: string
}

/** Read each layer from disk. Called once per orchestrator run (cheap; small files). */
export function loadPromptParts(): SystemPromptParts {
  return {
    role: readLayer('role.md'),
    workflow: readLayer('workflow.md'),
    governance: readLayer('governance.md'),
    tools: readLayer('tools.md'),
    version: PROMPT_VERSION,
  }
}

/** Assemble the layered system message. PDF §9.4.4: layers joined with `---`. */
export function assembleSystemPrompt(): string {
  const p = loadPromptParts()
  return [
    `# Sentinel — System prompt (${p.version})`,
    '',
    '---',
    p.role,
    '---',
    p.workflow,
    '---',
    p.governance,
    '---',
    p.tools,
  ].join('\n')
}

export { PROMPTS_DIR }
