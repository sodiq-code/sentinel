// =============================================================================
// Sentinel — Deterministic fallback message templates (per signal type)
//
// When the LLM is briefly unreachable (rate-limit / cold start / network), the
// orchestrator's deterministic fallback path completes the closed loop. To
// make each injectable scenario visibly distinct in the GitHub issue, the
// Slack triage card, AND the DataHub post-mortem — even on the fallback path —
// this module produces type-specific, scenario-aware content.
//
// Three scenarios, each with bespoke content:
//   1. nyc-taxi-freshness   — S3 landing table stale vs 1h SLA
//   2. showcase-ecommerce    — schema column rename propagated downstream
//   3. pii                   — PII governance refusal (write-back blocked)
//
// Every GitHub issue body, Slack bullet list, and post-mortem section is
// tailored to the actual failure mode so a reviewer can tell the three
// incidents apart at a glance.
// =============================================================================

import type { InjectableSignal } from './seed-signals'
import type { Signal, ReasoningStep } from './types'

export interface DeterministicActionContent {
  githubIssue: {
    title: string
    body: string
    labels: string[]
  }
  slackTriage: {
    title: string
    bullets: string[]
    footer: string
  }
  postMortem: {
    title: string
    content: string
  }
  /** A short, human-readable plan line shown in the UI before the actions fire. */
  planLine: string
}

// ---------------------------------------------------------------------------
// Public entry — pick the template by scenarioId (the stable identifier on
// the InjectableSignal). Falls back to a generic-but-still-typed template for
// any future scenario so the closed loop always completes.
// ---------------------------------------------------------------------------

export function buildDeterministicActions(
  sig: InjectableSignal,
  signal: Signal,
  incidentUrn: string,
  steps: ReasoningStep[],
  finalReflection: string,
  lastError: string | null,
): DeterministicActionContent {
  switch (sig.scenarioId) {
    case 'nyc-taxi-freshness':
      return freshnessContent(sig, signal, incidentUrn)
    case 'showcase-ecommerce':
      return schemaContent(sig, signal, incidentUrn)
    case 'pii':
      return piiContent(sig, signal, incidentUrn)
    default:
      return genericContent(sig, signal, incidentUrn, steps, finalReflection, lastError)
  }
}

// ---------------------------------------------------------------------------
// 1. NYC Taxi — freshness breach
// ---------------------------------------------------------------------------

function freshnessContent(
  sig: InjectableSignal,
  signal: Signal,
  incidentUrn: string,
): DeterministicActionContent {
  const asset = sig.assetName
  const labels = ['sentinel', 'auto-filed', 'freshness', 'sla-breach']
  return {
    planLine: `Freshness SLA breach on \`${asset}\` — opening the engineering issue, posting the on-call triage, and writing the post-mortem to DataHub.`,
    githubIssue: {
      title: `[Sentinel] Freshness SLA breach — ${asset} is 6h stale (1h SLA)`,
      body: [
        '## Sentinel autonomous investigation — freshness breach',
        '',
        `**Asset**: \`${signal.assetUrn}\``,
        `**Signal type**: freshness`,
        `**Fired at**: ${signal.firedAt}`,
        `**Failure reason**: ${sig.failureReason ?? 'Asset last modified 6h 02m ago; SLA is 1h (3600s).'}`,
        '',
        '### Root cause',
        `The hourly S3 landing job that materialises \`${asset}\` has not produced a new partition for ~6 hours. ` +
          'The upstream ingestion DAG (`nyc_taxi_s3_landing`) either stalled or lost its schedule — the assertion ' +
          '`freshness_sla_1h` fired when `lastModifiedAt` crossed the 1h SLA threshold.',
        '',
        '### Blast radius (downstream lineage)',
        'Traversing the downstream lineage from the landing table, two consumers are now at risk:',
        '1. `spark_clean_nyc_taxi` — the Spark clean job reads the raw landing table; with stale input it will emit a stale clean partition.',
        '2. `dbt_daily_nyc_taxi` — the dbt daily model depends on the clean job; downstream dashboards (revenue, trip volume) will undercount.',
        '',
        '### Recommended action',
        '- Restart the `nyc_taxi_s3_landing` Airflow DAG and confirm the S3 source connector credentials are valid.',
        '- Backfill the 6 missed hourly partitions (`2026-07-30T00:00` → `2026-07-30T05:00` UTC).',
        '- Verify the freshness assertion returns to passing within the next run.',
        '',
        '> Sentinel opened this issue automatically. It never merges code — the fix is left for human review.',
        '',
        `\`Incident URN: ${incidentUrn}\``,
      ].join('\n'),
      labels,
    },
    slackTriage: {
      title: `🛡️ Freshness breach — ${asset}`,
      bullets: [
        `**What failed**: Freshness SLA breached — \`${asset}\` was last materialised 6h 02m ago vs a 1h SLA. The hourly S3 landing job has missed ~6 consecutive runs.`,
        '**Who is affected**: Downstream `spark_clean_nyc_taxi` and `dbt_daily_nyc_taxi` are reading stale input — revenue and trip-volume dashboards will undercount until the landing table catches up.',
        '**What on-call should do**: Restart the `nyc_taxi_s3_landing` Airflow DAG, confirm the S3 connector is healthy, and backfill the 6 missed hourly partitions.',
      ],
      footer: `Sentinel incident · ${incidentUrn}`,
    },
    postMortem: {
      title: `Sentinel Post-Mortem — ${asset} — freshness SLA breach`,
      content: [
        `# Sentinel Post-Mortem — ${asset} — freshness SLA breach`,
        '',
        `**Signal**: ${signal.assertionUrn}  `,
        `**Type**: freshness  `,
        `**Status**: ${signal.status}  `,
        `**Fired at**: ${signal.firedAt}  `,
        `**Failure reason**: ${sig.failureReason ?? 'Asset last modified 6h 02m ago; SLA is 1h (3600s).'}`,
        '',
        '## Root cause',
        `The upstream S3 landing job (\`nyc_taxi_s3_landing\`) stalled and missed ~6 hourly runs. ` +
          'No new partition was materialised on the raw landing table, so the freshness assertion ' +
          '`freshness_sla_1h` fired when `lastModifiedAt` exceeded the 1h SLA.',
        '',
        '## Blast radius',
        'Two downstream consumers are at risk:',
        '- `spark_clean_nyc_taxi` — stale clean partition.',
        '- `dbt_daily_nyc_taxi` — stale daily model; dashboards undercount.',
        '',
        '## Remediation',
        '- GitHub issue opened in the demo pipeline repo (see actions panel).',
        '- Slack triage card posted to the on-call channel.',
        '- Recommended fix: restart the landing DAG + backfill the 6 missed partitions.',
        '',
        '## Learned SLA',
        'Tighten the freshness assertion to a 45-minute SLA and add a pager on 2 consecutive misses ' +
          'so the on-call is paged before the dashboard goes stale.',
        '',
        '## Compounding',
        'This post-mortem is now attached to the asset. The next freshness incident on `raw_s3_nyc_taxi_trips` ' +
          'should cite it and note what changed since.',
      ].join('\n'),
    },
  }
}

// ---------------------------------------------------------------------------
// 2. Showcase eCommerce — schema breakage
// ---------------------------------------------------------------------------

function schemaContent(
  sig: InjectableSignal,
  signal: Signal,
  incidentUrn: string,
): DeterministicActionContent {
  const asset = sig.assetName
  const labels = ['sentinel', 'auto-filed', 'schema', 'column-rename']
  return {
    planLine: `Schema breakage on \`${asset}\` — the \`region_name\` column was dropped upstream. Opening the issue, posting triage, and writing the post-mortem.`,
    githubIssue: {
      title: `[Sentinel] Schema breakage — \`region_name\` column dropped from Snowflake source`,
      body: [
        '## Sentinel autonomous investigation — schema breakage',
        '',
        `**Asset**: \`${signal.assetUrn}\``,
        `**Signal type**: schema`,
        `**Fired at**: ${signal.firedAt}`,
        `**Failure reason**: ${sig.failureReason ?? 'Field `region_name` dropped from upstream Snowflake view.'}`,
        '',
        '### Root cause',
        'An uncoordinated column rename on the Snowflake source view (`region_name` → `region`) propagated ' +
          'downstream through the full Showcase eCommerce lineage. The schema assertion on the Looker chart ' +
          '`revenue_by_region` failed because it expects 6 fields but the source now exposes only 5.',
        '',
        '### Blast radius (downstream lineage)',
        'The rename cascaded across 4 platforms:',
        '1. **Looker** — chart `revenue_by_region` breaks (missing `region_name` field).',
        '2. **dbt** — `fct_revenue` model fails the schema test.',
        '3. **Spark** — `spark_revenue_clean` drops the column silently.',
        '4. **S3** — `s3_revenue_parquet` persists the broken schema.',
        '',
        '### Recommended action',
        '- **Preferred**: restore the `region_name` alias in the Snowflake source view (`SELECT region AS region_name, ...`) so downstream contracts hold.',
        '- **Alternative**: update the Looker chart `revenue_by_region` field mapping + the dbt schema test to reference `region`, then redeploy.',
        '- Add a schema-contract assertion on the Snowflake source so future renames fail fast at the source, not 4 hops downstream.',
        '',
        '> Sentinel opened this issue automatically. It never merges code — the fix is left for human review.',
        '',
        `\`Incident URN: ${incidentUrn}\``,
      ].join('\n'),
      labels,
    },
    slackTriage: {
      title: `🛡️ Schema breakage — Showcase eCommerce lineage`,
      bullets: [
        '**What failed**: Schema assertion failed — the Looker chart `revenue_by_region` expects 6 fields but the Snowflake source now exposes 5. An uncoordinated rename (`region_name` → `region`) propagated through the lineage.',
        '**Who is affected**: The full Showcase eCommerce lineage is impacted — Looker chart → dbt `fct_revenue` → Spark `spark_revenue_clean` → S3 `s3_revenue_parquet` all carry the broken schema contract.',
        '**What on-call should do**: Restore the `region_name` column alias on the Snowflake source view (or update the Looker + dbt field mappings), then add a schema-contract assertion to prevent silent renames.',
      ],
      footer: `Sentinel incident · ${incidentUrn}`,
    },
    postMortem: {
      title: `Sentinel Post-Mortem — ${asset} — schema breakage`,
      content: [
        `# Sentinel Post-Mortem — ${asset} — schema breakage`,
        '',
        `**Signal**: ${signal.assertionUrn}  `,
        `**Type**: schema  `,
        `**Status**: ${signal.status}  `,
        `**Fired at**: ${signal.firedAt}  `,
        `**Failure reason**: ${sig.failureReason ?? 'Field `region_name` dropped from upstream Snowflake view.'}`,
        '',
        '## Root cause',
        'An uncoordinated column rename on the Snowflake source view (`region_name` → `region`) propagated ' +
          'downstream through Looker, dbt, Spark, and S3. No schema-contract assertion existed on the source, ' +
          'so the rename travelled 4 hops before the Looker chart schema assertion caught it.',
        '',
        '## Blast radius',
        'Four downstream assets carry the broken schema contract:',
        '- Looker chart `revenue_by_region` (assertion failure point).',
        '- dbt model `fct_revenue`.',
        '- Spark job `spark_revenue_clean`.',
        '- S3 dataset `s3_revenue_parquet`.',
        '',
        '## Remediation',
        '- GitHub issue opened in the demo pipeline repo (see actions panel).',
        '- Slack triage card posted to the on-call channel.',
        '- Recommended fix: restore the `region_name` alias on the Snowflake view + add a schema-contract assertion.',
        '',
        '## Learned policy',
        'Add a schema-contract assertion on the Snowflake source view so any future column rename fails at the ' +
          'source (1 hop) instead of propagating 4 hops downstream. The assertion should compare the live schema ' +
          'against the contract on every materialisation.',
        '',
        '## Compounding',
        'This post-mortem is now attached to the asset. The next schema incident on the Showcase eCommerce ' +
          'lineage should cite it and note what changed since.',
      ].join('\n'),
    },
  }
}

// ---------------------------------------------------------------------------
// 3. Customer PII — governance refusal
//    The post-mortem write is REFUSED by the guardrail (PII tag). The GitHub
//    issue + Slack triage still fire so humans are notified of the refusal.
// ---------------------------------------------------------------------------

function piiContent(
  sig: InjectableSignal,
  signal: Signal,
  incidentUrn: string,
): DeterministicActionContent {
  const asset = sig.assetName
  const labels = ['sentinel', 'auto-filed', 'pii', 'governance']
  return {
    planLine: `PII governance gate on \`${asset}\` — Sentinel refused the write-back per the no-PII-write policy. Notifying the on-call + data owner.`,
    githubIssue: {
      title: `[Sentinel] PII governance gate — write-back refused on \`${asset}\``,
      body: [
        '## Sentinel autonomous investigation — PII governance refusal',
        '',
        `**Asset**: \`${signal.assetUrn}\``,
        `**Signal type**: pii (governance)`,
        `**Fired at**: ${signal.firedAt}`,
        `**Failure reason**: ${sig.failureReason ?? 'Consumer requested masked PII columns in clear text.'}`,
        '',
        '### What happened',
        `A downstream consumer requested unmasked PII columns from \`${asset}\`, which is tagged **PII** + **Restricted**. ` +
          "Sentinel's code-level guardrail REFUSED the post-mortem write-back to DataHub — no documentation is " +
          'written to a PII-tagged asset without explicit human approval. This is the correct, governed behaviour.',
        '',
        '### Blast radius',
        'The requesting consumer does NOT receive the unmasked fields. The governance tags on `customer_pii` ' +
          'remain enforced. No data was exposed.',
        '',
        '### Recommended action',
        '- A **data owner** must review the consumer access request and approve or deny unmasked field access.',
        '- If approved, document the decision in the access-control log and update the consumer\'s policy.',
        '- If denied, notify the consumer that the request was refused by the PII governance gate.',
        '',
        '> Sentinel opened this issue automatically. The post-mortem write-back was refused by the guardrail — ' +
          'a human must approve any write to a PII asset.',
        '',
        `\`Incident URN: ${incidentUrn}\``,
      ].join('\n'),
      labels,
    },
    slackTriage: {
      title: `🛡️ PII governance gate — ${asset}`,
      bullets: [
        `**What failed**: A downstream consumer requested unmasked PII columns from \`${asset}\` (tagged PII + Restricted). Sentinel's guardrail REFUSED the write-back — no post-mortem is written to a PII asset without explicit human approval.`,
        '**Who is affected**: The requesting consumer does not receive the unmasked fields. The `customer_pii` governance tags remain enforced — no data was exposed.',
        '**What on-call should do**: A data owner must review the access request, approve or deny unmasked field access, and record the decision in the access-control log.',
      ],
      footer: `Sentinel incident · ${incidentUrn} · guardrail REFUSED write-back`,
    },
    postMortem: {
      // The guardrail will REFUSE this write. The title/content are kept for
      // the audit record; the refusal is the correct, governed outcome.
      title: `Sentinel Post-Mortem — ${asset} — PII governance refusal (BLOCKED)`,
      content: [
        `# Sentinel Post-Mortem — ${asset} — PII governance refusal`,
        '',
        '> **BLOCKED BY GUARDRAIL** — this post-mortem was NOT written to DataHub. The asset is tagged PII + Restricted; a human data owner must approve any write.',
        '',
        `**Signal**: ${signal.assertionUrn}  `,
        `**Type**: pii (governance)  `,
        `**Fired at**: ${signal.firedAt}  `,
        `**Reason**: ${sig.failureReason ?? 'Consumer requested masked PII columns in clear text.'}`,
        '',
        '## Outcome',
        'Sentinel refused the write-back per the no-PII-write policy. The GitHub issue + Slack triage were ' +
          'still filed so humans are notified. A data owner must approve any documentation of this incident.',
      ].join('\n'),
    },
  }
}

// ---------------------------------------------------------------------------
// Generic fallback — for any future scenario. Still typed so the closed loop
// completes, but uses the signal metadata rather than bespoke prose.
// ---------------------------------------------------------------------------

function genericContent(
  sig: InjectableSignal,
  signal: Signal,
  incidentUrn: string,
  steps: ReasoningStep[],
  finalReflection: string,
  lastError: string | null,
): DeterministicActionContent {
  const asset = sig.assetName
  const labels = ['sentinel', 'auto-filed', signal.type]
  const pmContent = [
    `# Sentinel Post-Mortem — ${asset} — ${signal.type}`,
    '',
    `**Signal**: ${signal.assertionUrn}  `,
    `**Type**: ${signal.type}  `,
    `**Status**: ${signal.status}  `,
    `**Fired at**: ${signal.firedAt}  `,
    `**Failure reason**: ${sig.failureReason ?? '(none recorded)'}`,
    '',
    '## Reasoning trace',
    '',
    ...steps.map((s, i) => `- **Step ${i}** (${s.kind})${s.toolName ? ` ${s.toolName}` : ''}: ${(s.reasoning ?? JSON.stringify(s.toolResult ?? s.error ?? '')).slice(0, 240)}`),
    '',
    '## Final reflection',
    '',
    finalReflection || '(agent produced no final reflection)',
    '',
    lastError ? `## Error\n\n**${lastError}**\n` : '',
    '## Compounding',
    '',
    'This post-mortem is now part of the asset context. The next incident on this asset should cite it.',
  ].join('\n')
  return {
    planLine: `${signal.type} incident on \`${asset}\` — opening the issue, posting triage, and writing the post-mortem.`,
    githubIssue: {
      title: `[Sentinel] ${signal.type} incident — ${asset}`,
      body: [
        '## Sentinel autonomous investigation',
        '',
        `**Asset**: \`${signal.assetUrn}\``,
        `**Signal type**: ${signal.type}`,
        `**Fired at**: ${signal.firedAt}`,
        `**Failure reason**: ${sig.failureReason ?? '(see assertion details)'}`,
        '',
        '### Summary',
        `Sentinel detected a ${signal.type} breach on \`${asset}\` and autonomously investigated. ` +
          'A Slack triage card has been posted to the on-call channel.',
        '',
        `> Incident URN: \`${incidentUrn}\``,
      ].join('\n'),
      labels,
    },
    slackTriage: {
      title: `Sentinel: ${signal.type} on ${asset}`,
      bullets: [
        `**What failed**: ${signal.type} assertion failed on \`${asset}\` — ${sig.failureReason ?? 'SLA breach detected'}.`,
        `**Who is affected**: Downstream consumers of \`${asset}\` (see lineage graph in the Sentinel dashboard).`,
        '**What on-call should do**: Review the GitHub issue filed by Sentinel and verify the upstream ingestion job.',
      ],
      footer: `Sentinel incident · ${incidentUrn}`,
    },
    postMortem: {
      title: `Sentinel Post-Mortem — ${asset} — ${signal.type}`,
      content: pmContent,
    },
  }
}
