# strava-notion

Syncs Strava activities into a Notion database using a **Notion Worker**
(Notion Developer Platform, 2026). The worker runs on Notion's servers —
there is no infrastructure here, just TypeScript.

## Architecture

```
                     ┌─ Notion Workers runtime (Notion-hosted) ─┐
  Strava API ◀───────│  oauth "strava"     token refresh/rotate │
      │              │  pacer "stravaApi"  100 req / 15 min     │
      │ activities   │                                          │
      └─────────────▶│  sync "activitiesBackfill" (manual,      │──▶ "Strava Activities"
                     │       replace mode: full history +       │    managed database on
                     │       mark-and-sweep deletes)            │    the 🚴 Cycling page
                     │  sync "activitiesDelta" (every 6h,       │
                     │       incremental: 30-day sliding window)│
                     └──────────────────────────────────────────┘
```

Everything lives in [worker/src/index.ts](worker/src/index.ts):

- **`worker.oauth("strava")`** — the runtime owns the OAuth lifecycle
  (authorize redirect with PKCE, code exchange, refresh-token rotation).
  Handlers call `accessToken()` and always get a fresh token.
- **`worker.database("activities")`** — a managed database keyed on
  `Strava ID`. Synced columns are locked read-only in Notion; user-added
  properties (notes, ratings) layer on top and survive syncs.
- **Backfill sync** (replace mode, `schedule: "manual"`) — paginates the
  full activity history; doubles as the one-time import and, when
  re-triggered, cleans up activities deleted on Strava.
- **Delta sync** (incremental mode, `schedule: "6h"`) — stateless sliding
  window: re-fetches the last 30 days each cycle (1 request, idempotent
  upserts), catching new rides, late uploads, and renames.

## Operating it

All `ntn workers` commands run from `worker/` (that's where `workers.json` lives).

```sh
ntn workers sync status              # health dashboard
ntn workers sync trigger activitiesDelta       # sync now
ntn workers sync state reset activitiesBackfill && \
  ntn workers sync trigger activitiesBackfill  # full re-import + cleanup
ntn workers runs list                # run history
ntn workers deploy --yes             # ship code changes (state survives deploys)
```

Changing the schema? Edit the `Schema` block, deploy, then re-trigger the
backfill so old rows get the new properties.

## Secrets

- `worker/.env` (gitignored) holds `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET`;
  `ntn workers env push --yes` syncs them to the deployed worker.
  Push **before** deploying — OAuth capabilities bind credentials at
  registration time.
- Strava OAuth tokens are stored by the Workers runtime, not in this repo.
- The Strava app's *Authorization Callback Domain* must be `app.notion.com`
  (the redirect URL from `ntn workers oauth show-redirect-url`).

## One-time artifacts

- [scripts/strava-auth.ts](scripts/strava-auth.ts) — localhost OAuth flow that
  mints an `activity:read_all` refresh token into `.env`. Superseded by the
  worker's OAuth capability; kept for local API experiments
  (`node scripts/strava-auth.ts`).

## Docs

- Workers overview: <https://developers.notion.com/workers/get-started/overview>
- Pricing (credits after Oct 15, 2026; ~$0.0023/run): <https://www.notion.com/help/understand-pricing-for-workers>
- Notion CLI: <https://www.notion.com/help/use-notion-from-your-terminal-with-notion-cli>
- Strava API: <https://developers.strava.com/docs/reference/>
