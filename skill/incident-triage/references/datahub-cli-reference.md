# DataHub CLI — reference for the incident-triage Skill

This document lists the DataHub CLI commands the incident-triage Skill (and the Sentinel agent) composes. The Skill itself runs via the MCP Server + Agent Context Kit; the CLI is provided as a fallback and for deterministic assertion setup (the planted freshness issue is created explicitly so it fires deterministically).

Verified against https://docs.datahub.com/docs/cli/

---

## Install

```bash
python -m venv .venv && source .venv/bin/activate
pip install acryl-datahub==0.13.3.3
datahub version
```

Pinned in the Sentinel repo.

---

## Authentication

```bash
export DATAHUB_GMS_URL=http://localhost:8080
export DATAHUB_TOKEN=<your-datahub-pat>
datahub version
```

---

## Read commands (the CLI form of the 12 MCP read tools)

### `datahub get`

```bash
datahub get --urn "urn:li:dataset:(urn:li:dataPlatform:dbt,nyc_yellow_taxi_trips,PROD)"
```

Returns the entity JSON (the same payload as `mcp.get_entities`).

### `datahub lineage`

```bash
datahub lineage --urn "<urn>" --direction UPSTREAM
datahub lineage --urn "<urn>" --direction DOWNSTREAM
```

Returns the lineage graph (same as `mcp.get_lineage`).

### `datahub search`

```bash
datahub search --query "nyc taxi" --entity-type dataset --count 10
```

Same as `mcp.search`.

---

## Write commands (the CLI form of the Agent Context Kit mutations)

### `datahub ingest` (the REST fallback path)

```bash
datahub ingest --aspect-json <(echo '{"entityType": "dataset", "entityUrn": "...", "aspect": {...}}')
```

Used when the Agent Context Kit fails. Pinned version ensures the aspect schema matches.

### `datahub assertions` (the only direct write — reversible)

```bash
datahub assertions add --entity-urn "<urn>" --type freshness --schedule-cron "*/15 * * * *"
datahub assertions list --entity-urn "<urn>"
datahub assertions delete --urn "<assertion-urn>"
```

The DemoDriver calls `assertions add` explicitly during setup so the planted freshness issue fires deterministically.

---

## Demo replay

The Sentinel dashboard (`bun run dev`) drives the closed-loop demo end-to-end through the same incident console UI:

- **Inject signal** — fire one of the three seeded signals (freshness, schema, PII) and watch Sentinel triage → act → write back, live.
- **Replay loop** — the compounding demo: Run 1 writes a post-mortem to DataHub, Run 2 reads it.
- **Dry-run trace** — a pinned, pre-recorded tool-call trace (`examples/dry-run/nyc-taxi-freshness.json`) replays through the same UI when `SENTINEL_DRY_RUN=true` (the default for a fresh clone). The full reasoning stream, lineage graph, and write-backs render without a live LLM call.

Supporting scripts:

```bash
bun run db:seed          # seed the local SQLite/Turso catalog with the 3 scenarios
bun run db:print-lineage # render the seeded lineage tree to the terminal
bun run demo:fixtures    # regenerate the dry-run + demo-replay JSON fixtures
bun run dev              # start the incident console at http://localhost:3000
```

The dry-run trace replays through the SAME incident console UI — judges can't tell the difference from a live run.

---

## Pinned versions

See `package.json` and the README's pinned versions table.

| Component | Pinned version |
|---|---|
| acryl-datahub | 0.13.3.3 |
| datahub-mcp-server | 0.0.4 |
| datahub-agent-context-kit (langchain) | latest, pinned via lockfile |

---

## See also

- DataHub CLI docs: https://docs.datahub.com/docs/cli/
- DataHub GraphQL API: https://docs.datahub.com/docs/api/graphql/
- DataHub REST API: https://docs.datahub.com/docs/api/graphql/
