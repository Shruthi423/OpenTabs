# OpenTabs — UX/Design Job Tracker

Scrapes UX/product design jobs from LinkedIn, Indeed, Glassdoor, ZipRecruiter,
Y Combinator, BuiltIn SF and many design boards, sends Telegram alerts, and
publishes a live one-page dashboard. Built for an early-career designer job hunt.

**Live dashboard:** https://shruthi423.github.io/OpenTabs/

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
   python3 opentabs.py
   ```
   It runs continuously: a job check every 15 minutes, an hourly heartbeat,
   and a daily digest at 9 AM Pacific. Press `Ctrl+C` to stop. (Or run it in
   the background — see below.)

## Web dashboard (GitHub Pages)

The bot also publishes a one-page dashboard with three sections — **New**
(found in the last 24h), **Yet to Apply**, and **Applied**. You move jobs
between sections with the **Done** / **Not yet** buttons on each card; your
choices are saved in your browser and the board updates itself.

**One-time setup:**
1. In `opentabs.py` `CONFIG`, set `GITHUB_USER` and `GITHUB_REPO`.
2. Push this repo to GitHub (make sure `git push` works without a prompt —
   use a saved HTTPS token or SSH key).
3. On GitHub: **Settings → Pages → Source: Deploy from a branch →
   `main` branch, `/docs` folder** (must be `/docs`, not root).
4. Your dashboard goes live at
   `https://<GITHUB_USER>.github.io/<GITHUB_REPO>/`.

The bot regenerates `docs/jobs.json` and commits/pushes it each cycle, so the
page stays current. Set `PUBLISH_TO_GIT` to `False` to disable auto-publish.

> Note: a free GitHub Pages site is **public** — anyone with the link can see
> the listings (no personal data, just public job posts).

## Résumé hand-off

Every job card has a **Résumé** button that copies the full job description
to your clipboard and opens your Claude (or ChatGPT) project — the one with
your résumé instructions preloaded. The loop becomes click → `⌘V` → enter,
instead of opening the posting, selecting all, copying, switching tabs and
starting a new chat.

Set your project link once from the **Résumé** button in the left rail —
Claude or ChatGPT, whichever you use; nothing in the code is specific to
either. Clicking **Résumé** on a card before you've set one opens the same
panel and finishes the click as soon as you save.

Paste the link to the **project**, not to a conversation. A project page
carries its own composer, so pasting there starts a *new chat inside the
project* every time. A link to a single chat would pile every job into that
one conversation — the panel warns you if it spots one.

The button carries three states:

| State | Looks like | Meaning |
| --- | --- | --- |
| `Résumé` | outlined | not started — click to copy + open the project |
| `Downloaded?` | dashed, quiet | pasted into the project; click when the résumé is saved |
| `Résumé ✓` | filled | done — click again to re-copy and reopen |

The middle state is a mark you flip, like **Applied**. Nothing can see inside
your Claude tab, so the site can't detect on its own that the résumé is ready.

**Why the résumé isn't generated automatically:** your project's preloaded
instructions are what make the résumé good, and there's no API that can start
a chat inside one. A bot that generated résumés over the API would be a second
set of instructions quietly drifting away from the ones you actually tune.

Cards whose description couldn't be fetched carry a dashed **no description**
badge, so you know before clicking that the hand-off will be the title and
link only — copy the posting text yourself for those. The badge appears only
after the bot has given up (`JD_MAX_TRIES`), never while a fetch is queued.

To feed the button, `opentabs.py` fetches the description for a few postings
each cycle (`JD_FETCH_PER_CYCLE`, newest first) and publishes each one as
`docs/jd/<runner>/<id>.txt`. They're written once and fetched only when you
click, so the board's first load stays small and each cycle commits only the
handful of descriptions it just fetched. Postings behind a login wall (YC,
some boards) are retried `JD_MAX_TRIES` times, then left alone — the button
still works, it just hands over the title and link.

## Applied log and CSV export

The **Applied** drawer groups by the day you applied — Today, Yesterday, then
weekday names, then week and month — so it answers "what did I send this
week?" and not just "did I apply?". Marks made before this existed have no
date and collect under *Earlier*.

**Export CSV** in that drawer writes every untrashed job with its status,
applied date, résumé stage, outreach stage and dates. It opens in Excel or
Sheets and is the durable copy of a board that otherwise lives entirely in
one browser's local storage — worth downloading now and then.

## LinkedIn outreach

One button per card walks a company through the whole arc. Finding someone and
writing to them are the same errand, so they're the same control:

| Button | What the click does |
| --- | --- |
| `People` | opens the company's LinkedIn People tab, filtered to design |
| `Note` | copies the role, company and description, opens your outreach project |
| `Sent?` | you telling the board the connection request went out (starts the clock) |
| `4d · Accepted?` | days since you asked — click when they accept |
| `Follow up` | copies a follow-up brief and opens the project again |
| `Reached ✓` | done |

State is keyed by **company, not job**, so two open roles at the same place are
one conversation and you can't accidentally reach out twice. Opening a people
search isn't a commitment, so it doesn't show in the drawer until you've
actually drafted something; the ✕ on a drawer row forgets a thread entirely.

Cognition mode (the one-card-at-a-time view) carries both actions too, on
`P` and `R` alongside the existing `A` and `X` — neither advances the deck,
since drafting a note isn't a decision about the job.

A card carries four controls, not seven: two labelled pills for the things
this board is for — **People** and **Résumé** — plus Applied and Trash as
icons, and the company's website and LinkedIn page as bare icons on the left.

The **Outreach** drawer is the point of tracking any of it. A request you sent
nine days ago is invisible on a board sorted by posting date, and that's
exactly the one you'd forget — so it groups by what you'd do next: *ready to
follow up*, *waiting on* (oldest first, reddening past a week), *drafted, not
sent*. The tab count shows only what needs a move from you. Clicking a row
jumps to the job card.

**Nothing here sends anything.** LinkedIn's terms forbid automated activity
and an account restriction would cost far more than the clicks save, so every
message is one you read and send yourself. As with résumés, the stages you
can't observe from a web page — sent, accepted — are marks you flip, exactly
like **Applied**.

Set a separate **Outreach project** in the rail panel if you want one: a
300-character intro and a tailored résumé are different instruction sets and
one project doing both does neither well. Leave it blank to use the same
project for both.

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
tail -f ~/Desktop/OpenTabs/job_bot.log
```

The **first run is a silent backfill** (seeds the board, no Telegram alerts);
delete `backfill_done.flag` if you ever want to re-run that.

## Notes

- `.env` holds your secrets and is git-ignored — never commit it.
- `seen_jobs.json`, `pending_jobs.json`, `jobs_store.json`, `tg_offset.json`
  are local state (git-ignored). The `docs/` folder **is** committed — it's
  the website.
- Tune search queries, locations, and timing in the `CONFIG` block at the
  top of `opentabs.py`.
