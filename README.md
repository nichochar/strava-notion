# strava-notion

Sync Strava rides into a Notion database, two ways:

1. **`import/`** — a one-time backfill script (Node). Pages through the Strava API
   (`GET /athlete/activities`) and creates one row per activity in a Notion database
   via the classic Notion REST API.
2. **`worker/`** — a **Notion Worker** (the new Developer Platform, May 2026):
   a TypeScript *sync* capability that runs on Notion's servers on a schedule,
   pulls recent Strava activities, and upserts them into a managed database with
   locked (read-only) synced properties.

## Architecture

```
                       one-time backfill
  Strava API ──────────────────────────────────▶ Notion REST API
      │                (import/ script)
      │
      │   every 30 min (Notion-hosted cron)
      └────────────────────────────────────────▶ Notion Sync database
                       (worker/ sync)
```

Both writers use the Strava **activity ID** as the stable key so backfill and
continuous sync can coexist without duplicates.

## The moving parts

- **Strava API app** — created at <https://www.strava.com/settings/api>.
  Gives us a client ID/secret; OAuth (`activity:read_all` scope) yields a
  long-lived *refresh token* we exchange for short-lived access tokens.
- **Notion Developer Platform / `ntn` CLI** — `npm install -g ntn`, then
  `ntn login`. The CLI scaffolds (`ntn workers new`), deploys
  (`ntn workers deploy`), stores secrets (`ntn workers env set`), triggers syncs
  (`ntn workers sync trigger`), and tails logs (`ntn workers runs logs`).
- **Worker runtime** — a single TS file exporting a `Worker` instance from
  `@notionhq/workers`; capabilities are registered with `worker.sync()` /
  `worker.tool()` / `worker.webhook()`.

## Docs

- Workers overview: <https://developers.notion.com/workers/get-started/overview>
- Workers help page: <https://www.notion.com/help/run-custom-code-with-workers>
- Notion CLI: <https://www.notion.com/help/use-notion-from-your-terminal-with-notion-cli>
- Strava API getting started: <https://developers.strava.com/docs/getting-started/>
- Strava auth (OAuth + refresh tokens): <https://developers.strava.com/docs/authentication/>

## Secrets

Nothing sensitive is committed. Local scripts read from `.env` (gitignored);
the worker reads secrets set via `ntn workers env set`.
