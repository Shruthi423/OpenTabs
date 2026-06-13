# 🎨 UX/Design Job Alert Bot

Scrapes UX/product design job postings from LinkedIn, Indeed, Glassdoor,
ZipRecruiter, and several design RSS boards, then pushes near-real-time
alerts to a Telegram channel. Built for an early-career designer job hunt.

## Setup

1. **Install dependencies**
   ```bash
   pip3 install -r requirements.txt
   ```

2. **Add your secrets**
   ```bash
   cp .env.example .env
   ```
   Then open `.env` and paste in your real `TELEGRAM_BOT_TOKEN` (from
   [@BotFather](https://t.me/BotFather)) and `TELEGRAM_CHAT_ID`.

3. **Run it**
   ```bash
   python3 job_bot.py
   ```
   It runs continuously: a job check every 2 minutes, an hourly heartbeat,
   and a daily digest at 9 AM Pacific. Press `Ctrl+C` to stop.

## Web dashboard (GitHub Pages)

The bot also publishes a one-page dashboard with three sections — **New**
(found in the last 24h), **Yet to Apply**, and **Applied**. You move jobs
between sections by tapping **✅ Applied** / **🗑 Dismiss** on the Telegram
alerts; the board updates itself.

**One-time setup:**
1. In `job_bot.py` `CONFIG`, set `GITHUB_USER` to your GitHub username
   (and `GITHUB_REPO` if you renamed the repo).
2. Push this repo to GitHub (make sure `git push` works without a prompt —
   use a saved HTTPS token or SSH key).
3. On GitHub: **Settings → Pages → Source: `main` branch, `/docs` folder.**
4. Your dashboard goes live at
   `https://<GITHUB_USER>.github.io/<GITHUB_REPO>/`.

The bot regenerates `docs/jobs.json` and commits/pushes it each cycle, so the
page stays current. Set `PUBLISH_TO_GIT` to `False` to disable auto-publish.

> Note: a free GitHub Pages site is **public** — anyone with the link can see
> the listings (no personal data, just public job posts).

## Running in the background (macOS)

The bot runs as a `launchd` service so it survives closing Terminal and
restarts on reboot. The service file is
`~/Library/LaunchAgents/com.opentabs.jobbot.plist`.

```bash
# status (shows PID if running)
launchctl list | grep opentabs

# stop / unload
launchctl bootout gui/$(id -u)/com.opentabs.jobbot

# start / load
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.opentabs.jobbot.plist

# restart now
launchctl kickstart -k gui/$(id -u)/com.opentabs.jobbot

# watch the log
tail -f ~/Desktop/job_bot/job_bot.log
```

The **first run is a silent backfill** (seeds the board, no Telegram alerts);
delete `backfill_done.flag` if you ever want to re-run that.

## Notes

- `.env` holds your secrets and is git-ignored — never commit it.
- `seen_jobs.json`, `pending_jobs.json`, `jobs_store.json`, `tg_offset.json`
  are local state (git-ignored). The `docs/` folder **is** committed — it's
  the website.
- Tune search queries, locations, and timing in the `CONFIG` block at the
  top of `job_bot.py`.
