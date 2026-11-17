# Freebie Radar on Railway

[Freebie Radar](https://github.com/ZiChuanLan/freebie-radar) (MIT) — a self-hosted freebie and deal radar: it collects 100+ (mostly Chinese-language) sources such as free games, software giveaways, coupons and AI-tool trials, de-duplicates and scores them, optionally runs an AI second-pass review with any OpenAI-compatible model, and serves a web feed, RSS, a daily digest and optional Telegram push. Deploy it on Railway with one click.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/3dCfI5)

## What this template runs

- **freebie-radar**: `ghcr.io/onepush-dev/freebie-radar:9de586d`, built from upstream commit `9de586d` (source in this repo, unmodified apart from the Dockerfile defaults below). Public HTTPS domain on port 8080, healthcheck `/health`, volume at `/data` (SQLite database `radar.db`).

## Variables

| Variable | Value | Notes |
|---|---|---|
| `ADMIN_TOKEN` | generated secret | Password for the admin area (sources, AI engine, push, blocklists). Without it the admin area would be open. |
| `PUBLIC_BASE_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | Public URL used in RSS, digests and push links. |

Baked into the image: `HOST=0.0.0.0`, `PORT=8080`, `DATABASE_PATH=/data/radar.db`, `TZ=Asia/Shanghai`, `TRUST_PROXY=true`, `NODE_ENV=production`.

Optional (add in Variables): `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` (the AI engine can also be set in the web UI), `PUSH_CHANNEL=telegram` with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, `GITHUB_TOKEN` (raises the GitHub API limit), `COLLECT_CRON` (default every 2 hours), `DAILY_CRON`.

## How to use

1. Deploy and open the public domain. The first collection runs on the schedule (every 2 hours); trigger one from the admin area to fill the feed right away.
2. Open the admin area and sign in with `ADMIN_TOKEN` (service → Variables).
3. Optionally add an OpenAI-compatible key in the AI engine page for the second-pass review, and Telegram for push.

## Notes

- Zhihu, Xiaohongshu and Xiaoheihe sources need a logged-in browser helper (`scripts/pw-collect.mjs`) and do not run on Railway by themselves; the other sources work without logins.
- Some Cloudflare-protected sources work better with FlareSolverr (`FLARESOLVERR_URL`).
- Upstream docs (Chinese/English): `README.upstream.md`, `README.upstream.en.md`.
- Not affiliated with the Freebie Radar author.
