// =============================================================================
// Sentinel — `bun run db:print-lineage <urn>` — the Phase 1 deliverable
//
// v2 plan §"Phase 1 — DataHub Mock + Seed": "A script that prints lineage · 1 day"
//
// Renders the lineage tree of a dataset URN using the MockMcpClient against
// the seeded Prisma data. In LIVE mode it would use LiveMcpClient (Phase 2).
//
// Usage:
//   bun run db:print-lineage urn:li:dataset:(urn:li:dataPlatform:dbt,dbt_daily_revenue_dashboard,PROD)
//   bun run db:print-lineage urn:li:dataset:(urn:li:dataPlatform:s3,raw_s3_nyc_taxi_trips,PROD) --upstream
//
// If no URN is given, prints the lineage of the dbt dashboard (the demo head).
// =============================================================================

import { printLineage } from '../src/lib/datahub/mock/mock-datahub'

async function main() {
  const arg = process.argv[2]
  const directionFlag = process.argv[3]
  const direction =
    directionFlag === '--upstream'
      ? ('upstream' as const)
      : ('downstream' as const)

  // Default to the raw S3 asset so downstream shows the full 3-stage pipeline.
  const defaultUrn =
    'urn:li:dataset:(urn:li:dataPlatform:s3,raw_s3_nyc_taxi_trips,PROD)'
  const urn = arg || defaultUrn

  console.log('')
  console.log(`Sentinel — lineage for ${direction === 'upstream' ? 'upstream' : 'downstream'}`)
  console.log('─'.repeat(72))
  const out = await printLineage(urn, direction, 3)
  console.log(out)
  console.log('')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
