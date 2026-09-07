import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

const worker = new Worker()
export default worker

// -- Strava OAuth ------------------------------------------------------------
// The Workers runtime owns the token lifecycle: it runs the authorize
// redirect, exchanges the code, stores the refresh token, and rotates it.
// Handlers just call `stravaAuth.accessToken()` for a fresh token.
const stravaAuth = worker.oauth("strava", {
	name: "strava",
	authorizationEndpoint: "https://www.strava.com/oauth/authorize",
	tokenEndpoint: "https://www.strava.com/oauth/token",
	scope: "activity:read_all",
	clientId: process.env.STRAVA_CLIENT_ID ?? "",
	clientSecret: process.env.STRAVA_CLIENT_SECRET ?? "",
	authorizationParams: { approval_prompt: "auto" },
})

// -- Pacer -------------------------------------------------------------------
// Strava allows 200 requests / 15 min (2,000/day) per app. Budget half of it;
// the two syncs below split this evenly.
const stravaApi = worker.pacer("stravaApi", {
	allowedRequests: 100,
	intervalMs: 15 * 60 * 1000,
})

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
			Sport: Schema.select([
				{ name: "Ride", color: "orange" },
				{ name: "GravelRide", color: "brown" },
				{ name: "MountainBikeRide", color: "green" },
				{ name: "VirtualRide", color: "purple" },
				{ name: "EBikeRide", color: "yellow" },
				{ name: "Run", color: "blue" },
				{ name: "Hike", color: "default" },
				{ name: "Walk", color: "gray" },
			]),
			"Distance (km)": Schema.number(),
			"Moving Time (min)": Schema.number(),
			"Elevation (m)": Schema.number(),
			"Avg Speed (km/h)": Schema.number(),
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
	page: number
	after?: number
}): Promise<StravaActivity[]> {
	await stravaApi.wait()
	const token = await stravaAuth.accessToken()
	const qs = new URLSearchParams({
		per_page: String(PAGE_SIZE),
		page: String(params.page),
	})
	if (params.after !== undefined) qs.set("after", String(params.after))

	const res = await fetch(`https://www.strava.com/api/v3/athlete/activities?${qs}`, {
		headers: { Authorization: `Bearer ${token}` },
	})
	if (!res.ok) {
		throw new Error(`Strava API ${res.status}: ${await res.text()}`)
	}
	return (await res.json()) as StravaActivity[]
}

const SPORT_EMOJI: Record<string, string> = {
	Ride: "🚴",
	GravelRide: "🚵",
	MountainBikeRide: "🚵",
	VirtualRide: "🖥️",
	EBikeRide: "⚡",
	Run: "🏃",
	Hike: "🥾",
	Walk: "🚶",
}

const round1 = (n: number) => Math.round(n * 10) / 10

function toUpsert(a: StravaActivity) {
	return {
		type: "upsert" as const,
		key: String(a.id),
		icon: Builder.emojiIcon(SPORT_EMOJI[a.sport_type] ?? "🏅"),
		properties: {
			Name: Builder.title(a.name),
			"Strava ID": Builder.richText(String(a.id)),
			Date: Builder.dateTime(a.start_date),
			Sport: Builder.select(a.sport_type),
			"Distance (km)": Builder.number(round1(a.distance / 1000)),
			"Moving Time (min)": Builder.number(Math.round(a.moving_time / 60)),
			"Elevation (m)": Builder.number(Math.round(a.total_elevation_gain)),
			"Avg Speed (km/h)": Builder.number(round1(a.average_speed * 3.6)),
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
worker.sync("activitiesBackfill", {
	database: activities,
	mode: "replace",
	schedule: "manual",
	execute: async (state: { page: number } | undefined) => {
		const page = state?.page ?? 1
		const batch = await fetchActivities({ page })
		const hasMore = batch.length === PAGE_SIZE
		return {
			changes: batch.map(toUpsert),
			hasMore,
			nextState: hasMore ? { page: page + 1 } : undefined,
		}
	},
})

// -- Delta sync: recent activities, every 6 hours ----------------------------
// Stateless sliding window: each cycle re-fetches the last 30 days (1-2
// requests). Upserts are idempotent, so overlap is free, and the window
// catches late uploads (a ride synced from a head unit days after the fact)
// and edits (renames). Older changes/deletes are the backfill's job.
const LOOKBACK_SECONDS = 30 * 24 * 3600

worker.sync("activitiesDelta", {
	database: activities,
	mode: "incremental",
	schedule: "6h",
	execute: async (state: { after: number; page: number } | undefined) => {
		const after =
			state?.after ?? Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS
		const page = state?.page ?? 1
		const batch = await fetchActivities({ page, after })
		const hasMore = batch.length === PAGE_SIZE
		return {
			changes: batch.map(toUpsert),
			hasMore,
			// End-of-cycle state is undefined on purpose: the next cycle
			// recomputes the window from "now", so no cursor can go stale.
			nextState: hasMore ? { after, page: page + 1 } : undefined,
		}
	},
})
