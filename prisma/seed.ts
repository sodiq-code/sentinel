// =============================================================================
// Sentinel — deterministic Prisma seed (DEMO mode substrate)
//
// Seed data.
//
// Three scenarios, all license-safe and deterministic:
//
//   1. nyc-taxi-freshness — the primary demo. 3-stage pipeline
//      (raw S3 → Spark clean → dbt daily revenue dashboard), owner
//      "Priya Patel", glossary terms [revenue, daily_metric], a planted
//      freshness assertion on the raw S3 asset that FAILS (lastModifiedAt
//      is stale relative to SLA), and one prior post-mortem context doc
//      on the spark asset so Run 2 of the demo visibly compounding.
//
//   2. showcase-ecommerce — cross-platform lineage
//      (Snowflake → Looker → dbt → Spark → S3) for the 2nd scenario
//      (schema breakage).
//
//   3. pii — a customer_pii table tagged with the PII governance tag, for
//      the 3rd scenario (guardrail refusal beat).
//
// Idempotent: re-running drops the seed rows and re-inserts them so the
// demo always starts from a known state. Run with `bun run db:seed`.
// =============================================================================

import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

// Connect via the libSQL driver adapter so the seed works against either a
// local SQLite file (file: URL) or a managed Turso database (libsql:// URL).
// The adapter handles the wire protocol; the PrismaClient just talks to it.
function makePrisma(): PrismaClient {
  const url = process.env.DATABASE_URL ?? ''
  if (url.startsWith('libsql:') || url.startsWith('libsqls:')) {
    const adapter = new PrismaLibSql({
      url,
      authToken: process.env.DATABASE_AUTH_TOKEN,
    })
    return new PrismaClient({ adapter })
  }
  return new PrismaClient()
}

// Use the shared db client when imported as a module (so the live Next.js
// server uses the same connection pool); fall back to a CLI client above.
let prisma: PrismaClient
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../src/lib/db')
  prisma = (mod.db ?? makePrisma()) as PrismaClient
} catch {
  prisma = makePrisma()
}

// A fixed "now" so the freshness breach is deterministic across runs.
// The raw S3 asset was last modified 6 hours ago; its SLA is 1 hour → fails.
// All `lastModifiedAt` values are stored as SECONDS-since-epoch (Int32) to
// work around a libsql/Turso driver quirk where INTEGER columns are returned
// as Float, which Prisma's BigInt column rejects on read. The mock-datahub
// reader multiplies by 1000 to restore ms for the API wire format. Date
// columns (lastSuccessAt, createdAt) keep ms.
const NOW = Date.parse('2026-07-28T08:00:00.000Z')
const SIX_HOURS_AGO = NOW - 6 * 60 * 60 * 1000
const TWO_HOURS_AGO = NOW - 2 * 60 * 60 * 1000
const ONE_HOUR_AGO = NOW - 60 * 60 * 1000
const TWO_DAYS_AGO = NOW - 2 * 24 * 60 * 60 * 1000
// Seconds-since-epoch for the `Int?` lastModifiedAt column.
const sec = (ms: number) => Math.floor(ms / 1000)

// ---------------------------------------------------------------------------
// URNs — DataHub-format. These exact strings are what the orchestrator
// and the UI display, so centralising them prevents
// typos between seed and mock.
// ---------------------------------------------------------------------------

const URNS = {
  // nyc-taxi
  rawS3: 'urn:li:dataset:(urn:li:dataPlatform:s3,raw_s3_nyc_taxi_trips,PROD)',
  sparkClean: 'urn:li:dataset:(urn:li:dataPlatform:spark,spark_nyc_taxi_clean,PROD)',
  dbtDaily: 'urn:li:dataset:(urn:li:dataPlatform:dbt,dbt_daily_revenue_dashboard,PROD)',
  sparkFlow: 'urn:li:dataFlow:(urn:li:dataPlatform:airflow,spark_nyc_taxi_clean,PROD)',
  dbtFlow: 'urn:li:dataFlow:(urn:li:dataPlatform:airflow,dbt_daily_revenue_dashboard,PROD)',
  // glossary + owner + domain
  priya: 'urn:li:corpUser:priya.patel',
  termRevenue: 'urn:li:glossaryTerm:revenue',
  termDailyMetric: 'urn:li:glossaryTerm:daily_metric',
  domainFinance: 'urn:li:domain:Finance',
  priorPostMortem: 'urn:li:document:prior-postmortem-spark-nyc-taxi-clean',
  // showcase-ecommerce
  snowRaw: 'urn:li:dataset:(urn:li:dataPlatform:snowflake,raw_orders,PROD)',
  lookerChart: 'urn:li:chart:(urn:li:dataPlatform:looker,orders_daily_chart,PROD)',
  dbtModel: 'urn:li:dataset:(urn:li:dataPlatform:dbt,fct_orders_clean,PROD)',
  sparkJob: 'urn:li:dataset:(urn:li:dataPlatform:spark,orders_enriched,PROD)',
  s3Landing: 'urn:li:dataset:(urn:li:dataPlatform:s3,orders_enriched_parquet,PROD)',
  // PII
  piiTable: 'urn:li:dataset:(urn:li:dataPlatform:postgres,customer_pii,PROD)',
  // assertions
  failingFreshness: 'urn:li:assertion:freshness:raw_s3_nyc_taxi_trips:sla',
  passingFreshnessSpark: 'urn:li:assertion:freshness:spark_nyc_taxi_clean:sla',
  passingFreshnessDbt: 'urn:li:assertion:freshness:dbt_daily_revenue_dashboard:sla',
  schemaAssertion: 'urn:li:assertion:schema:spark_nyc_taxi_clean',
} as const

// ---------------------------------------------------------------------------
// nyc-taxi scenario assets
// ---------------------------------------------------------------------------

const nycAssets = [
  {
    urn: URNS.rawS3,
    name: 'raw_s3_nyc_taxi_trips',
    platform: 's3',
    type: 'dataset',
    description:
      'Raw NYC taxi trip data landed hourly from the TLC S3 bucket. Source of truth for the downstream pipeline. A freshness SLA of 1h is enforced on this asset.',
    ownersJson: JSON.stringify([
      { ownerUrn: URNS.priya, ownerType: 'USER' as const, name: 'Priya Patel' },
    ]),
    glossaryTermsJson: JSON.stringify([
      { urn: URNS.termDailyMetric, name: 'daily_metric', description: 'A metric aggregated at daily granularity.' },
    ]),
    governanceTagsJson: JSON.stringify([]),
    schemaFieldsJson: JSON.stringify([
      { name: 'vendor_id', type: 'string', nullable: true, nativeDataType: 'VARCHAR(8)' },
      { name: 'pickup_datetime', type: 'timestamp', nullable: false, nativeDataType: 'TIMESTAMP' },
      { name: 'dropoff_datetime', type: 'timestamp', nullable: false, nativeDataType: 'TIMESTAMP' },
      { name: 'passenger_count', type: 'int', nullable: true, nativeDataType: 'INT' },
      { name: 'trip_distance', type: 'double', nullable: true, nativeDataType: 'DOUBLE' },
      { name: 'fare_amount', type: 'double', nullable: true, nativeDataType: 'DOUBLE' },
      { name: 'total_amount', type: 'double', nullable: true, nativeDataType: 'DOUBLE' },
    ]),
    lastModifiedAt: sec(SIX_HOURS_AGO), // stale — planted freshness breach
    platformNativeName: 's3://nyc-tlc/trips/raw/',
    scenarioId: 'nyc-taxi-freshness',
  },
  {
    urn: URNS.sparkClean,
    name: 'spark_nyc_taxi_clean',
    platform: 'spark',
    type: 'dataset',
    description:
      'Cleaned NYC taxi trips. The Spark job filters zero-distance trips and casts types. Owned by Priya Patel; tagged with the `daily_metric` glossary term. A prior post-mortem exists for this asset (Run 2 compounding evidence).',
    ownersJson: JSON.stringify([
      { ownerUrn: URNS.priya, ownerType: 'USER' as const, name: 'Priya Patel' },
    ]),
    glossaryTermsJson: JSON.stringify([
      { urn: URNS.termDailyMetric, name: 'daily_metric' },
      { urn: URNS.termRevenue, name: 'revenue', description: 'Monetary inflow, the primary business metric.' },
    ]),
    governanceTagsJson: JSON.stringify([]),
    schemaFieldsJson: JSON.stringify([
      { name: 'vendor_id', type: 'string', nullable: false, isPrimaryKey: true, nativeDataType: 'STRING' },
      { name: 'pickup_datetime', type: 'timestamp', nullable: false, nativeDataType: 'TIMESTAMP' },
      { name: 'dropoff_datetime', type: 'timestamp', nullable: false, nativeDataType: 'TIMESTAMP' },
      { name: 'passenger_count', type: 'int', nullable: false, nativeDataType: 'INT' },
      { name: 'trip_distance', type: 'double', nullable: false, nativeDataType: 'DOUBLE' },
      { name: 'fare_amount', type: 'double', nullable: false, nativeDataType: 'DOUBLE' },
      { name: 'total_amount', type: 'double', nullable: false, nativeDataType: 'DOUBLE' },
    ]),
    lastModifiedAt: sec(TWO_HOURS_AGO), // fresh
    platformNativeName: 's3://nyc-tlc/clean/',
    scenarioId: 'nyc-taxi-freshness',
  },
  {
    urn: URNS.dbtDaily,
    name: 'dbt_daily_revenue_dashboard',
    platform: 'dbt',
    type: 'dataset',
    description:
      'Daily revenue dashboard source table. Aggregates `spark_nyc_taxi_clean` by date. Consumed by the BI dashboard. Tagged with the `revenue` glossary term.',
    ownersJson: JSON.stringify([
      { ownerUrn: URNS.priya, ownerType: 'USER' as const, name: 'Priya Patel' },
    ]),
    glossaryTermsJson: JSON.stringify([
      { urn: URNS.termRevenue, name: 'revenue', description: 'Monetary inflow, the primary business metric.' },
    ]),
    governanceTagsJson: JSON.stringify([]),
    schemaFieldsJson: JSON.stringify([
      { name: 'date', type: 'date', nullable: false, isPrimaryKey: true, nativeDataType: 'DATE' },
      { name: 'revenue', type: 'double', nullable: false, nativeDataType: 'DOUBLE' },
      { name: 'trips', type: 'long', nullable: false, nativeDataType: 'BIGINT' },
    ]),
    lastModifiedAt: sec(ONE_HOUR_AGO), // fresh
    platformNativeName: 'analytics.daily_revenue_dashboard',
    scenarioId: 'nyc-taxi-freshness',
  },
]

const nycLineage = [
  { fromUrn: URNS.rawS3, toUrn: URNS.sparkClean, via: URNS.sparkFlow, scenarioId: 'nyc-taxi-freshness' },
  { fromUrn: URNS.sparkClean, toUrn: URNS.dbtDaily, via: URNS.dbtFlow, scenarioId: 'nyc-taxi-freshness' },
]

const nycAssertions = [
  {
    urn: URNS.failingFreshness,
    assetUrn: URNS.rawS3,
    type: 'freshness',
    status: 'failing',
    description:
      'Freshness SLA: raw_s3_nyc_taxi_trips must be modified at least every 1h. Currently 6h stale — the S3 ingestion job has not written since 02:00.',
    slaSeconds: 3600,
    lastEvaluatedAt: new Date(NOW),
    lastSuccessAt: new Date(TWO_HOURS_AGO),
    failureReason:
      'Dataset not modified in 6h (SLA 1h). Last success 2h ago. Last evaluated at 08:00 UTC.',
    scenarioId: 'nyc-taxi-freshness',
  },
  {
    urn: URNS.passingFreshnessSpark,
    assetUrn: URNS.sparkClean,
    type: 'freshness',
    status: 'passing',
    description: 'Freshness SLA: spark_nyc_taxi_clean modified every 4h.',
    slaSeconds: 14400,
    lastEvaluatedAt: new Date(NOW),
    lastSuccessAt: new Date(TWO_HOURS_AGO),
    failureReason: null,
    scenarioId: 'nyc-taxi-freshness',
  },
  {
    urn: URNS.passingFreshnessDbt,
    assetUrn: URNS.dbtDaily,
    type: 'freshness',
    status: 'passing',
    description: 'Freshness SLA: dbt_daily_revenue_dashboard refreshed every 6h.',
    slaSeconds: 21600,
    lastEvaluatedAt: new Date(NOW),
    lastSuccessAt: new Date(ONE_HOUR_AGO),
    failureReason: null,
    scenarioId: 'nyc-taxi-freshness',
  },
  {
    urn: URNS.schemaAssertion,
    assetUrn: URNS.sparkClean,
    type: 'schema',
    status: 'passing',
    description: 'Schema assertion: spark_nyc_taxi_clean has 7 columns, none nullable (after cleaning).',
    slaSeconds: null,
    lastEvaluatedAt: new Date(NOW),
    lastSuccessAt: new Date(NOW),
    failureReason: null,
    scenarioId: 'nyc-taxi-freshness',
  },
]

const priorPostMortem = {
  urn: URNS.priorPostMortem,
  assetUrn: URNS.sparkClean,
  title: 'Post-mortem: spark_nyc_taxi_clean freshness breach (2026-07-20)',
  content: `# Post-mortem: spark_nyc_taxi_clean freshness breach (2026-07-20)

## Summary
On 2026-07-20 the spark_nyc_taxi_clean dataset was 5h stale against a 4h SLA.
The Spark job airflow:spark_nyc_taxi_clean had failed silently at 03:00 UTC
because the upstream raw_s3_nyc_taxi_trips partition was empty (the S3
ingestion job wrote 0 records — the source TLC bucket was temporarily rate-
limited).

## Root cause
- **Direct**: Spark job failed on empty partition (the job expected ≥1 record).
- **Underlying**: The S3 ingestion job had no alert for zero-record writes.

## Resolution
- Added an upstream assertion on raw_s3_nyc_taxi_trips: row_count > 0
  within the last 1h.
- Spark job now skips empty partitions with a warning instead of failing.

## Learned policy (proposed to DataHub)
- A freshness SLA of 1h on raw_s3_nyc_taxi_trips (this assertion).
- Owner: Priya Patel (already set).

## Compounding note
This is the Sentinel-authored post-mortem from the 2026-07-20 incident.
On re-investigation of a similar failure, Sentinel should read this doc
first and shorten the reasoning trace.`,
  format: 'markdown',
  createdAt: new Date(TWO_DAYS_AGO),
  authorUrn: 'urn:li:corpUser:sentinel',
  authorName: 'Sentinel Agent',
  sentinelPostMortem: true,
  scenarioId: 'nyc-taxi-freshness',
}

// ---------------------------------------------------------------------------
// showcase-ecommerce scenario — cross-platform schema breakage
// ---------------------------------------------------------------------------

const ecommerceAssets = [
  {
    urn: URNS.snowRaw,
    name: 'raw_orders',
    platform: 'snowflake',
    type: 'dataset',
    description: 'Raw orders from the eCommerce OLTP replica. 1.2M rows/day.',
    ownersJson: JSON.stringify([
      { ownerUrn: 'urn:li:corpUser:marcus.lee', ownerType: 'USER' as const, name: 'Marcus Lee' },
    ]),
    glossaryTermsJson: JSON.stringify([
      { urn: 'urn:li:glossaryTerm:order', name: 'order' },
    ]),
    governanceTagsJson: JSON.stringify([]),
    schemaFieldsJson: JSON.stringify([
      { name: 'order_id', type: 'string', nullable: false, isPrimaryKey: true },
      { name: 'customer_id', type: 'string', nullable: false },
      { name: 'order_total', type: 'double', nullable: false },
      { name: 'currency', type: 'string', nullable: false },
      { name: 'created_at', type: 'timestamp', nullable: false },
    ]),
    lastModifiedAt: sec(ONE_HOUR_AGO),
    platformNativeName: 'ecom.raw_orders',
    scenarioId: 'showcase-ecommerce',
  },
  {
    urn: URNS.lookerChart,
    name: 'orders_daily_chart',
    platform: 'looker',
    type: 'chart',
    description: 'Looker chart of daily order volume, consumed by the sales dashboard.',
    ownersJson: JSON.stringify([
      { ownerUrn: 'urn:li:corpUser:marcus.lee', ownerType: 'USER' as const, name: 'Marcus Lee' },
    ]),
    glossaryTermsJson: JSON.stringify([
      { urn: 'urn:li:glossaryTerm:daily_metric', name: 'daily_metric' },
    ]),
    governanceTagsJson: JSON.stringify([]),
    schemaFieldsJson: JSON.stringify([]),
    lastModifiedAt: sec(ONE_HOUR_AGO),
    platformNativeName: 'looker:orders_daily_chart',
    scenarioId: 'showcase-ecommerce',
  },
  {
    urn: URNS.dbtModel,
    name: 'fct_orders_clean',
    platform: 'dbt',
    type: 'dataset',
    description: 'dbt model that joins raw_orders with the customer dimension. Phase 5 plants a schema break here (a `currency` column dropped upstream).',
    ownersJson: JSON.stringify([
      { ownerUrn: 'urn:li:corpUser:marcus.lee', ownerType: 'USER' as const, name: 'Marcus Lee' },
    ]),
    glossaryTermsJson: JSON.stringify([
      { urn: 'urn:li:glossaryTerm:order', name: 'order' },
    ]),
    governanceTagsJson: JSON.stringify([]),
    schemaFieldsJson: JSON.stringify([
      { name: 'order_id', type: 'string', nullable: false, isPrimaryKey: true },
      { name: 'customer_id', type: 'string', nullable: false },
      { name: 'order_total', type: 'double', nullable: false },
      { name: 'currency', type: 'string', nullable: false },
      { name: 'created_at', type: 'timestamp', nullable: false },
    ]),
    lastModifiedAt: sec(ONE_HOUR_AGO),
    platformNativeName: 'analytics.fct_orders_clean',
    scenarioId: 'showcase-ecommerce',
  },
  {
    urn: URNS.sparkJob,
    name: 'orders_enriched',
    platform: 'spark',
    type: 'dataset',
    description: 'Spark-enriched orders: geo + LTV join. Consumed by the BI export.',
    ownersJson: JSON.stringify([
      { ownerUrn: 'urn:li:corpUser:marcus.lee', ownerType: 'USER' as const, name: 'Marcus Lee' },
    ]),
    glossaryTermsJson: JSON.stringify([
      { urn: 'urn:li:glossaryTerm:order', name: 'order' },
    ]),
    governanceTagsJson: JSON.stringify([]),
    schemaFieldsJson: JSON.stringify([
      { name: 'order_id', type: 'string', nullable: false },
      { name: 'customer_id', type: 'string', nullable: false },
      { name: 'order_total', type: 'double', nullable: false },
      { name: 'customer_ltv', type: 'double', nullable: true },
    ]),
    lastModifiedAt: sec(ONE_HOUR_AGO),
    platformNativeName: 's3://ecom/orders_enriched/',
    scenarioId: 'showcase-ecommerce',
  },
  {
    urn: URNS.s3Landing,
    name: 'orders_enriched_parquet',
    platform: 's3',
    type: 'dataset',
    description: 'Landing parquet copy of the enriched orders, consumed by the BI export job.',
    ownersJson: JSON.stringify([
      { ownerUrn: 'urn:li:corpUser:marcus.lee', ownerType: 'USER' as const, name: 'Marcus Lee' },
    ]),
    glossaryTermsJson: JSON.stringify([]),
    governanceTagsJson: JSON.stringify([]),
    schemaFieldsJson: JSON.stringify([
      { name: 'order_id', type: 'string', nullable: false },
      { name: 'order_total', type: 'double', nullable: false },
    ]),
    lastModifiedAt: sec(ONE_HOUR_AGO),
    platformNativeName: 's3://ecom/landing/orders_enriched_parquet',
    scenarioId: 'showcase-ecommerce',
  },
]

const ecommerceLineage = [
  { fromUrn: URNS.snowRaw, toUrn: URNS.lookerChart, via: undefined, scenarioId: 'showcase-ecommerce' },
  { fromUrn: URNS.snowRaw, toUrn: URNS.dbtModel, via: undefined, scenarioId: 'showcase-ecommerce' },
  { fromUrn: URNS.dbtModel, toUrn: URNS.sparkJob, via: undefined, scenarioId: 'showcase-ecommerce' },
  { fromUrn: URNS.sparkJob, toUrn: URNS.s3Landing, via: undefined, scenarioId: 'showcase-ecommerce' },
]

// ---------------------------------------------------------------------------
// PII scenario — governance refusal beat
// ---------------------------------------------------------------------------

const piiAssets = [
  {
    urn: URNS.piiTable,
    name: 'customer_pii',
    platform: 'postgres',
    type: 'dataset',
    description:
      'Customer PII table (email, phone, full_name, billing_address). Tagged PII. Sentinel must REFUSE to act without explicit human approval (governance guardrail).',
    ownersJson: JSON.stringify([
      { ownerUrn: 'urn:li:corpUser:compliance.officer', ownerType: 'USER' as const, name: 'Compliance Officer' },
    ]),
    glossaryTermsJson: JSON.stringify([]),
    governanceTagsJson: JSON.stringify([
      { name: 'PII', level: 'CLASSIFICATION' as const },
      { name: 'Restricted', level: 'CLASSIFICATION' as const },
    ]),
    schemaFieldsJson: JSON.stringify([
      { name: 'customer_id', type: 'string', nullable: false, isPrimaryKey: true },
      { name: 'email', type: 'string', nullable: false },
      { name: 'phone', type: 'string', nullable: true },
      { name: 'full_name', type: 'string', nullable: false },
      { name: 'billing_address', type: 'string', nullable: true },
    ]),
    lastModifiedAt: sec(ONE_HOUR_AGO),
    platformNativeName: 'pg.customer_pii',
    scenarioId: 'pii',
  },
]

// ---------------------------------------------------------------------------
// Seed runner — idempotent: delete then insert.
// ---------------------------------------------------------------------------

// Exported for reuse by the Vercel cold-start auto-seed
// (src/lib/ensure-seeded.ts). Idempotent: delete then insert.
export async function runSeed(): Promise<void> {
  console.log('🌱 Sentinel seed — starting (deterministic, idempotent)')

  // Wipe seed tables (and demo incident tables so the demo always starts clean).
  await prisma.auditEvent.deleteMany()
  await prisma.writeBack.deleteMany()
  await prisma.action.deleteMany()
  await prisma.toolCall.deleteMany()
  await prisma.signalRecord.deleteMany()
  await prisma.pendingApproval.deleteMany()
  await prisma.incident.deleteMany()

  await prisma.seedContextDoc.deleteMany()
  await prisma.seedAssertion.deleteMany()
  await prisma.seedLineageEdge.deleteMany()
  await prisma.seedAsset.deleteMany()

  // Assets
  const allAssets = [...nycAssets, ...ecommerceAssets, ...piiAssets]
  for (const a of allAssets) {
    await prisma.seedAsset.create({ data: a })
  }
  console.log(`  ✓ ${allAssets.length} seed assets`)

  // Lineage edges
  const allEdges = [...nycLineage, ...ecommerceLineage]
  for (const e of allEdges) {
    await prisma.seedLineageEdge.create({
      data: {
        fromUrn: e.fromUrn,
        toUrn: e.toUrn,
        via: e.via ?? null,
        scenarioId: e.scenarioId,
      },
    })
  }
  console.log(`  ✓ ${allEdges.length} lineage edges`)

  // Assertions
  const allAssertions = [...nycAssertions]
  for (const a of allAssertions) {
    await prisma.seedAssertion.create({
      data: {
        urn: a.urn,
        assetUrn: a.assetUrn,
        type: a.type,
        status: a.status,
        description: a.description,
        slaSeconds: a.slaSeconds,
        lastEvaluatedAt: a.lastEvaluatedAt,
        lastSuccessAt: a.lastSuccessAt,
        failureReason: a.failureReason,
        scenarioId: a.scenarioId,
      },
    })
  }
  console.log(`  ✓ ${allAssertions.length} assertions (1 failing freshness — planted)`)

  // Prior post-mortem (Run 2 compounding evidence)
  await prisma.seedContextDoc.create({ data: priorPostMortem })
  console.log(`  ✓ 1 prior post-mortem (Run 2 compounding evidence)`)

  console.log('')
  console.log('🌱 Sentinel seed — complete')
  console.log('  Scenarios:')
  console.log('    • nyc-taxi-freshness  — 3-stage pipeline, planted freshness breach')
  console.log('    • showcase-ecommerce  — cross-platform lineage (5 assets)')
  console.log('    • pii                 — customer_pii tagged PII (guardrail refusal beat)')
  console.log('')
  console.log('  Try:  bun run db:print-lineage urn:li:dataset:(urn:li:dataPlatform:dbt,dbt_daily_revenue_dashboard,PROD)')
}

// When run as a CLI script (`bun run db:seed`), invoke the seed + exit.
// When imported as a module (Vercel cold-start), runSeed() is called by the
// caller — this top-level invocation is skipped.
if (require.main === module) {
  runSeed()
    .then(() => {
      console.log('\n✓ Seed complete.')
    })
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
    .finally(async () => {
      await prisma.$disconnect()
    })
}
