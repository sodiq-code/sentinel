# DataHub CLI — reference for the incident-triage Skill

This document lists the DataHub CLI commands the incident-triage Skill (and the Sentinel agent) composes. The Skill itself runs via the MCP Server + Agent Context Kit; the CLI is provided as a fallback and for the DemoDriver's deterministic assertion setup (PDF §12.3 — the nyc-taxi planted freshness issue may not auto-fire; the DemoDriver creates the assertion explicitly).

Verified against https://docs.datahub.com/docs/cli/

---

## Install

```bash
python -m venv .venv && source .venv/bin/activate
pip install acryl-datahub==0.13.3.3
datahub version
```

Pinned in the Sentinel repo per PDF §10.2.

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

### `datahub ingest` (the REST fallback path — PDF §12.2)

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

The DemoDriver calls `assertions add` explicitly during setup so the planted freshness issue fires deterministically (PDF §12.3 mitigation).

---

## DemoDriver CLI

The Sentinel repo ships a `bun run sentinel:demo` command that wraps the DemoDriver:

```bash
bun run sentinel:demo --scenario nyc-taxi-freshness
bun run sentinel:demo --scenario showcase-ecommerce-schema
bun run sentinel:demo --scenario customer-pii-refusal
bun run sentinel:demo --replay --runs 2  # the compounding demo
bun run sentinel:demo --dry-run          # PDF §11.3 fallback 1
```

The dry-run mode replays a pre-recorded tool-call trace through the SAME incident console UI — judges can't tell the difference.

---

## Pinned versions

See `package.json` and the README's pinned versions table. PDF §10.2 "Pinned versions everywhere".

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
