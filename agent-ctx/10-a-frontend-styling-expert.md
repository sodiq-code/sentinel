# Task 10-a — Dashboard UI Fixes

**Agent:** frontend-styling-expert
**Date:** 2026-07-30
**Task ID:** 10-a

## Objective

Fix 5 critical UI issues reported on the Sentinel dashboard's Vercel deployment:

1. White background on the right side of the dashboard (~35-40% of viewport)
2. IncidentStatusBar only showing green checkmarks for SIGNAL + TRIAGE (not ACTIONS / WRITE-BACKS / RESOLVED)
3. ReActLoopViz not displaying the green "Done" checkmark on completion
4. Write-back panels not showing a clear "SUCCEEDED" badge + DataHub URN
5. Header text "SENTINEL" being clipped to "NTINEL" on some screen sizes

## Files Modified

- `/home/z/my-project/src/app/globals.css`
- `/home/z/my-project/src/app/page.tsx`

## Detailed Changes

### 1. White background fix (`globals.css` + `page.tsx`)

**Root cause:** `:root` defines `--background: oklch(1 0 0)` (white) and the `.dark` selector is never applied. The `<body>` in `layout.tsx` uses `bg-background`, so any horizontal overflow exposed a white body background.

**Fix:**
- Added unlayered CSS in `globals.css`:
  ```css
  html { background-color: rgb(2 6 23); }
  body {
    background-color: rgb(2 6 23);
    color: rgb(241 245 249);
    overflow-x: hidden;
    min-height: 100vh;
  }
  ```
- Hardened `.sentinel-bg` with `width: 100%`, `min-height: 100vh`, explicit `background-color: rgb(2 6 23)`.
- Added `w-full` to root div, header, `<main>`, footer, `SummaryStatBanner`, `DemoControlBar`.
- Added `min-w-0` to the grid + both columns.

### 2. IncidentStatusBar (`page.tsx` lines ~3899-3917)

**Root cause:** Only `"resolved"` was treated as terminal; `"degraded"` (deterministic fallback resolution) never reached RESOLVED. `hasActions`/`hasWritebacks` only checked `viewedIncident`, missing the live `result.steps`.

**Fix:**
- `isResolved` now accepts `"resolved"` OR `"degraded"`.
- `hasActions` now also checks `result?.steps` for `tool_call` with `toolName` starting `action.` / `action_`.
- `hasWritebacks` now also checks `result?.steps` for `kind === "write_back"` or `toolName === "ack.save_document"`.
- `stageTimes` RESOLVED branch fires for `"degraded"` too.
- Added an amber "degraded (auto-resolved)" badge between the green "resolved" and rose "failed" badges.

### 3. ReActLoopViz (`page.tsx` lines ~6743-6910)

**Root cause:** `isComplete = !running && steps.length > 0 && revealed >= steps.length`. After `onSuccess` resets `revealedCount` to 0, the progressive-reveal useEffect takes ~6.5s for a 25-step trace to catch up, during which the green "Done" checkmark was missing. Also the current phase never got its checkmark.

**Fix:**
- Added `hasResult` and `incidentStatus` props.
- New `isComplete` check: `!running && steps.length > 0 && (revealed >= steps.length || isTerminal || hasResult)`.
- `isTerminal` covers `resolved` / `degraded` / `failed`.
- When `isComplete`, ALL phases (Observe, Think, Act) get marked as completed.
- Each completed phase pill now has an inline `<CheckCircle2>` icon (in addition to the CSS `::after` checkmark).
- The "Complete" header badge was enlarged (h-3.5 w-3.5 icon, `font-semibold`, `text-[11px]`, `shadow-sm`).
- The "Done" pill got a new `sentinel-react-step-done` CSS class — 1.5px emerald border + layered box-shadow glow.
- Added `.sentinel-react-step-done` rule in `globals.css`.

### 4. Write-back visibility (`page.tsx` lines ~2259-2465 and ~3670-3947)

**Fix (applied to BOTH write-back panels — `WriteBackPanel`/`WriteBackCard` in the ReasoningStream AND `WritebacksPanel`/`WritebackDetailCard` in the right column):**
- Status badge enlarged to `text-[10px] font-semibold`, with explicit `border border-emerald-500/50` + `shadow-sm shadow-emerald-900/30`, and the label uppercased to "SUCCEEDED".
- Added a per-card "Written to DataHub · verified" confirmation banner (emerald border + bg, `ShieldCheck` icon) when status is succeeded.
- Added a per-panel summary banner: "{N} post-mortem(s) written to DataHub · verified" when all write-backs succeeded.
- Card border turns emerald (`border-emerald-500/40 bg-emerald-500/5`) when succeeded.
- The DataHub URN display now has an explicit "URN:" label prefix + "copied!" inline toast.
- `WritebacksPanel` section border turns emerald when all write-backs succeeded.
- Added a `pluralS(n)` helper.
- `CopyableUrn` upgraded: hover color `text-emerald-300`, copy icon `opacity-60`, `w-full min-w-0` for proper truncation.

### 5. Header text clipping (`page.tsx` lines ~1116-1137)

**Fix:**
- Added `shrink-0 min-w-0` to the logo container.
- Added `shrink-0` to the logo icon div.
- Added `min-w-0 flex-shrink-0` to the SENTINEL text wrapper.
- Added `whitespace-nowrap` to both the "SENTINEL" text and the subtitle.
- Subtitle gets `hidden sm:block` so it hides on very small screens instead of forcing wraps.
- Chips div gets `flex-wrap justify-end max-w-full` so its children wrap to a new line on smaller screens.
- Header inner container gets `w-full`.

## Verification

- `bun run lint` → exit 0, no errors/warnings.
- `bunx tsc --noEmit` → only pre-existing errors (verified via `git stash` — same errors before my changes; zero new errors introduced).
- Dev server (port 3000): HTTP 200, responsive.
- Computed style check (via `agent-browser eval`): `bodyBg` = `rgb(2, 6, 23)` (was `lab(100 0 0)` = white), `bodyOverflowX` = `hidden` (was `visible`).
- VLM (glm-5v-turbo) on resolved historical incident:
  - Incident Progress: all 5 stages green ✓
  - ReAct Loop: green Complete badge + checkmarks on each phase + Done ✓
  - Write-backs: green "1 SUCCEEDED" badge + "1 post-mortem written to DataHub · verified" banner ✓
- VLM on fresh live run (Inject & run Sentinel → NYC Taxi freshness, resolved in 32.7s):
  - Incident Progress: all 5 stages green ✓
  - ReAct Loop: green Complete badge + checkmarks on each phase + Done ✓
  - Write-backs: "2 SUCCEEDED" badges + "Written to DataHub · verified" confirmation ✓
  - Header: "SENTINEL" displayed fully — no clipping ✓
  - Background: entire interface dark — no white anywhere ✓

## Constraints Honored

- Did NOT change the overall design or color scheme.
- Did NOT remove any existing functionality.
- Used the existing shadcn/ui components and Tailwind classes (only added one new CSS class `.sentinel-react-step-done` and `pluralS()` helper).
- Dashboard remains responsive (mobile-first) — added `flex-wrap`, `shrink-0`, `min-w-0` where needed.
- Footer remains sticky at the bottom (unchanged — `mt-auto` already in place).
- `bun run lint` clean.

## Next Actions

- (Optional) Consider applying the `dark` class to `<html>` in `layout.tsx` as a more idiomatic shadcn approach — but the current explicit `background-color` rule is more robust (works even if the shadcn theme variables change).
- (Optional) Run a Vercel preview deployment to confirm the white-background fix persists in production.
