# Sentinel — incident triage report

> This is a pre-generated sample of the GitHub issue Sentinel opens autonomously when the nyc-taxi freshness assertion fires. Judges who do not run the project should still see the output quality.

**Repo**: `sodiq-code/sentinel-demo-pipeline` (demo)
**Issue #**: 42
**Opened by**: `sentinel-bot` (scoped PAT, `issues:write` only)
**Opened at**: 2026-08-01T03:14:32Z

---

## Sentinel — incident triage

**Failing asset**: `urn:li:dataset:(urn:li:dataPlatform:dbt,nyc_yellow_taxi_trips,PROD)`
**Signal type**: `freshness`
**Assertion**: `urn:li:assertion:nyc-taxi-freshness-15m`
**Last success**: 2026-08-01T02:00:11Z (6h 14m ago)
**SLA**: 900s (15m)

### Root cause (Sentinel diagnosis)

The upstream Spark job `spark_nyc_taxi_ingestion` has not produced a new output in 6h 14m. The job is scheduled to run every 15m via Airflow DAG `nyc_taxi_ingestion_dag`. Diagnosis:

- The job's Airflow task `nyc_taxi_ingestion_dag.spark_nyc_taxi_clean` has been in `queued` state for 5h 50m — worker pool saturation suspected.
- The raw S3 source `s3://nyc-taxi/yellow_tripdata/2026/08/01/` was last written at 01:55Z, 19 minutes before the job's last successful run.
- The dbt model `nyc_yellow_taxi_trips` depends on `spark_nyc_taxi_clean` — the lineage edge is `spark_nyc_taxi_clean → dbt_nyc_yellow_taxi_trips`.

### Lineage (upstream)

| Asset | Platform | Owner | Last run |
|---|---|---|---|
| `s3://nyc-taxi/yellow_tripdata` | s3 | data-platform team | 2026-08-01T01:55Z |
| `urn:li:dataJob:(urn:li:dataPlatform:airflow,spark_nyc_taxi_ingestion,PROD)` | airflow | Priya Patel | queued 5h 50m |
| `urn:li:dataset:(urn:li:dataPlatform:spark,spark_nyc_taxi_clean,PROD)` | spark | Priya Patel | 2026-08-01T02:00:11Z |

### Blast radius (downstream)

| Asset | Type | Owner |
|---|---|---|
| `urn:li:dashboard:(urn:li:dataPlatform:looker,nyc_taxi_revenue_dashboard,PROD)` | dashboard | Marcus Chen |
| `urn:li:chart:(urn:li:dataPlatform:looker,daily_revenue_trend,PROD)` | chart | Marcus Chen |

### Prior post-mortems

- None found for this asset (this is the first incident Sentinel has triaged on `nyc_yellow_taxi_trips`).
- Sentinel searched DataHub context docs for `"post-mortem nyc taxi freshness"` — no results. The next incident will find the post-mortem this one writes.

### Proposed remediation

```diff
# airflow/dags/nyc_taxi_ingestion_dag.py
-    pool='default_pool',
-    queue='default',
+    pool='nyc_taxi_dedicated_pool',
+    queue='high_memory',
+    sla=datetime.timedelta(minutes=15),
+    on_failure_callback=notify_oncall,
```

Sentinel recommends:
1. Move the `spark_nyc_taxi_clean` task to a dedicated Airflow pool (`nyc_taxi_dedicated_pool`) to avoid worker-pool saturation.
2. Add an explicit SLA of 15 minutes (matching the DataHub freshness assertion).
3. Wire the `on_failure_callback` to page the on-call rotation (currently Priya Patel).

### Sentinel audit

- Tool calls: 7 (search, get_entities, get_lineage x2, search_documents, get_dataset_queries, get_ownership)
- Reasoning trace: 5 ReAct steps (plan → tool_call → tool_result → observe → reflect → act)
- Guardrail checks: 1 — PII refusal check on `nyc_yellow_taxi_trips` PASSED (no PII tags)
- Pending approvals: 0
- Write-backs proposed: 4 (post-mortem doc, glossary proposal `business-critical`, ownership proposal `urn:li:corpuser:priya.patel` for the Spark job, new SLA assertion tightened to 15m)
- LLM tokens: 4,213 (prompt) + 1,489 (completion) — estimated cost $0.01

---

_Sentinel opened this issue autonomously. A PR with the proposed remediation is attached (#43). Sentinel NEVER merges — a human must review and merge._

_Audit trail: `urn:li:assertion:sentinel-audit-2026-08-01-0314` in DataHub._
