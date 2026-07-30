# DataHub MCP Tools — reference for the incident-triage Skill

This document enumerates every MCP tool the incident-triage Skill uses, with usage examples. Verified against the official DataHub MCP Server docs (https://docs.datahub.com/docs/features/feature-guides/mcp/) and the Agent Context Kit docs (https://docs.datahub.com/docs/dev-guides/agent-context/agent-context/).

There are **20 tools** in two groups: 12 read (MCP Server) and 8 write (Agent Context Kit, `include_mutations=True`).

---

## Read tools — DataHub MCP Server (12 tools)

### 1. `search`

Search across all DataHub entities by keyword.

```python
result = mcp.search("nyc taxi", {"count": 10, "filters": {"entityType": "dataset"}})
# → [{"urn": "urn:li:dataset:(urn:li:dataPlatform:dbt,nyc_yellow_taxi_trips,PROD)",
#     "name": "nyc_yellow_taxi_trips", "platform": "dbt", "type": "dataset", ...}]
```

### 2. `get_entities`

Resolve metadata for one or more URNs.

```python
result = mcp.get_entities(["urn:li:dataset:(urn:li:dataPlatform:dbt,nyc_yellow_taxi_trips,PROD)"])
# → [{name, platform, owners, glossaryTerms, governanceTags, schema, ...}]
```

### 3. `list_schema_fields`

List the schema fields of a dataset, optionally filtered by keyword.

```python
result = mcp.list_schema_fields(
    "urn:li:dataset:(urn:li:dataPlatform:dbt,nyc_yellow_taxi_trips,PROD)",
    {"keywords": "timestamp"},
)
```

### 4. `get_me`

Return the currently authenticated DataHub user (for the audit log).

```python
me = mcp.get_me()  # → {urn: "urn:li:corpuser:sentinel", name: "Sentinel"}
```

### 5. `get_lineage`

Get the upstream or downstream lineage graph for an asset.

```python
upstream = mcp.get_lineage(
    "urn:li:dataset:(urn:li:dataPlatform:dbt,nyc_yellow_taxi_trips,PROD)",
    direction="upstream",
    {"depth": 3, "query": "*"},
)
# → {nodes: [...], edges: [{fromUrn, toUrn, via: "spark_nyc_taxi_clean"}, ...]}

downstream = mcp.get_lineage(urn, direction="downstream", {"depth": 2})
```

### 6. `get_lineage_paths_between`

Find all lineage paths between two assets (for the schema-breakage cross-platform scenario).

```python
paths = mcp.get_lineage_paths_between(
    "urn:li:dataset:(urn:li:dataPlatform:snowflake,raw_orders,PROD)",
    "urn:li:dataset:(urn:li:dataPlatform:looker,revenue_dashboard,PROD)",
)
```

### 7. `search_documents`

Full-text search over DataHub context documents — the **compounding beat** (find prior post-mortems).

```python
docs = mcp.search_documents("post-mortem nyc taxi freshness", {"count": 5})
# → [{urn, assetUrn, title, content, createdAt, sentinelPostMortem: true}, ...]
```

### 8. `grep_documents`

Regex search over DataHub context documents (broader than `search_documents`).

```python
hits = mcp.grep_documents("spark.*ingestion", {"filters": {"author": "sentinel"}})
```

### 9. `get_dataset_queries`

Get the SQL / dbt code that produces a dataset (for the remediation PR).

```python
queries = mcp.get_dataset_queries(
    "urn:li:dataset:(urn:li:dataPlatform:dbt,nyc_yellow_taxi_trips,PROD)",
)
# → [{sql: "SELECT ... FROM raw_nyc_taxi WHERE ...", platform: "dbt", ...}]
```

### 10. `list_lifecycle_stages`

List the lifecycle stages of an asset (e.g. `Production`, `Deprecated`). Useful for the schema-breakage scenario.

```python
stages = mcp.list_lifecycle_stages()
```

### 11. `get_glossary_term_versions`

Get the version history of a glossary term (for the propose-don't-patch policy).

```python
versions = mcp.get_glossary_term_versions("urn:li:glossaryTerm:business-critical")
```

### 12. `compare_glossary_term_versions`

Diff two versions of a glossary term (for proposing updates).

```python
diff = mcp.compare_glossary_term_versions(urn, "v1", "v2")
```

---

## Write tools — DataHub Agent Context Kit (8 tools, `include_mutations=True`)

These tools come from the Agent Context Kit's LangChain integration (https://docs.datahub.com/docs/dev-guides/agent-context/langchain/). They are mutations — they change the context graph.

Threat model:
- Ownership/glossary are PROPOSED via `add_glossary_terms` / `add_owners` — humans approve. Sentinel does NOT directly patch.
- Assertions are the only DIRECT write — and they are reversible.
- All writes are mirrored in the AuditLog (SQLite + DataHub Assertion/Event).

### 13. `save_document`

Save a context document — the post-mortem write-back.

```python
result = context_kit.save_document({
    "assetUrn": "urn:li:dataset:(urn:li:dataPlatform:dbt,nyc_yellow_taxi_trips,PROD)",
    "title": "Post-mortem — nyc_yellow_taxi_trips freshness breach 2026-08-01",
    "content": "<markdown post-mortem body>",
    "format": "markdown",
})
# → {urn: "urn:li:document:postmortem-2026-08-01-nyc-taxi"}
```

### 14. `add_tags`

Add governance tags to an asset.

```python
context_kit.add_tags(assetUrn, ["sentinel-reviewed", "incident-2026-08-01"])
```

### 15. `remove_tags`

Remove governance tags (reversible — used in cleanup).

```python
context_kit.remove_tags(assetUrn, ["stale-tag"])
```

### 16. `update_description`

Update the human-readable description of an asset.

```python
context_kit.update_description(assetUrn, "Sentinel-discovered: dbt model for NYC Yellow Taxi revenue. See post-mortem 2026-08-01.")
```

### 17. `add_glossary_terms` (PROPOSAL)

Attach glossary terms to an asset. Proposal, not direct patch.

```python
context_kit.add_glossary_terms(assetUrn, [
    "urn:li:glossaryTerm:business-critical",
    "urn:li:glossaryTerm:revenue-impacting",
])
```

### 18. `remove_glossary_terms`

Remove glossary terms from an asset (reversible).

```python
context_kit.remove_glossary_terms(assetUrn, ["urn:li:glossaryTerm:deprecated"])
```

### 19. `set_domains`

Set the domains an asset belongs to.

```python
context_kit.set_domains(assetUrn, ["urn:li:domain:data-platform"])
```

### 20. `add_owners` (PROPOSAL)

Propose new owners for an asset. Proposal, not direct patch.

```python
context_kit.add_owners(assetUrn, [
    {"urn": "urn:li:corpuser:priya.patel", "type": "user"},
    {"urn": "urn:li:corpGroup:data-platform", "type": "team"},
])
```

---

## Action connectors (external — not MCP)

These are NOT DataHub MCP tools — they are external action connectors Sentinel composes alongside the MCP tools.

### `github.openIssue`

Open a GitHub issue on the failing-asset's pipeline repo.

### `github.openPR`

Open a draft remediation PR. **Sentinel NEVER merges** (no-merge policy). There is no `github.mergePR` tool — by design.

### `slack.postMessage`

Post a triage summary to the on-call channel.

---

## Fallback: REST ingestion (dual write-back path)

If the Agent Context Kit is unavailable (e.g. DataHub version drift), Sentinel falls back to direct REST ingestion:

- `ingestProposal(proposal)` — submit a GraphQL proposal (for glossary/ownership proposals)
- `patchEntity(urn, patch)` — patch an entity directly (only for description updates)
- `createAssertion(input)` — create an assertion directly (the only direct write — reversible)

Pinned DataHub version: see `prisma/schema.prisma` and `package.json`. Sentinel tries the Agent Context Kit first, then REST ingestion, and logs the path taken to the AuditLog.

---

## See also

- DataHub MCP Server repo: https://github.com/acryldata/mcp-server-datahub
- DataHub Agent Context Kit docs: https://docs.datahub.com/docs/dev-guides/agent-context/agent-context/
- DataHub Agent Context Kit — LangChain: https://docs.datahub.com/docs/dev-guides/agent-context/langchain/
- DataHub Skills repo: https://github.com/datahub-project/datahub-skills
- Block + Goose use case (acknowledged prior art): https://datahub.com/blog/datahub-mcp-server-block-ai-agents-use-case/
