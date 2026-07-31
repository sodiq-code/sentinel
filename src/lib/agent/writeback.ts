// =============================================================================
// Sentinel — Dual write-back path (Phase 4, PDF §12.2)
//
// The compounding artefact (a Sentinel post-mortem context doc) is written
// back to DataHub through TWO paths, in order:
//
//   1. Agent Context Kit  (contextKit.save_document)   — PRIMARY
//   2. REST ingestion      (ingestion.ingestProposal)    — FALLBACK
//
// The Agent Context Kit is the structured, schema-validated write path
// DataHub ships for agents (PDF §10.2). When it is unavailable — the ACK
// endpoint is down, the auth token expired, or a 5xx is returned — Sentinel
// falls back to the REST ingestion path: a GraphQL `createDatahubPostMortemDoc`
// proposal POSTed to the GMS `/api/graphql` endpoint. Both paths produce a
// DataHub URN that becomes part of the asset's durable context.
//
// A 4xx from the ACK path is treated as a HARD failure (the request itself
// was malformed — e.g. the asset URN does not exist) and does NOT trigger
// the fallback: the operator should fix the request, not retry it blindly.
//
// Every attempt records:
//   - a WriteBack row  (path = 'agent_context_kit' | 'rest_ingestion',
//                       status = 'succeeded' | 'failed')
//   - audit events     (writeback_proposed, writeback_succeeded | writeback_failed)
//
// Used by:
//   - the orchestrator's post-loop fallback post-mortem (orchestrator.ts)
//   - the ack.save_document tool (tools.ts) — so the agent's explicit call
//     also gets the dual path
//   - the /api/agent/writeback re-attempt endpoint (operator can retry a
//     failed write-back from the console)
// =============================================================================

import { db } from '@/lib/db'
import type { DataHubClients, Urn } from '@/lib/datahub/types'
import type { AuditLogger } from './audit'
import { getAuditMirror } from './audit-mirror'

export type WriteBackPath = 'agent_context_kit' | 'rest_ingestion'
export type WriteBackStatus = 'succeeded' | 'failed'

export interface WriteBackDocumentInput {
  clients: DataHubClients
  incidentUrn: string
  assetUrn: Urn
  title: string
  content: string
  format?: 'markdown' | 'html' | 'plaintext'
  authorUrn?: Urn
  sentinelPostMortem?: boolean
  audit: AuditLogger
  /** Override the WriteBack row's `kind` column. Default: 'context_doc'. */
  dbKind?: string
}

export interface WriteBackDocumentOutcome {
  path: WriteBackPath
  urn: string
  status: WriteBackStatus
  /** True when the fallback path was used (or attempted). */
  fallback: boolean
  /** Populated when the fallback path was attempted. */
  primaryError?: string
  /** Populated when both paths failed. */
  error?: string
}

// ---------------------------------------------------------------------------
// The GraphQL mutation used by the REST ingestion fallback.
//
// DataHub's GMS exposes a GraphQL endpoint at `/api/graphql`. The ACK
// equivalent at the GraphQL layer is the `createDatahubPostMortemDoc`
// mutation (the same mutation the ACK wraps, exposed directly). In DEMO
// mode the mock inspects the mutation name to persist the doc into the
// SeedContextDoc table — so the fallback path produces a findable artefact,
// not just a synthetic URN.
// ---------------------------------------------------------------------------

const POSTMORTEM_MUTATION = `mutation SentinelPostMortemDoc($input: CreateDatahubPostMortemDocInput!) {
  createDatahubPostMortemDoc(input: $input) { urn }
}`

/**
 * Classify an error from the ACK path. A 4xx (client error) means the request
 * was malformed — the fallback would fail for the same reason, so we do NOT
 * fall back. A network error or 5xx means the ACK endpoint is unhealthy — the
 * fallback SHOULD be attempted.
 */
function isHardClientError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err)
  return /\bHTTP (4\d\d)\b/.test(msg) || /status 4\d\d/.test(msg)
}

/**
 * Write a post-mortem context doc to DataHub via the dual write-back path
 * (PDF §12.2). Returns the outcome (path used, URN, status). Records a
 * WriteBack row + audit events regardless of outcome.
 */
export async function writeBackDocument(
  input: WriteBackDocumentInput,
): Promise<WriteBackDocumentOutcome> {
  const {
    clients,
    incidentUrn,
    assetUrn,
    title,
    content,
    audit,
  } = input
  const format = input.format ?? 'markdown'
  const authorUrn = input.authorUrn
  const sentinelPostMortem = input.sentinelPostMortem ?? true
  const dbKind = input.dbKind ?? 'context_doc'

  await audit.record({
    incidentUrn,
    kind: 'writeback_proposed',
    summary: `Write-back proposed: ${title} (dual path: ACK primary → REST fallback)`,
    payload: { title, assetUrn, format, sentinelPostMortem },
  })

  // --- Primary: Agent Context Kit -----------------------------------------
  try {
    const res = await clients.contextKit.save_document({
      assetUrn,
      title,
      content,
      format,
      authorUrn,
      sentinelPostMortem,
    })
    await db.writeBack.create({
      data: {
        incidentUrn,
        kind: dbKind,
        datahubUrn: res.urn,
        status: 'succeeded',
        path: 'agent_context_kit',
        dataJson: JSON.stringify({ title, format, sentinelPostMortem }),
        ts: new Date(),
      },
    })
    await audit.record({
      incidentUrn,
      kind: 'writeback_succeeded',
      summary: `Write-back succeeded via Agent Context Kit: ${res.urn}`,
      payload: { path: 'agent_context_kit', urn: res.urn, title, fallback: false },
    })
    // Phase 4: mirror the lifecycle event to DataHub Assertions (best-effort,
    // non-fatal — the write already succeeded).
    void getAuditMirror().mirror({
      incidentUrn,
      kind: 'writeback_succeeded',
      summary: title,
      assetUrn,
      title,
    })
    return {
      path: 'agent_context_kit',
      urn: res.urn,
      status: 'succeeded',
      fallback: false,
    }
  } catch (primaryErr) {
    const primaryError = (primaryErr as Error)?.message ?? String(primaryErr)

    // A 4xx from ACK is a hard client error — do NOT fall back. The fallback
    // would fail for the same reason (bad URN, bad auth, etc.). Record and
    // surface the failure so the operator can fix the request.
    if (isHardClientError(primaryErr)) {
      await db.writeBack.create({
        data: {
          incidentUrn,
          kind: dbKind,
          datahubUrn: null,
          status: 'failed',
          path: 'agent_context_kit',
          dataJson: JSON.stringify({
            title,
            format,
            sentinelPostMortem,
            error: primaryError,
            hardFailure: true,
          }),
          ts: new Date(),
        },
      })
      await audit.record({
        incidentUrn,
        kind: 'writeback_failed',
        summary: `Write-back FAILED (hard 4xx, no fallback): ${primaryError}`,
        payload: { path: 'agent_context_kit', title, primaryError, hardFailure: true },
      })
      return {
        path: 'agent_context_kit',
        urn: '',
        status: 'failed',
        fallback: false,
        error: primaryError,
      }
    }

    // --- Fallback: REST ingestion (GraphQL proposal) ----------------------
    try {
      const fallbackRes = await clients.ingestion.ingestProposal({
        mutation: POSTMORTEM_MUTATION,
        variables: {
          input: {
            entityUrn: assetUrn,
            title,
            content,
            format,
            authorUrn,
            sentinelPostMortem,
          },
        },
      })
      await db.writeBack.create({
        data: {
          incidentUrn,
          kind: dbKind,
          datahubUrn: fallbackRes.urn,
          status: 'succeeded',
          path: 'rest_ingestion',
          dataJson: JSON.stringify({
            title,
            format,
            sentinelPostMortem,
            fallback: true,
            primaryError,
          }),
          ts: new Date(),
        },
      })
      await audit.record({
        incidentUrn,
        kind: 'writeback_succeeded',
        summary: `Write-back succeeded via REST ingestion fallback (ACK failed: ${primaryError}): ${fallbackRes.urn}`,
        payload: {
          path: 'rest_ingestion',
          urn: fallbackRes.urn,
          title,
          fallback: true,
          primaryError,
        },
      })
      // Phase 4: mirror the lifecycle event to DataHub Assertions (best-effort).
      void getAuditMirror().mirror({
        incidentUrn,
        kind: 'writeback_succeeded',
        summary: title,
        assetUrn,
        title,
      })
      return {
        path: 'rest_ingestion',
        urn: fallbackRes.urn,
        status: 'succeeded',
        fallback: true,
        primaryError,
      }
    } catch (fallbackErr) {
      const fallbackError = (fallbackErr as Error)?.message ?? String(fallbackErr)
      await db.writeBack.create({
        data: {
          incidentUrn,
          kind: dbKind,
          datahubUrn: null,
          status: 'failed',
          path: 'rest_ingestion',
          dataJson: JSON.stringify({
            title,
            format,
            sentinelPostMortem,
            primaryError,
            fallbackError,
          }),
          ts: new Date(),
        },
      })
      await audit.record({
        incidentUrn,
        kind: 'writeback_failed',
        summary: `Write-back FAILED: ACK(${primaryError}) → REST(${fallbackError})`,
        payload: { primaryError, fallbackError, title },
      })
      return {
        path: 'rest_ingestion',
        urn: '',
        status: 'failed',
        fallback: true,
        primaryError,
        error: fallbackError,
      }
    }
  }
}
