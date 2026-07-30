// =============================================================================
// Sentinel — Seed signals (the injectable inputs for the Phase 2 demo)
//
// In DEMO mode there is no live DataHub to push a webhook. Instead the
// orchestrator is fed a Signal constructed from a seeded failing assertion
// (Phase 1 seed). This module lists the available seed signals and constructs
// a Signal object from one.
//
// Three injectable scenarios:
//   1. nyc-taxi freshness    — the planted failing freshness assertion on raw_s3
//   2. showcase-ecommerce     — a schema-breakage signal on the cross-platform graph
//   3. pii                    — a PII-tagged asset; guardrail must refuse
// =============================================================================

import { db } from '@/lib/db'
import type { Signal } from './types'

export interface InjectableSignal {
  id: string
  scenarioId: string
  label: string
  description: string
  assetUrn: string
  assetName: string
  type: Signal['type']
  status: Signal['status']
  assertionUrn: string
  assertionDescription: string
  failureReason?: string
  /** Plant the signal: flip the seeded assertion to failing so the demo is live. */
  prime: () => Promise<void>
}

// ---------------------------------------------------------------------------
// List the injectable signals from the seed. Each prime() flips the seeded
// assertion to 'failing' (idempotent) so the demo reflects a fresh incident.
// ---------------------------------------------------------------------------

export async function listSeedSignals(): Promise<InjectableSignal[]> {
  const out: InjectableSignal[] = []

  // 1. NYC taxi freshness — the planted failing assertion.
  const freshness = await db.seedAssertion.findFirst({
    where: { scenarioId: 'nyc-taxi-freshness', type: 'freshness' },
  })
  const rawAsset = await db.seedAsset.findUnique({
    where: { urn: freshness?.assetUrn ?? '' },
  })
  if (freshness && rawAsset) {
    out.push({
      id: 'sig:nyc-taxi:freshness',
      scenarioId: 'nyc-taxi-freshness',
      label: 'NYC Taxi — freshness breach',
      description:
        'Raw S3 landing `raw_s3_nyc_taxi_trips` is 6h stale vs a 1h freshness SLA. Downstream Spark clean + dbt daily model are at risk.',
      assetUrn: rawAsset.urn,
      assetName: rawAsset.name,
      type: 'freshness',
      status: 'failing',
      assertionUrn: freshness.urn,
      assertionDescription: freshness.description,
      failureReason: freshness.failureReason ?? undefined,
      prime: async () => {
        await db.seedAssertion.update({
          where: { urn: freshness.urn },
          data: {
            status: 'failing',
            lastEvaluatedAt: new Date(),
            failureReason:
              freshness.failureReason ??
              'Asset last modified 6h 02m ago; SLA is 1h (3600s).',
          },
        })
      },
    })
  }

  // 2. Showcase eCommerce — schema breakage (construct a synthetic schema signal).
  const ecomAsset = await db.seedAsset.findFirst({
    where: { scenarioId: 'showcase-ecommerce', platform: 'snowflake' },
  })
  if (ecomAsset) {
    const ecomAssertionUrn = `urn:li:assertion:sentinel:schema:showcase:${Date.now()}`
    out.push({
      id: 'sig:showcase:schema',
      scenarioId: 'showcase-ecommerce',
      label: 'Showcase eCommerce — schema breakage',
      description:
        'A column rename on the Snowflake source propagated downstream through Looker → dbt → Spark → S3. Schema assertion fails on the Looker chart.',
      assetUrn: ecomAsset.urn,
      assetName: ecomAsset.name,
      type: 'schema',
      status: 'failing',
      assertionUrn: ecomAssertionUrn,
      assertionDescription:
        'Schema field count mismatch: Looker chart `revenue_by_region` expects 6 fields, source now exposes 5.',
      failureReason: 'Field `region_name` dropped from upstream Snowflake view.',
      prime: async () => {
        // Idempotent: create-or-update a synthetic failing schema assertion.
        await db.seedAssertion.upsert({
          where: { urn: ecomAssertionUrn },
          update: {
            status: 'failing',
            lastEvaluatedAt: new Date(),
            failureReason: 'Field `region_name` dropped from upstream Snowflake view.',
          },
          create: {
            urn: ecomAssertionUrn,
            assetUrn: ecomAsset.urn,
            type: 'schema',
            status: 'failing',
            description:
              'Schema field count mismatch: Looker chart `revenue_by_region` expects 6 fields, source now exposes 5.',
            failureReason: 'Field `region_name` dropped from upstream Snowflake view.',
            lastEvaluatedAt: new Date(),
            scenarioId: 'showcase-ecommerce',
          },
        })
      },
    })
  }

  // 3. PII refusal — a synthetic signal on the PII-tagged customer_pii table.
  const piiAsset = await db.seedAsset.findFirst({
    where: { scenarioId: 'pii' },
  })
  if (piiAsset) {
    const piiAssertionUrn = `urn:li:assertion:sentinel:pii:${Date.now()}`
    out.push({
      id: 'sig:pii:refusal',
      scenarioId: 'pii',
      label: 'Customer PII — governance refusal',
      description:
        'A signal on `customer_pii` (tagged PII + Restricted). The guardrail must refuse write-back without explicit approval.',
      assetUrn: piiAsset.urn,
      assetName: piiAsset.name,
      type: 'pii',
      status: 'failing',
      assertionUrn: piiAssertionUrn,
      assertionDescription: 'PII exposure check: a downstream consumer requested unmasked fields.',
      failureReason: 'Consumer requested masked PII columns in clear text.',
      prime: async () => {
        await db.seedAssertion.upsert({
          where: { urn: piiAssertionUrn },
          update: { status: 'failing', lastEvaluatedAt: new Date() },
          create: {
            urn: piiAssertionUrn,
            assetUrn: piiAsset.urn,
            type: 'custom',
            status: 'failing',
            description: 'PII exposure check: a downstream consumer requested unmasked fields.',
            failureReason: 'Consumer requested masked PII columns in clear text.',
            lastEvaluatedAt: new Date(),
            scenarioId: 'pii',
          },
        })
      },
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// Construct a Signal object from an InjectableSignal (post-prime).
// ---------------------------------------------------------------------------

export async function buildSignal(sig: InjectableSignal): Promise<Signal> {
  const firedAt = new Date().toISOString()
  const id = `signal:${sig.id}:${Date.now()}`
  return {
    id,
    assertionUrn: sig.assertionUrn,
    assetUrn: sig.assetUrn,
    type: sig.type,
    status: sig.status,
    firedAt,
    rawPayload: {
      scenarioId: sig.scenarioId,
      assertionDescription: sig.assertionDescription,
      failureReason: sig.failureReason,
    },
  }
}

// ---------------------------------------------------------------------------
// Construct the initial user message the orchestrator feeds to the LLM.
// ---------------------------------------------------------------------------

export function buildInitialUserMessage(sig: InjectableSignal, signal: Signal): string {
  return [
    'SIGNAL RECEIVED — DataHub assertion failure.',
    '',
    `Incident URN:    ${signal.id}`,
    `Assertion URN:   ${signal.assertionUrn}`,
    `Asset URN:       ${signal.assetUrn}`,
    `Asset name:      ${sig.assetName}`,
    `Signal type:     ${signal.type}`,
    `Status:          ${signal.status}`,
    `Fired at:        ${signal.firedAt}`,
    '',
    `Assertion:       ${sig.assertionDescription}`,
    `Failure reason:  ${sig.failureReason ?? '(none recorded)'}`,
    '',
    'Investigate this incident end-to-end per the Sentinel workflow:',
    '  1. Detect & triage — fetch the failing asset, its schema, owners, glossary terms, and governance tags.',
    '  2. Diagnose — traverse lineage downstream (blast radius) and upstream (root cause);',
    '     search context docs for a prior Sentinel post-mortem on this asset (compounding context);',
    '     review the query/job that materialises the upstream producer.',
    '  3. Remediate — propose a GitHub issue (action.github_open_issue) and a Slack triage post (action.slack_post_triage).',
    '  4. Document — write a post-mortem context doc back to DataHub (ack.save_document, sentinelPostMortem=true).',
    '  5. Write-back — if the failure reveals a missing/loose SLA, create a tightened assertion (ack.create_assertion).',
    '',
    'Show your reasoning at every step. Call tools to investigate AND act.',
    '',
    'CONTENT DISCIPLINE — make every artefact SPECIFIC to this signal type:',
    '  - The GitHub issue title + body must name the actual root cause and blast radius for THIS',
    '    signal (e.g. for freshness: the stalled ingestion job + stale partitions; for schema: the',
    '    renamed/dropped column + the 4-hop lineage; for PII: the governance refusal).',
    '  - The Slack triage bullets must be tailored: "what failed" must cite the concrete assertion',
    '    + failure reason, "who is affected" must list the real downstream assets, "what on-call',
    '    should do" must give a concrete next step for THIS failure mode.',
    '  - The post-mortem must capture the type-specific root cause, blast radius, and learned policy.',
    '  Do NOT reuse generic templates — a reviewer must be able to tell the three incident types',
    '  apart from the GitHub issue + Slack card + post-mortem alone.',
    '',
    'MANDATORY completion checklist (you MUST call these tools before your final summary):',
    '  - action.github_open_issue  — open the engineering issue',
    '  - action.slack_post_triage  — post the stakeholder triage',
    '  - ack.save_document         — write the post-mortem back to DataHub',
    'A summary without these three tool calls is a FAILURE. Be an agent, not an analyst.',
  ].join('\n')
}
