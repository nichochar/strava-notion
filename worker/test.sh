#!/usr/bin/env bash
# Pre-deploy check: type-check, then run both syncs LOCALLY in preview mode
# (real Strava data, nothing written to Notion). Run from anywhere:
#   worker/test.sh
#
# Local runs can't use the deployed worker's OAuth token, so this mints one
# from STRAVA_REFRESH_TOKEN in worker/.env.test (gitignored). Kept out of
# worker/.env on purpose: `ntn workers env push` uploads that whole file.
set -euo pipefail
cd "$(dirname "$0")"

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

[[ -f .env ]] || fail "worker/.env missing (needs STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET)"
[[ -f .env.test ]] || fail "worker/.env.test missing (needs STRAVA_REFRESH_TOKEN)"
set -a; source .env; source .env.test; set +a

step "Type-check"
npm run --silent check

step "Mint Strava access token"
token_json=$(curl -sf -X POST https://www.strava.com/oauth/token \
	-d client_id="$STRAVA_CLIENT_ID" \
	-d client_secret="$STRAVA_CLIENT_SECRET" \
	-d grant_type=refresh_token \
	-d refresh_token="$STRAVA_REFRESH_TOKEN") || fail "token refresh failed (refresh token revoked? re-run scripts/strava-auth.ts)"
access=$(node -pe 'JSON.parse(process.argv[1]).access_token' "$token_json")
refresh=$(node -pe 'JSON.parse(process.argv[1]).refresh_token' "$token_json")
# Strava may rotate the refresh token; once the new one is used the old one
# stops working, so persist it.
if [[ "$refresh" != "$STRAVA_REFRESH_TOKEN" ]]; then
	printf 'STRAVA_REFRESH_TOKEN=%s\n' "$refresh" > .env.test
	echo "refresh token rotated; saved to .env.test"
fi
export OAUTH_737472617661_ACCESS_TOKEN="$access" # name derived from oauth name "strava"
echo ok

# preview <sync> [context-json] -> prints the preview JSON, fails on error
preview() {
	local args=(workers sync trigger "$1" --preview --local --json)
	# Local runs read the cursor from {"userContext": ...}; a bare cursor
	# (what remote previews take) is silently ignored and returns page 1.
	[[ -n "${2:-}" ]] && args+=(--context "{\"userContext\":$2}")
	ntn "${args[@]}" 2>/tmp/strava-notion-preview.err \
		|| { cat /tmp/strava-notion-preview.err >&2; fail "$1 preview errored"; }
}

# Local --json output is the raw SDK result: { changes, hasMore,
# nextUserContext }. (Remote previews use { objects, done, nextContext }.)
#
# Assertions on a preview's output. Every row must have a title, a Strava ID
# matching its key, a date with a time zone, and a sport.
check_rows='
const d = JSON.parse(require("fs").readFileSync(0, "utf8"))
const bad = []
for (const o of d.changes) {
	const p = o.properties, date = JSON.stringify(p.Date)
	if (!p.Name?.[0]?.[0]) bad.push(`${o.key}: no name`)
	if (p["Strava ID"]?.[0]?.[0] !== o.key) bad.push(`${o.key}: Strava ID != key`)
	if (!date.includes("time_zone")) bad.push(`${o.key}: date has no time zone`)
	if (!p.Sport?.[0]?.[0]) bad.push(`${o.key}: no sport`)
}
if (bad.length) { console.error(bad.slice(0, 10).join("\n")); process.exit(1) }
console.log(`${d.changes.length} rows ok, hasMore=${d.hasMore}, next=${JSON.stringify(d.nextUserContext ?? null)}`)
'

step "Delta (last 30 days; may legitimately be empty)"
preview activitiesDelta | node -e "$check_rows" || fail "delta rows invalid"

step "Backfill page 1"
page1=$(preview activitiesBackfill)
echo "$page1" | node -e "$check_rows" || fail "backfill page 1 rows invalid"
[[ $(node -pe 'JSON.parse(process.argv[1]).changes.length' "$page1") -gt 0 ]] \
	|| fail "backfill page 1 returned no activities"

next=$(node -pe 'JSON.stringify(JSON.parse(process.argv[1]).nextUserContext ?? null)' "$page1")
if [[ "$next" != "null" ]]; then
	step "Backfill page 2 (cursor $next)"
	page2=$(preview activitiesBackfill "$next")
	echo "$page2" | node -e "$check_rows" || fail "backfill page 2 rows invalid"
	# Pages must move strictly back in time, overlapping by at most the
	# boundary second.
	node -e '
		const [a, b] = process.argv.slice(1).map((s) => JSON.parse(s).changes)
		const keysA = new Set(a.map((o) => o.key))
		const overlap = b.filter((o) => keysA.has(o.key)).length
		if (overlap > 2) { console.error(`pages overlap by ${overlap} rows`); process.exit(1) }
		if (b.length && b.every((o) => keysA.has(o.key))) { console.error("page 2 made no progress"); process.exit(1) }
		console.log(`pagination ok (overlap ${overlap})`)
	' "$page1" "$page2" || fail "backfill pagination broken"
fi

printf '\nAll checks passed. Deploy with: ntn workers deploy --yes\n'
