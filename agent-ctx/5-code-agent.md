# Task 5: Add 3 new features to Sentinel dashboard

## Summary

Added three new features to `/home/z/my-project/src/app/page.tsx`:

### 1. PerformanceAnalytics Panel
- Added between MetricsCard and ConnectorStatusCard in the right column
- Shows resolution rate (stacked bar: resolved/degraded/failed)
- Shows avg response time (time between createdAt and resolvedAt)
- Shows efficiency metrics (avg steps, tool calls, writebacks per incident)
- Shows scenario breakdown by signal type (freshness, schema, pii, quality)
- Accepts `incidents: IncidentListItem[]` as prop

### 2. Export Incident Report Button
- Added to RunSummaryCard's header (right-aligned, ml-auto)
- Uses `Download` icon from lucide-react (added to imports)
- Downloads a JSON file with: incident details, reasoning steps, total tokens, LLM model/provider, failover info, prompt version, and export timestamp
- Filename format: `sentinel-incident-{timestamp}.json`
- Uses `Blob` + `URL.createObjectURL` + programmatic `<a>` click pattern

### 3. DataHubHealthPanel
- Added after ConnectorStatusCard in the right column
- Shows DataHub connection status (always connected in demo mode)
- Shows seeded asset count
- Shows assertion pass/fail status with progress bar
- Shows MCP tools list (expandable, 15 tools)
- Shows last write-back from context docs
- Fetches from `/api/datahub/status` and `/api/datahub/seed/overview` using useQuery

## Changes Made
- Line 18: Added `Download` to lucide-react imports
- Lines 2275-2443: Added `PerformanceAnalytics` component
- Lines 2445-2625: Added `DataHubHealthPanel` component + interfaces + MCP_TOOLS constant
- Lines 1025-1027: Wired new components into Console JSX right column
- Lines 3717-3744: Added Export button in RunSummaryCard header

## Verification
- `bun run lint` passed with no errors
- Dev server running on localhost:3000
- Both new API endpoints (`/api/datahub/status`, `/api/datahub/seed/overview`) returning 200
