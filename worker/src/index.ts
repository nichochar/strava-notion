import { RateLimitError, Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

const worker = new Worker()
export default worker

function requireEnv(name: string): string {
	const value = process.env[name]
	if (!value) {
		throw new Error(
			`${name} is not set. Add it to worker/.env and run \`ntn workers env push\`.`,
		)
	}
	return value
}

// -- Strava OAuth ------------------------------------------------------------
// The Workers runtime owns the token lifecycle: it runs the authorize
// redirect, exchanges the code, stores the refresh token, and rotates it.
// Handlers just call `stravaAuth.accessToken()` for a fresh token.
const stravaAuth = worker.oauth("strava", {
	name: "strava",
	authorizationEndpoint: "https://www.strava.com/oauth/authorize",
	tokenEndpoint: "https://www.strava.com/oauth/token",
	scope: "activity:read_all",
	clientId: requireEnv("STRAVA_CLIENT_ID"),
	clientSecret: requireEnv("STRAVA_CLIENT_SECRET"),
	authorizationParams: { approval_prompt: "auto" },
})

// -- Pacer -------------------------------------------------------------------
// Strava's read limit is 100 requests / 15 min and 1,000 / day per app; this
// uses the full 15-min read budget. The two syncs below share it evenly.
// Daily usage is small: the delta makes ~4 requests/day, and a full backfill
// needs one request per 100 activities.
const stravaApi = worker.pacer("stravaApi", {
	allowedRequests: 100,
	intervalMs: 15 * 60 * 1000,
})

// -- Sports ------------------------------------------------------------------
// Strava `sport_type` values we keep as their own select option. Anything
// else is stored as "Other" so an unexpected type can never fail a write.
const SPORTS = [
	{ name: "Ride", color: "orange", emoji: "🚴" },
	{ name: "GravelRide", color: "brown", emoji: "🚵" },
	{ name: "MountainBikeRide", color: "green", emoji: "🚵" },
	{ name: "EMountainBikeRide", color: "green", emoji: "⚡" },
	{ name: "VirtualRide", color: "purple", emoji: "🖥️" },
	{ name: "EBikeRide", color: "yellow", emoji: "⚡" },
	{ name: "Run", color: "blue", emoji: "🏃" },
	{ name: "TrailRun", color: "blue", emoji: "🏃" },
	{ name: "VirtualRun", color: "purple", emoji: "🏃" },
	{ name: "Hike", color: "default", emoji: "🥾" },
	{ name: "Walk", color: "gray", emoji: "🚶" },
	{ name: "Swim", color: "blue", emoji: "🏊" },
	{ name: "Rowing", color: "blue", emoji: "🚣" },
	{ name: "WeightTraining", color: "red", emoji: "🏋️" },
	{ name: "Workout", color: "red", emoji: "💪" },
	{ name: "HighIntensityIntervalTraining", color: "red", emoji: "💪" },
	{ name: "Yoga", color: "pink", emoji: "🧘" },
	{ name: "AlpineSki", color: "gray", emoji: "⛷️" },
	{ name: "BackcountrySki", color: "gray", emoji: "⛷️" },
	{ name: "NordicSki", color: "gray", emoji: "⛷️" },
	{ name: "Snowboard", color: "gray", emoji: "🏂" },
	{ name: "RockClimbing", color: "brown", emoji: "🧗" },
	{ name: "Other", color: "default", emoji: "🏅" },
] as const

const SPORT_BY_NAME = new Map<string, (typeof SPORTS)[number]>(
	SPORTS.map((s) => [s.name, s]),
)
const OTHER_SPORT = SPORT_BY_NAME.get("Other")!

// -- Database ----------------------------------------------------------------
const activities = worker.database("activities", {
	type: "managed",
	initialTitle: "Strava Activities",
	primaryKeyProperty: "Strava ID",
	schema: {
		properties: {
			Name: Schema.title(),
			"Strava ID": Schema.richText(),
			Date: Schema.date(),
			Sport: Schema.select(
				SPORTS.map(({ name, color }) => ({ name, color })),
			),
			"Distance (mi)": Schema.number(),
			"Moving Time (min)": Schema.number(),
			"Elevation (ft)": Schema.number(),
			"Avg Speed (mph)": Schema.number(),
			"Avg Power (W)": Schema.number(),
			"Avg HR": Schema.number(),
			"Suffer Score": Schema.number(),
			Kudos: Schema.number(),
			PRs: Schema.number(),
			Trainer: Schema.checkbox(),
			Commute: Schema.checkbox(),
			Link: Schema.url(),
		},
	},
})

// -- Strava API --------------------------------------------------------------

interface StravaActivity {
	id: number
	name: string
	sport_type: string
	start_date: string // UTC ISO timestamp
	start_date_local: string // local wall-clock time, misleadingly suffixed "Z"
	timezone: string // e.g. "(GMT-08:00) America/Los_Angeles"
	distance: number // meters
	moving_time: number // seconds
	total_elevation_gain: number // meters
	average_speed: number // m/s
	average_watts?: number
	average_heartrate?: number
	suffer_score?: number
	kudos_count: number
	pr_count: number
	trainer: boolean
	commute: boolean
}

const PAGE_SIZE = 100

async function fetchActivities(params: {
	page?: number
	after?: number // epoch seconds; results come back oldest-first
	before?: number // epoch seconds; results come back newest-first
}): Promise<StravaActivity[]> {
	await stravaApi.wait()
	const token = await stravaAuth.accessToken()
	const qs = new URLSearchParams({ per_page: String(PAGE_SIZE) })
	if (params.page !== undefined) qs.set("page", String(params.page))
	if (params.after !== undefined) qs.set("after", String(params.after))
	if (params.before !== undefined) qs.set("before", String(params.before))

	const res = await fetch(`https://www.strava.com/api/v3/athlete/activities?${qs}`, {
		headers: { Authorization: `Bearer ${token}` },
	})
	if (res.status === 429) {
		// Strava's windows reset on the quarter hour and it rarely sends
		// Retry-After, so fall back to waiting for the next boundary.
		const header = Number(res.headers.get("Retry-After"))
		const quarterHour = 15 * 60
		const untilBoundary = quarterHour - (Math.floor(Date.now() / 1000) % quarterHour)
		throw new RateLimitError({
			retryAfter: Number.isFinite(header) && header > 0 ? header : untilBoundary,
		})
	}
	if (!res.ok) {
		throw new Error(`Strava API ${res.status}: ${await res.text()}`)
	}
	return (await res.json()) as StravaActivity[]
}

const toEpochSeconds = (iso: string) => Math.floor(Date.parse(iso) / 1000)

// "(GMT-08:00) America/Los_Angeles" -> "America/Los_Angeles", if valid.
function ianaTimeZone(stravaTz: string): string | undefined {
	const name = stravaTz.split(" ").pop()
	if (!name) return undefined
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: name })
		return name
	} catch {
		return undefined
	}
}

const round1 = (n: number) => Math.round(n * 10) / 10

function toUpsert(a: StravaActivity) {
	const sport = SPORT_BY_NAME.get(a.sport_type) ?? OTHER_SPORT
	return {
		type: "upsert" as const,
		key: String(a.id),
		icon: Builder.emojiIcon(sport.emoji),
		properties: {
			Name: Builder.title(a.name),
			"Strava ID": Builder.richText(String(a.id)),
			// Builder.dateTime keeps only the wall-clock part of the string, so
			// pass Strava's local time plus the zone it belongs to.
			Date: Builder.dateTime(a.start_date_local, ianaTimeZone(a.timezone)),
			Sport: Builder.select(sport.name),
			"Distance (mi)": Builder.number(round1(a.distance / 1609.344)),
			"Moving Time (min)": Builder.number(Math.round(a.moving_time / 60)),
			"Elevation (ft)": Builder.number(Math.round(a.total_elevation_gain * 3.28084)),
			"Avg Speed (mph)": Builder.number(round1(a.average_speed * 2.23694)),
			...(a.average_watts != null && {
				"Avg Power (W)": Builder.number(Math.round(a.average_watts)),
			}),
			...(a.average_heartrate != null && {
				"Avg HR": Builder.number(Math.round(a.average_heartrate)),
			}),
			...(a.suffer_score != null && {
				"Suffer Score": Builder.number(a.suffer_score),
			}),
			Kudos: Builder.number(a.kudos_count),
			PRs: Builder.number(a.pr_count),
			Trainer: Builder.checkbox(a.trainer),
			Commute: Builder.checkbox(a.commute),
			Link: Builder.url(`https://www.strava.com/activities/${a.id}`),
		},
	}
}

// -- Backfill sync: full history, replace mode, triggered manually -----------
// Doubles as the "one-time import" and as periodic drift cleanup: replace
// mode mark-and-sweeps rows whose activities were deleted on Strava.
//   ntn workers sync state reset activitiesBackfill
//   ntn workers sync trigger activitiesBackfill
//
// Pages newest-first with a `before` time cursor rather than page numbers:
// with offsets, an activity deleted mid-run shifts every later page up by
// one, the backfill never sees one activity, and the sweep deletes its row
// (and any notes added to it in Notion). The cursor is the oldest start time
// seen plus one second, so activities sharing that second are re-fetched
// rather than skipped; re-upserting them is harmless.
worker.sync("activitiesBackfill", {
	database: activities,
	mode: "replace",
	schedule: "manual",
	execute: async (state: { before: number } | undefined) => {
		const batch = await fetchActivities({ before: state?.before })
		const hasMore = batch.length === PAGE_SIZE
		const oldest = batch.at(-1)
		return {
			changes: batch.map(toUpsert),
			hasMore,
			nextState:
				hasMore && oldest
					? { before: toEpochSeconds(oldest.start_date) + 1 }
					: undefined,
		}
	},
})

// -- Delta sync: recent activities, every 6 hours ----------------------------
// Sliding window: each cycle re-fetches the last 30 days (usually 1
// request). Upserts are idempotent, so overlap is free, and the window
// catches late uploads (a ride synced from a head unit days after the fact)
// and edits (renames). Older changes/deletes are the backfill's job.
//
// The window must restart from "now" every cycle. Whether the runtime hands
// the next cycle `undefined` or the last mid-cycle state isn't documented
// clearly, so the state carries the cycle's start time and anything older
// than one cycle's worth of paging is treated as finished.
const LOOKBACK_SECONDS = 30 * 24 * 3600
const STALE_STATE_MS = 60 * 60 * 1000

type DeltaState = { after: number; page: number; cycleStartedAt: number }

worker.sync("activitiesDelta", {
	database: activities,
	mode: "incremental",
	schedule: "6h",
	execute: async (state: DeltaState | undefined) => {
		const now = Date.now()
		const current: DeltaState =
			state && now - state.cycleStartedAt < STALE_STATE_MS
				? state
				: {
						after: Math.floor(now / 1000) - LOOKBACK_SECONDS,
						page: 1,
						cycleStartedAt: now,
					}
		const batch = await fetchActivities({
			page: current.page,
			after: current.after,
		})
		const hasMore = batch.length === PAGE_SIZE
		return {
			changes: batch.map(toUpsert),
			hasMore,
			nextState: hasMore ? { ...current, page: current.page + 1 } : undefined,
		}
	},
})
