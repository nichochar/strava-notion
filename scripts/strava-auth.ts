// One-time Strava OAuth (authorization-code flow) to mint a refresh token
// with the activity:read_all scope. The tokens shown on
// https://www.strava.com/settings/api only carry the `read` scope, which
// cannot list activities — hence this dance.
//
// Usage: node scripts/strava-auth.mjs
//   1. Open the printed URL in your browser and click "Authorize".
//   2. Strava redirects to localhost; this server exchanges the code and
//      writes STRAVA_* values to .env (gitignored), then exits.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const PORT = 8723;
const REDIRECT_URI = `http://localhost:${PORT}/exchange_token`;
const ENV_PATH = path.join(import.meta.dirname, "..", ".env");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET must be set");
  process.exit(1);
}

const authorizeUrl =
  "https://www.strava.com/oauth/authorize" +
  `?client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  "&response_type=code" +
  "&approval_prompt=auto" +
  "&scope=activity:read_all";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/exchange_token") {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  const scope = url.searchParams.get("scope") ?? "";
  if (!code) {
    res.writeHead(400).end("Missing ?code — did you deny access?");
    return;
  }
  if (!scope.includes("activity:read_all")) {
    res.writeHead(400).end(
      `Granted scope was "${scope}" — activity:read_all is required. ` +
        "Re-run and leave all checkboxes enabled on the authorize page.",
    );
    return;
  }

  const tokenRes = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    res.writeHead(500).end("Token exchange failed — see terminal.");
    console.error("Token exchange failed:", tokenRes.status, text);
    return;
  }
  const tok = await tokenRes.json();

  const lines = [
    `STRAVA_CLIENT_ID=${CLIENT_ID}`,
    `STRAVA_CLIENT_SECRET=${CLIENT_SECRET}`,
    `STRAVA_ACCESS_TOKEN=${tok.access_token}`,
    `STRAVA_REFRESH_TOKEN=${tok.refresh_token}`,
    `STRAVA_TOKEN_EXPIRES_AT=${tok.expires_at}`,
    "",
  ];
  fs.writeFileSync(ENV_PATH, lines.join("\n"), { mode: 0o600 });

  res.writeHead(200, { "Content-Type": "text/html" }).end(
    "<h2>✅ Strava authorized</h2>You can close this tab and return to Claude.",
  );
  console.log(
    `OK: scope="${scope}" athlete=${tok.athlete?.firstname} ${tok.athlete?.lastname} — tokens written to .env`,
  );
  server.close();
});

server.listen(PORT, () => {
  console.log("Waiting for Strava callback on", REDIRECT_URI);
  console.log("\nOpen this URL and click Authorize:\n\n" + authorizeUrl + "\n");
});
