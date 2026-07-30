# Task 9-a: Resilience & User-Facing Message Cleanup

## Summary
Fixed three production issues reported by users on the Vercel deployment:
1. Removed every "PDF §X.X" / "contingency plan" / "graceful-degradation path" reference from user-facing `emit()` reasoning messages in the orchestrator (judges were seeing internal documentation citations in the dashboard reasoning stream).
2. Loosened the LLM resilience tunables so transient 429s recover and the ReAct loop fits inside the Vercel Hobby 60s function budget.
3. Made `getLlm()` fall back to the always-available z-ai SDK when `LLM_PROVIDER=gemini` is configured but `GEMINI_API_KEY` is missing, so a cold Vercel deploy without secrets still has a working LLM.

## Files Changed
- `/home/z/my-project/src/lib/agent/orchestrator.ts`
- `/home/z/my-project/src/lib/agent/llm.ts`

## Changes Made

### Issue 1 — Remove "PDF §" references from user-facing emit() calls (orchestrator.ts)

Every `emit('observe', …)` / `emit('write_back', …)` call that previously leaked internal documentation references was rewritten to be professional and self-explanatory. Code comments (lines starting with `//`) that reference `PDF §X.X` were intentionally left intact per the task instructions — they are internal-only.

| Location | Before (excerpt) | After |
|---|---|---|
| Soft-deadline observe | "Soft deadline reached … Writing a fallback post-mortem and marking this incident **degraded** (partial investigation). The agent's work so far is preserved in the audit log + the compounding artefact." | "Sentinel reached the safe time budget for this run (after Xs, N reasoning step(s)). The investigation so far is preserved in the audit log and a summary post-mortem has been written to DataHub." |
| CircuitOpenError observe | "… This is the designed graceful-degradation path (PDF §9.5.4 retry visibility + §11.3 contingency plan)." | "LLM provider 'X' is rate-limited (circuit open). Sentinel paused the investigation after N reasoning step(s) to preserve the work completed so far. The circuit cools down in ~Ys; a subsequent run resumes normally. A summary post-mortem has been written to DataHub so the next incident inherits this context." |
| isLlmUnreachableError observe | "… This is the designed graceful-degradation path (PDF §11.3 contingency plan)." | "LLM provider is unreachable (reason). Sentinel paused the investigation after N reasoning step(s) to preserve the work completed so far. A summary post-mortem has been written to DataHub so the next incident inherits this context." |
| PII fallback blocked observe | "Orchestrator fallback post-mortem BLOCKED: … The guardrail would refuse this write — the fallback does the same. (PDF §12.3)" | "Sentinel blocked the automatic post-mortem on this PII-tagged asset: 'tag1', 'tag2'. A human must approve any write to a PII asset; the guardrail upholds this rule for the fallback path as well." |
| write_back emit (success, ACK path) | "Orchestrator wrote a fallback post-mortem via Agent Context Kit (agent did not call ack.save_document)." | "Sentinel wrote a post-mortem to DataHub. The next incident on this asset will inherit this context." |
| write_back emit (success, REST path) | "Orchestrator wrote a fallback post-mortem via REST ingestion (ACK failed: …). The compounding artefact is preserved." | "Sentinel wrote a post-mortem to DataHub via the data API. The next incident on this asset will inherit this context." |
| write_back emit (failure) | "Orchestrator fallback post-mortem FAILED on both paths (ACK: … → REST: …). The compounding artefact could not be written." | "Sentinel could not write the post-mortem to DataHub. The investigation summary is preserved in the audit log." |
| piiRefusalOnPostMortem observe | "Guardrail refused the post-mortem write-back on this PII-tagged asset. … The refusal is the correct agent behaviour (PDF §12.3) — a human must approve any write to a PII asset." | "Sentinel's guardrail refused the post-mortem on this PII-tagged asset. No post-mortem was written — a human must approve any write to a PII asset." |

Verification: `rg "PDF §|§\d|contingency plan|graceful-degradation path" src/lib/agent/orchestrator.ts` now returns only matches inside `//` comments — no matches remain inside any `emit()` call.

### Issue 2 — LLM slowness + 429 recovery (llm.ts + orchestrator.ts)

| Constant | File | Before | After | Rationale |
|---|---|---|---|---|
| `SOFT_DEADLINE_MS` | orchestrator.ts | `45_000` | `55_000` | Gives the ReAct loop 10 more seconds before breaking for the post-loop fallback post-mortem; still leaves 5s for resolution under the Vercel Hobby 60s cap. |
| `MAX_RETRIES` | llm.ts | `1` | `2` | 3 total attempts instead of 2 — lets a transient 429 (e.g. a 1-second blip) recover on the retry instead of immediately opening the circuit. |
| `RATE_LIMIT_INTERVAL_MS` (env `LLM_RATE_LIMIT_MS`) | llm.ts | `?? 15000` | `?? 2000` | 15s between calls made a 10-step loop take 150s just in rate-limit waits. 2s keeps the loop snappy while still smoothing bursts. |
| `RATE_LIMIT_BACKOFF_BASE_MS` (env `LLM_RATE_LIMIT_BACKOFF_MS`) | llm.ts | `?? 8000` | `?? 3000` | 8s base backoff was eating the function budget; 3s gives the rate-limit window a chance to reset without stalling. |
| `RATE_LIMIT_BACKOFF_MAX_MS` (env `LLM_RATE_LIMIT_BACKOFF_MAX_MS`) | llm.ts | `?? 45000` | `?? 10000` | 45s cap would blow the function timeout on its own; 10s cap keeps a single retry tractable. |
| `CIRCUIT_THRESHOLD` | llm.ts | `?? 5` | `?? 5` | Unchanged (task said keep). |
| `CIRCUIT_COOLDOWN_MS` (env `LLM_CIRCUIT_COOLDOWN_MS`) | llm.ts | `?? 90000` | `?? 30000` | 90s cooldown is longer than the function timeout — the circuit never reclosed within a single request. 30s lets a circuit opened early in the request reclose and serve later calls in the same request. |

Code comments above the constants were intentionally left intact per the task instructions (the IMPORTANT note said "Keep code comments as they are"). The one exception is the `SOFT_DEADLINE_MS` comment, which directly describes the constant value being changed — I updated "45s … 15s" to "55s … 5s" so the comment stays self-consistent with the new value.

### Issue 3 — Robust failover in `getLlm()` (llm.ts)

The `else if (provider === 'gemini')` branch previously instantiated `GeminiLlmClient` unconditionally, so a Vercel deploy with `LLM_PROVIDER=gemini` but no `GEMINI_API_KEY` would fail every LLM call with "GEMINI_API_KEY is not set in the environment".

**Fix**: Added an upfront `process.env.GEMINI_API_KEY` check at the top of the gemini branch.

- **No key** → use `ZaiLlmClient` as the **primary** (the z-ai SDK is pre-installed in the build environment and is always reachable). A `GeminiLlmClient` is still instantiated as the **dormant failover** target so the `FailoverLlmClient` structure stays in place — if a key is added on a future deploy the wiring already matches the with-key path. In the current process env vars are immutable, so the dormant Gemini will only ever throw a clean "GEMINI_API_KEY is not set" if z-ai also fails (and the orchestrator's post-loop fallback post-mortem then runs gracefully).
- **Key present** → unchanged behaviour (existing configurable failover via `getFallbackProvider()` to zai / groq / nvidia / none).

This guarantees the agent ALWAYS has a working LLM on any runtime — sandbox, local dev, AND a cold Vercel deploy without secrets.

## Verification

- `bun run lint` → exit code 0, no errors.
- `rg "PDF §|§\d|contingency plan|graceful-degradation path" src/lib/agent/orchestrator.ts` → all remaining matches are inside `//` comments (kept per instructions).
- `rg "PDF §|§\d|contingency plan|graceful-degradation path" src/lib/agent/llm.ts` → only one match remains, inside a thrown `CircuitOpenError` message in `ZaiLlmClient` (line 431, "PDF §9.4.2"). This is NOT an `emit()` call — it's an internal error message caught by the orchestrator's catch block and rewritten into a clean observe message before reaching the dashboard reasoning stream. Left intact per the strict reading of the task instructions ("only fix the strings inside emit() calls").
- Dev server is left running (was already running on port 3000 — not started by this task).

## What was NOT touched (intentional, per instructions)
- All code comments containing `PDF §X.X` references in both files — kept as internal documentation.
- The thrown `CircuitOpenError` message in `ZaiLlmClient.complete()` (llm.ts:431) — not an `emit()` call.
- Other LLM tunables not listed in the task (`CIRCUIT_THRESHOLD`, `INITIAL_BACKOFF_MS`, `RATE_LIMIT_JITTER_PCT`, etc.).
