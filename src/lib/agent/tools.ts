// =============================================================================
// Sentinel — Tool registry
//
// Maps the LLM's `tool_calls` to executable functions backed by the three
// DataHub client interfaces (mcp / contextKit / ingestion) + the Phase 3
// action connectors (github / slack). PDF §12.3: tool-call inputs are
// structured JSON validated against a schema — never free-text execution —
// so a malicious DataHub doc cannot inject a tool call.
//
// Catalogue (Phase 3):
//   mcp.*     — 9 read tools (DataHub MCP Server)
//   ack.*     — 6 write tools (Agent Context Kit) — post-mortem is a direct
//               write, glossary/ownership/tags/description are proposals
//   action.*  — 3 action tools (Phase 3): github_open_issue, github_open_pr
//               (NEVER merges), slack_post_triage. All call the real
//               connectors against the demo repo / channel. SENTINEL_DRY_RUN
//               flips them to the trace log.
//
// Every tool call is recorded to the ToolCall table (PDF §9.4.3) and the audit
// trail. Action tools additionally record an Action row (status: executed /
// refused). Write tools additionally record a WriteBack row.
//
// GUARDRAIL (Phase 3): the orchestrator calls `checkBeforeExecute` from
// src/lib/guardrail BEFORE every action.* + ack.save_document call. The hook
// can refuse (PII) or surface an approval gate (ownership/glossary proposals).
// See src/lib/guardrail/pre-exec.ts.
// =============================================================================

import { db } from '@/lib/db'
import type { DataHubClients } from '@/lib/datahub/types'
import { openIssue as ghOpenIssue, openPR as ghOpenPR } from '@/lib/connectors/github'
import { postTriage as slackPostTriage } from '@/lib/connectors/slack'
import type { LlmTool, LlmToolCall } from './types'
import { getAudit } from './audit'
import { writeBackDocument } from './writeback'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolContext {
  clients: DataHubClients
  incidentUrn: string
  dryRun: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown> // OpenAI function `parameters` JSON schema
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>
}

export interface ToolExecResult {
  result: unknown
  status: 'ok' | 'error'
  durationMs: number
  error?: string
}

// ---------------------------------------------------------------------------
// Helpers — arg coercion + result truncation (protect the LLM context window)
// ---------------------------------------------------------------------------

function asString(v: unknown, dflt?: string): string {
  return typeof v === 'string' ? v : v == null ? (dflt ?? '') : String(v)
}
function asNumber(v: unknown, dflt?: number): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : []
}
function asRecordArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : []
}
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

const RESULT_BUDGET = 900
function truncate(result: unknown): unknown {
  const json = JSON.stringify(result)
  if (json.length <= RESULT_BUDGET) return result
  return {
    __truncated: true,
    preview: json.slice(0, RESULT_BUDGET),
    fullLength: json.length,
  }
}

// ---------------------------------------------------------------------------
// Record a ToolCall row (PDF §9.4.3) — every tool call is persisted, win or
// fail, so the audit trail is complete.
// ---------------------------------------------------------------------------

async function recordToolCall(input: {
  incidentUrn: string
  tool: string
  args: Record<string, unknown>
  result: unknown
  status: 'ok' | 'error' | 'retrying'
  durationMs: number
  error?: string
}): Promise<void> {
  await db.toolCall.create({
    data: {
      incidentUrn: input.incidentUrn,
      tool: input.tool,
      argsJson: JSON.stringify(input.args),
      resultJson: input.result == null ? null : JSON.stringify(input.result),
      status: input.status,
      durationMs: input.durationMs,
      ts: new Date(),
    },
  })
}

async function recordWriteBack(input: {
  incidentUrn: string
  kind: string
  datahubUrn?: string
  status: 'succeeded' | 'proposed' | 'failed'
  path: 'agent_context_kit' | 'rest_ingestion'
  data: unknown
}): Promise<void> {
  await db.writeBack.create({
    data: {
      incidentUrn: input.incidentUrn,
      kind: input.kind,
      datahubUrn: input.datahubUrn ?? null,
      status: input.status,
      path: input.path,
      dataJson: JSON.stringify(input.data),
      ts: new Date(),
    },
  })
}

async function recordAction(input: {
  incidentUrn: string
  kind: string
  target: string
  payload: unknown
  status: 'proposed' | 'executed' | 'refused'
  dryRun: boolean
}): Promise<void> {
  await db.action.create({
    data: {
      incidentUrn: input.incidentUrn,
      kind: input.kind,
      target: input.target,
      payload: JSON.stringify(input.payload),
      status: input.status,
      ts: new Date(),
    },
  })
}

// ---------------------------------------------------------------------------
// READ tools — mcp.*
// ---------------------------------------------------------------------------

const READ_TOOLS: ToolDefinition[] = [
  {
    name: 'mcp.search',
    description:
      'Free-text search across DataHub entities. Returns [{urn,name,type,platform,description}]. Use this to discover assets by name; use mcp.get_entities to fetch full records for known URNs.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query (asset name, platform, etc.)' },
        filterType: {
          type: 'string',
          enum: ['dataset', 'chart', 'dashboard', 'dataFlow', 'dataJob', 'container', 'domain'],
        },
        filterPlatform: { type: 'string', description: 'e.g. s3, spark, dbt, snowflake, looker' },
        count: { type: 'number', description: 'Max results (default 50)' },
      },
      required: ['query'],
    },
    async execute(args, ctx) {
      return ctx.clients.mcp.search(asString(args.query), {
        filterType: asString(args.filterType) || undefined,
        filterPlatform: asString(args.filterPlatform) || undefined,
        count: asNumber(args.count, 50),
      })
    },
  },
  {
    name: 'mcp.get_entities',
    description:
      'Fetch full entity records (schema, owners, glossary terms, governance tags, lastModifiedAt) for the given URNs. Always call this on the failing asset first.',
    parameters: {
      type: 'object',
      properties: {
        urns: {
          type: 'array',
          items: { type: 'string' },
          description: 'DataHub URNs to fetch',
        },
      },
      required: ['urns'],
    },
    async execute(args, ctx) {
      return ctx.clients.mcp.get_entities(asStringArray(args.urns))
    },
  },
  {
    name: 'mcp.list_schema_fields',
    description:
      'List the schema fields of a dataset, optionally filtered by keyword. Use this to inspect column-level PII tags or schema drift.',
    parameters: {
      type: 'object',
      properties: {
        urn: { type: 'string' },
        keywords: { type: 'string', description: 'Optional keyword filter (matches name/description)' },
      },
      required: ['urn'],
    },
    async execute(args, ctx) {
      return ctx.clients.mcp.list_schema_fields(asString(args.urn), {
        keywords: asString(args.keywords) || undefined,
      })
    },
  },
  {
    name: 'mcp.get_me',
    description: "Fetch Sentinel's own DataHub identity — use as the author for save_document.",
    parameters: { type: 'object', properties: {} },
    async execute(_args, ctx) {
      return ctx.clients.mcp.get_me()
    },
  },
  {
    name: 'mcp.get_lineage',
    description:
      "Traverse lineage upstream (producers) or downstream (consumers) from an asset. Call downstream to find the blast radius, upstream to find the root-cause producer.",
    parameters: {
      type: 'object',
      properties: {
        urn: { type: 'string' },
        direction: { type: 'string', enum: ['upstream', 'downstream'] },
        maxHops: { type: 'number', description: 'Max traversal depth (default 3)' },
      },
      required: ['urn', 'direction'],
    },
    async execute(args, ctx) {
      return ctx.clients.mcp.get_lineage(asString(args.urn), asString(args.direction, 'downstream') as 'upstream' | 'downstream', {
        maxHops: asNumber(args.maxHops, 3),
      })
    },
  },
  {
    name: 'mcp.search_documents',
    description:
      'Search context docs (incl. prior Sentinel post-mortems) attached to an asset. ALWAYS call this on the failing asset before writing your own post-mortem — Run N must read Run N-1 (compounding, PDF §12.2).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        assetUrn: { type: 'string', description: 'Restrict to docs attached to this asset' },
        count: { type: 'number' },
      },
      required: ['query'],
    },
    async execute(args, ctx) {
      return ctx.clients.mcp.search_documents(asString(args.query), {
        assetUrn: asString(args.assetUrn) || undefined,
        count: asNumber(args.count, 20),
      })
    },
  },
  {
    name: 'mcp.grep_documents',
    description: 'Regex-search across context docs for a pattern. Returns matched lines.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern' },
        assetUrn: { type: 'string' },
        caseSensitive: { type: 'boolean' },
      },
      required: ['pattern'],
    },
    async execute(args, ctx) {
      return ctx.clients.mcp.grep_documents(asString(args.pattern), {
        assetUrn: asString(args.assetUrn) || undefined,
        caseSensitive: Boolean(args.caseSensitive),
      })
    },
  },
  {
    name: 'mcp.get_dataset_queries',
    description:
      'Fetch the SQL/Spark/dbt query that materialised a dataset. For a freshness breach, the upstream job that did not run is usually the root cause.',
    parameters: {
      type: 'object',
      properties: { urn: { type: 'string' }, limit: { type: 'number' } },
      required: ['urn'],
    },
    async execute(args, ctx) {
      return ctx.clients.mcp.get_dataset_queries(asString(args.urn), {
        limit: asNumber(args.limit, 5),
      })
    },
  },
  {
    name: 'mcp.list_lifecycle_stages',
    description: 'List the lifecycle stages configured in DataHub (Raw → Processed → Curated).',
    parameters: { type: 'object', properties: {} },
    async execute(_args, ctx) {
      return ctx.clients.mcp.list_lifecycle_stages()
    },
  },
]

// ---------------------------------------------------------------------------
// WRITE tools — ack.* (Agent Context Kit)
// ---------------------------------------------------------------------------

const WRITE_TOOLS: ToolDefinition[] = [
  {
    name: 'ack.save_document',
    description:
      'Save a post-mortem context doc attached to an asset. Mark sentinelPostMortem=true so the next incident can find it via mcp.search_documents. This is the KEY write-back (PDF §12.2 compounding). Direct write, reversible.',
    parameters: {
      type: 'object',
      properties: {
        assetUrn: { type: 'string', description: 'Asset URN the doc is attached to' },
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown body of the post-mortem' },
        sentinelPostMortem: { type: 'boolean', description: 'Mark as a Sentinel post-mortem (default true)' },
      },
      required: ['assetUrn', 'title', 'content'],
    },
    async execute(args, ctx) {
      const assetUrn = asString(args.assetUrn)
      const title = asString(args.title)
      const content = asString(args.content)
      const isPostMortem = args.sentinelPostMortem !== false
      const me = await ctx.clients.mcp.get_me()
      // Phase 4: dual write-back path (PDF §12.2). The agent's explicit
      // ack.save_document call now goes through the same helper as the
      // orchestrator's post-loop fallback: try Agent Context Kit → fall back
      // to REST ingestion on a 5xx/network error. A 4xx is a hard failure.
      const wb = await writeBackDocument({
        clients: ctx.clients,
        incidentUrn: ctx.incidentUrn,
        assetUrn,
        title,
        content,
        format: 'markdown',
        authorUrn: me.urn,
        sentinelPostMortem: isPostMortem,
        audit: getAudit(),
      })
      return {
        urn: wb.urn,
        kind: 'context_doc',
        title,
        assetUrn,
        path: wb.path,
        status: wb.status,
        fallback: wb.fallback,
        primaryError: wb.primaryError,
        error: wb.error,
      }
    },
  },
  {
    name: 'ack.add_owners',
    description:
      'Propose ownership enrichment on an asset. Records a proposal (Phase 4 routes through the human-approval gate).',
    parameters: {
      type: 'object',
      properties: {
        urn: { type: 'string' },
        owners: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ownerUrn: { type: 'string' },
              ownerType: { type: 'string', enum: ['USER', 'GROUP', 'CORP_GROUP'] },
              name: { type: 'string' },
            },
            required: ['ownerUrn', 'ownerType'],
          },
        },
      },
      required: ['urn', 'owners'],
    },
    async execute(args, ctx) {
      const urn = asString(args.urn)
      const owners = asRecordArray(args.owners).map((o) => ({
        ownerUrn: asString(o.ownerUrn),
        ownerType: (asString(o.ownerType, 'USER') as 'USER' | 'GROUP' | 'CORP_GROUP'),
        name: asString(o.name) || undefined,
      }))
      await ctx.clients.contextKit.add_owners(urn, owners)
      await recordWriteBack({
        incidentUrn: ctx.incidentUrn,
        kind: 'ownership_proposal',
        status: 'proposed',
        path: 'agent_context_kit',
        data: { urn, owners },
      })
      return { kind: 'ownership_proposal', urn, owners, path: 'agent_context_kit', status: 'proposed' }
    },
  },
  {
    name: 'ack.add_glossary_terms',
    description: 'Propose glossary-term enrichment on an asset.',
    parameters: {
      type: 'object',
      properties: {
        urn: { type: 'string' },
        termUrns: { type: 'array', items: { type: 'string' } },
      },
      required: ['urn', 'termUrns'],
    },
    async execute(args, ctx) {
      const urn = asString(args.urn)
      const termUrns = asStringArray(args.termUrns)
      await ctx.clients.contextKit.add_glossary_terms(urn, termUrns)
      await recordWriteBack({
        incidentUrn: ctx.incidentUrn,
        kind: 'glossary_proposal',
        status: 'proposed',
        path: 'agent_context_kit',
        data: { urn, termUrns },
      })
      return { kind: 'glossary_proposal', urn, termUrns, path: 'agent_context_kit', status: 'proposed' }
    },
  },
  {
    name: 'ack.add_tags',
    description: 'Add a governance tag to an asset. Refused if the asset already carries a PII tag without prior approval (see governance.md).',
    parameters: {
      type: 'object',
      properties: {
        urn: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['urn', 'tags'],
    },
    async execute(args, ctx) {
      const urn = asString(args.urn)
      const tags = asStringArray(args.tags)
      await ctx.clients.contextKit.add_tags(urn, tags)
      await recordWriteBack({
        incidentUrn: ctx.incidentUrn,
        kind: 'tag',
        status: 'proposed',
        path: 'agent_context_kit',
        data: { urn, tags },
      })
      return { kind: 'tag', urn, tags, path: 'agent_context_kit', status: 'proposed' }
    },
  },
  {
    name: 'ack.update_description',
    description: 'Update an entity description (proposal).',
    parameters: {
      type: 'object',
      properties: {
        urn: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['urn', 'description'],
    },
    async execute(args, ctx) {
      const urn = asString(args.urn)
      const description = asString(args.description)
      await ctx.clients.contextKit.update_description(urn, description)
      await recordWriteBack({
        incidentUrn: ctx.incidentUrn,
        kind: 'description',
        status: 'proposed',
        path: 'agent_context_kit',
        data: { urn, description },
      })
      return { kind: 'description', urn, path: 'agent_context_kit', status: 'proposed' }
    },
  },
  {
    name: 'ack.create_assertion',
    description:
      'Create a new DataHub assertion encoding a learned SLA (PDF §9.5.5 — assertions are the only direct write besides post-mortems; both reversible). Use this to tighten an SLA after a freshness breach.',
    parameters: {
      type: 'object',
      properties: {
        assetUrn: { type: 'string' },
        type: { type: 'string', enum: ['freshness', 'schema', 'quality', 'custom'] },
        description: { type: 'string' },
        slaSeconds: { type: 'number', description: 'SLA in seconds (e.g. 3600 for 1h)' },
      },
      required: ['assetUrn', 'type', 'description'],
    },
    async execute(args, ctx) {
      const assetUrn = asString(args.assetUrn)
      const type = asString(args.type, 'freshness') as 'freshness' | 'schema' | 'quality' | 'custom'
      const description = asString(args.description)
      const slaSeconds = asNumber(args.slaSeconds)
      const res = await ctx.clients.ingestion.createAssertion({
        assetUrn,
        type,
        description,
        slaSeconds,
      })
      await recordWriteBack({
        incidentUrn: ctx.incidentUrn,
        kind: 'assertion',
        datahubUrn: res.urn,
        status: 'succeeded',
        path: 'rest_ingestion',
        data: { assetUrn, type, description, slaSeconds },
      })
      return { urn: res.urn, kind: 'assertion', assetUrn, type, slaSeconds, path: 'rest_ingestion' }
    },
  },
]

// ---------------------------------------------------------------------------
// ACTION tools — action.* (Phase 3: real GitHub + Slack connectors)
// These now call src/lib/connectors/{github,slack}.ts. SENTINEL_DRY_RUN=true
// (default) routes to the trace JSONL log; SENTINEL_DRY_RUN=false calls the
// live GitHub + Slack APIs against the demo repo + channel.
// Sentinel NEVER merges (PDF §9.3.5). The guardrail's NoMergeRule enforces this
// in code even if the LLM attempts to call a merge tool.
// ---------------------------------------------------------------------------

const ACTION_TOOLS: ToolDefinition[] = [
  {
    name: 'action.github_open_issue',
    description:
      'Open a GitHub issue in the demo repo (GITHUB_DEMO_REPO) with the root cause, blast radius, and suggested fix. Sentinel NEVER merges (PDF §9.3.5). Honors SENTINEL_DRY_RUN: trace mode writes to examples/trace/github-actions.log.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Defaults to GITHUB_DEMO_REPO' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown body of the issue' },
        labels: { type: 'array', items: { type: 'string' }, description: 'GitHub labels (auto-created on the repo if missing)' },
      },
      required: ['title', 'body'],
    },
    async execute(args, ctx) {
      const repo = asString(args.repo) || process.env.GITHUB_DEMO_REPO || 'sodiq-code/sentinel-demo-pipeline'
      const title = asString(args.title)
      const body = asString(args.body)
      const labels = asStringArray(args.labels)
      try {
        const res = await ghOpenIssue({ repo, title, body, labels })
        await db.action.create({
          data: {
            incidentUrn: ctx.incidentUrn,
            kind: 'github.openIssue',
            target: repo,
            payload: JSON.stringify({ repo, title, body, labels, number: res.number, trace: res.trace }),
            status: 'executed',
            url: res.trace ? null : res.url,
            ts: new Date(),
          },
        })
        return {
          kind: 'github.openIssue',
          repo,
          number: res.number,
          url: res.url,
          state: res.state,
          trace: res.trace,
          status: 'executed',
          note: res.trace
            ? 'Trace: written to the local trace log. Set SENTINEL_DRY_RUN=false to file a live issue.'
            : 'Live: GitHub issue opened in the demo pipeline repo. Sentinel NEVER merges — issue is left OPEN for human review.',
        }
      } catch (err) {
        const error = (err as Error).message ?? String(err)
        await db.action.create({
          data: {
            incidentUrn: ctx.incidentUrn,
            kind: 'github.openIssue',
            target: repo,
            payload: JSON.stringify({ repo, title, body, labels, error }),
            status: 'refused',
            ts: new Date(),
          },
        })
        return { kind: 'github.openIssue', repo, title, status: 'failed', error }
      }
    },
  },
  {
    name: 'action.github_open_pr',
    description:
      'Open a GitHub pull request in the demo repo (GITHUB_DEMO_REPO) with the proposed fix. Sentinel NEVER merges (PDF §9.3.5 no-merge policy) — the PR is always left OPEN for human review. The head branch MUST already exist on the repo (Phase 3 only opens PRs; it does NOT push branches). Honors SENTINEL_DRY_RUN.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Defaults to GITHUB_DEMO_REPO' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown body of the PR' },
        branch: { type: 'string', description: 'Head branch (must already exist on the repo). Defaults to sentinel/proposed-fix.' },
        base: { type: 'string', description: 'Base branch. Defaults to main.' },
      },
      required: ['title', 'body', 'branch'],
    },
    async execute(args, ctx) {
      const repo = asString(args.repo) || process.env.GITHUB_DEMO_REPO || 'sodiq-code/sentinel-demo-pipeline'
      const title = asString(args.title)
      const body = asString(args.body)
      const branch = asString(args.branch, 'sentinel/proposed-fix')
      const base = asString(args.base, 'main')
      try {
        const res = await ghOpenPR({ repo, title, body, branch, base })
        await db.action.create({
          data: {
            incidentUrn: ctx.incidentUrn,
            kind: 'github.openPR',
            target: repo,
            payload: JSON.stringify({ repo, title, body, branch, base, number: res.number, trace: res.trace, neverMerged: true }),
            status: 'executed',
            url: res.trace ? null : res.url,
            ts: new Date(),
          },
        })
        return {
          kind: 'github.openPR',
          repo,
          number: res.number,
          url: res.url,
          state: res.state,
          mergeable: res.mergeable,
          trace: res.trace,
          neverMerged: true,
          status: 'executed',
          note: 'Sentinel NEVER merges this PR (PDF §9.3.5). It is left OPEN for human review. A human reviewer decides whether to merge.',
        }
      } catch (err) {
        const error = (err as Error).message ?? String(err)
        await db.action.create({
          data: {
            incidentUrn: ctx.incidentUrn,
            kind: 'github.openPR',
            target: repo,
            payload: JSON.stringify({ repo, title, body, branch, base, error }),
            status: 'refused',
            ts: new Date(),
          },
        })
        return { kind: 'github.openPR', repo, title, branch, base, status: 'failed', error, neverMerged: true }
      }
    },
  },
  {
    name: 'action.slack_post_triage',
    description:
      'Post a 3-bullet triage summary (what failed / who is affected / what on-call should do) to the demo Slack channel (SLACK_DEMO_CHANNEL). Renders as a Slack Block Kit triage card. Honors SENTINEL_DRY_RUN: trace mode writes to examples/trace/slack-posts.log.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Defaults to SLACK_DEMO_CHANNEL' },
        title: { type: 'string', description: 'Short headline of the triage card' },
        bullets: {
          type: 'array',
          items: { type: 'string' },
          description: '1–3 bullets. The connector renders them as a Slack Block Kit triage card.',
        },
        footer: { type: 'string', description: 'Optional footer (e.g. Sentinel incident urn).' },
      },
      required: ['title', 'bullets'],
    },
    async execute(args, ctx) {
      const channel = asString(args.channel) || process.env.SLACK_DEMO_CHANNEL || 'C0BL9CQ4D5G'
      const title = asString(args.title)
      const bullets = asStringArray(args.bullets)
      const footer = asString(args.footer) || undefined
      try {
        const res = await slackPostTriage({ channel, title, bullets, footer })
        await db.action.create({
          data: {
            incidentUrn: ctx.incidentUrn,
            kind: 'slack.postMessage',
            target: channel,
            payload: JSON.stringify({ channel, title, bullets, footer, ts: res.ts, trace: res.trace }),
            status: 'executed',
            url: res.trace ? null : res.url,
            ts: new Date(),
          },
        })
        return {
          kind: 'slack.postMessage',
          channel,
          ts: res.ts,
          url: res.url,
          trace: res.trace,
          status: 'executed',
          note: res.trace
            ? 'Trace: written to the local trace log. Set SENTINEL_DRY_RUN=false to post live.'
            : 'Live: Slack triage card posted to the demo channel.',
        }
      } catch (err) {
        const error = (err as Error).message ?? String(err)
        await db.action.create({
          data: {
            incidentUrn: ctx.incidentUrn,
            kind: 'slack.postMessage',
            target: channel,
            payload: JSON.stringify({ channel, title, bullets, footer, error }),
            status: 'refused',
            ts: new Date(),
          },
        })
        return { kind: 'slack.postMessage', channel, title, status: 'failed', error }
      }
    },
  },
]

// ---------------------------------------------------------------------------
// Public catalogue + helpers
// ---------------------------------------------------------------------------

export function buildToolCatalogue(): ToolDefinition[] {
  return [...READ_TOOLS, ...WRITE_TOOLS, ...ACTION_TOOLS]
}

/** Map our ToolDefinition[] to the OpenAI `tools` schema the LLM expects. */
export function toLlmTools(defs: ToolDefinition[]): LlmTool[] {
  return defs.map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }))
}

/**
 * Execute a single LLM tool_call: parse args, find the tool, execute, record to
 * the ToolCall table. Errors are caught and returned as a structured `error`
 * result so the agent can adapt (PDF §9.5.4 — never crash the loop on a tool
 * failure). The loop only throws on a bug in this harness itself.
 */
export async function executeToolCall(
  call: LlmToolCall,
  defs: ToolDefinition[],
  ctx: ToolContext,
): Promise<ToolExecResult> {
  const name = call.function.name
  const startedAt = Date.now()
  let parsedArgs: Record<string, unknown>
  try {
    parsedArgs = call.function.arguments
      ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
      : {}
  } catch (err) {
    const error = `Malformed tool arguments JSON: ${(err as Error).message}`
    const result = { error, toolName: name, rawArguments: call.function.arguments }
    await recordToolCall({
      incidentUrn: ctx.incidentUrn,
      tool: name,
      args: { __raw: call.function.arguments },
      result,
      status: 'error',
      durationMs: Date.now() - startedAt,
      error,
    })
    return { result, status: 'error', durationMs: Date.now() - startedAt, error }
  }

  const def = defs.find((d) => d.name === name)
  if (def) {
    return runTool(def, name, parsedArgs, ctx, startedAt)
  }

  // Robustness (PDF §9.5.4): some OpenAI-compatible gateways occasionally
  // concatenate the model's reasoning into the tool-name field, producing a
  // malformed name like "<reasoning...> action.github_open_issue". Recover
  // the model's intent by finding the longest valid tool name that appears
  // as a substring of the malformed name.
  const recovered = defs
    .map((d) => ({ d, idx: name.indexOf(d.name) }))
    .filter((c) => c.idx >= 0)
    .sort((a, b) => b.d.name.length - a.d.name.length)[0]
  if (recovered) {
    const args = recovered.d.name === name ? parsedArgs : tryRecoverArgs(parsedArgs, name)
    return runTool(recovered.d, recovered.d.name, args, ctx, startedAt)
  }

  const error = `Unknown tool: '${name.slice(0, 120)}'`
  const result = { error, toolName: name.slice(0, 120) }
  await recordToolCall({
    incidentUrn: ctx.incidentUrn,
    tool: name.slice(0, 200),
    args: parsedArgs,
    result,
    status: 'error',
    durationMs: Date.now() - startedAt,
    error,
  })
  return { result, status: 'error', durationMs: Date.now() - startedAt, error }
}

// ---------------------------------------------------------------------------
// runTool — execute a resolved ToolDefinition, catching errors so the loop
// never crashes (PDF §9.5.4). Records every call to the ToolCall table.
// ---------------------------------------------------------------------------

async function runTool(
  def: ToolDefinition,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  startedAt: number,
): Promise<ToolExecResult> {
  try {
    const raw = await def.execute(args, ctx)
    const result = truncate(raw)
    await recordToolCall({
      incidentUrn: ctx.incidentUrn,
      tool: name,
      args,
      result,
      status: 'ok',
      durationMs: Date.now() - startedAt,
    })
    return { result, status: 'ok', durationMs: Date.now() - startedAt }
  } catch (err) {
    const error = (err as Error).message ?? String(err)
    const result = { error, toolName: name }
    await recordToolCall({
      incidentUrn: ctx.incidentUrn,
      tool: name,
      args,
      result,
      status: 'error',
      durationMs: Date.now() - startedAt,
      error,
    })
    return { result, status: 'error', durationMs: Date.now() - startedAt, error }
  }
}

// ---------------------------------------------------------------------------
// tryRecoverArgs — when a tool call was malformed (gateway concatenated
// reasoning into the name), the args may also be malformed/missing. Try to
// extract the first JSON object {...} from the raw blob; fall back to {} so
// the tool's own validation produces an actionable error.
// ---------------------------------------------------------------------------

function tryRecoverArgs(parsed: Record<string, unknown>, rawName: string): Record<string, unknown> {
  if (parsed && Object.keys(parsed).length > 0 && !parsed.__raw) return parsed
  const match = rawName.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      return JSON.parse(match[0]) as Record<string, unknown>
    } catch {
      // fall through
    }
  }
  return {}
}

/** Stable tool list (read-only view for the UI / API). */
export const TOOL_CATALOGUE = buildToolCatalogue()
export const TOOL_NAMES = TOOL_CATALOGUE.map((t) => t.name)

export { asRecord }
