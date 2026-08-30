"""
╔══════════════════════════════════════════════════════════════════╗
║   🎨  UX/DESIGN JOB ALERT BOT  — Final Version                  ║
║   Channel: 🎨 Job Alerts                                         ║
║   Engine: JobSpy (LinkedIn, Indeed, Glassdoor, ZipRecruiter)     ║
║   + RSS boards (Remotive, Dribbble, WeWorkRemotely etc.)         ║
║   Alerts: 2 min first · 7 min reminder                          ║
║   Graduating: May 2026 🎓                                        ║
╚══════════════════════════════════════════════════════════════════╝
"""

import json, os, time, hashlib, logging, schedule, requests, re, html, subprocess, math
import feedparser
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from dotenv import load_dotenv

load_dotenv()  # read secrets from a local .env file (never committed)

# ─────────────────────────────────────────────────────────────────
#  ⚙️  CONFIGURATION — secrets loaded from .env, rest pre-filled
# ─────────────────────────────────────────────────────────────────
CONFIG = {
    "TELEGRAM_BOT_TOKEN": os.environ["TELEGRAM_BOT_TOKEN"],
    "TELEGRAM_CHAT_ID":   os.environ["TELEGRAM_CHAT_ID"],
    # ── Funding alerts → separate channel. CHAT_ID enables the feature;
    #    TOKEN falls back to the job bot's token when left blank. ──
    "TELEGRAM_FUNDING_BOT_TOKEN": os.environ.get("TELEGRAM_FUNDING_BOT_TOKEN", "").strip()
                                  or os.environ["TELEGRAM_BOT_TOKEN"],
    "TELEGRAM_FUNDING_CHAT_ID":   os.environ.get("TELEGRAM_FUNDING_CHAT_ID", "").strip(),
    "POLL_INTERVAL_MINUTES": 15,
    "REMINDER_MINUTES":      30,
    "HEARTBEAT_HOURS":       1,
    "DAILY_DIGEST_HOUR":     9,
    "HOURS_OLD":             24,
    "RESULTS_PER_SEARCH":    25,
    "QUERIES_PER_CYCLE":     5,        # rotate JobSpy queries per cycle to dodge blocks
    "SEEN_FILE":    "seen_jobs.json",
    "PENDING_FILE": "pending_jobs.json",
    "STORE_FILE":   "jobs_store.json",      # authoritative job records + status (local)
    "WEB_FILE":     "docs/jobs.json",        # derived data the website reads (published)
    # ── Funding pipeline state (local) + published data file ──
    "SEEN_FUNDING_FILE":    "seen_funding.json",
    "PENDING_FUNDING_FILE": "pending_funding.json",
    "FUNDING_STORE_FILE":   "funding_store.json",
    "FUNDING_WEB_FILE":     "docs/funding.json",
    "SITE_DIR":     "docs",                  # GitHub Pages serves from /docs on main
    "TG_OFFSET_FILE": "tg_offset.json",      # last processed Telegram update id
    "QUERY_OFFSET_FILE": "query_offset.json",  # rotating cursor into SEARCH_QUERIES
    "LOG_FILE":     "job_bot.log",
    "TIMEZONE":     "America/Los_Angeles",
    "NEW_HOURS":      24,                     # jobs newer than this show under "New"
    "PUBLISH_TO_GIT": True,                   # auto commit+push the dashboard each cycle
    "GITHUB_USER":  "Shruthi423",             # GitHub username (for the dashboard URL)
    "GITHUB_REPO":  "OpenTabs",               # repo name
    # ── Laptop-half watchdog ──
    # The laptop (MODE=local) stamps this heartbeat into docs/ every cycle; it
    # rides along in the normal publish push. The always-on cloud runner
    # (MODE=cloud) watches it and pings Telegram when it goes quiet.
    "LOCAL_HEARTBEAT_FILE":      "docs/local_heartbeat.json",
    "LOCAL_WATCH_STATE":         "local_watch.cloud.json",  # cloud alert state (committed)
    "LOCAL_SILENT_ALERT_HOURS":  3,           # ping if the laptop half is silent this long
}

# ── Backfill flags (per-mode below) ──
CONFIG["BACKFILL_FLAG"]         = "backfill_done.flag"
CONFIG["FUNDING_BACKFILL_FLAG"] = "funding_backfill_done.flag"

# ─────────────────────────────────────────────────────────────────
#  🔀  RUN MODE — hybrid split between the laptop and GitHub Actions
#  ─────────────────────────────────────────────────────────────────
#  "local" : browser-scraped sites (LinkedIn / Indeed / Glassdoor /
#            ZipRecruiter / Google) that need a residential IP — run on the
#            Mac whenever it's on.
#  "cloud" : the API / RSS sources (Greenhouse·Lever·Ashby, YC, BuiltIn,
#            UXJobs, funding radar…) that work great from a datacenter IP —
#            run on GitHub Actions 24/7.
#  "all"   : everything on one machine (the original single-runner behaviour).
#  Each runner writes its OWN data + state files, so the two never clobber
#  each other in the repo; the dashboard merges jobs.local.json +
#  jobs.cloud.json (see app.js). ──
MODE = os.environ.get("OPENTABS_MODE", "all").strip().lower()
if MODE not in ("all", "local", "cloud"):
    MODE = "all"
# RUN_ONCE: do a single cycle and exit (GitHub Actions cron), instead of the
# long-lived schedule loop used on the Mac.
RUN_ONCE    = os.environ.get("RUN_ONCE", "").strip().lower() not in ("", "0", "false", "no")
DO_SCRAPERS = MODE in ("all", "local")    # JobSpy browser scrapers
DO_APIS     = MODE in ("all", "cloud")    # API/RSS/ATS sources + funding radar

if MODE != "all":
    _sx = MODE                            # "local" | "cloud"
    CONFIG["WEB_FILE"]             = f"docs/jobs.{_sx}.json"
    CONFIG["SEEN_FILE"]            = f"seen_jobs.{_sx}.json"
    CONFIG["PENDING_FILE"]        = f"pending_jobs.{_sx}.json"
    CONFIG["STORE_FILE"]          = f"jobs_store.{_sx}.json"
    CONFIG["SEEN_FUNDING_FILE"]   = f"seen_funding.{_sx}.json"
    CONFIG["PENDING_FUNDING_FILE"]= f"pending_funding.{_sx}.json"
    CONFIG["FUNDING_STORE_FILE"]  = f"funding_store.{_sx}.json"
    CONFIG["QUERY_OFFSET_FILE"]   = f"query_offset.{_sx}.json"
    CONFIG["TG_OFFSET_FILE"]      = f"tg_offset.{_sx}.json"
    CONFIG["BACKFILL_FLAG"]        = f"backfill_done.{_sx}.flag"
    CONFIG["FUNDING_BACKFILL_FLAG"]= f"funding_backfill_done.{_sx}.flag"
    # Funding only runs cloud-side; keep the single published filename so the
    # Just-Raised page always reads ./funding.json regardless of who wrote it.

# Let the environment force git publishing on/off (Actions sets this false so
# the workflow can commit the .cloud state files alongside docs/, in one push).
_pub = os.environ.get("PUBLISH_TO_GIT")
if _pub is not None:
    CONFIG["PUBLISH_TO_GIT"] = _pub.strip().lower() not in ("0", "false", "no", "")

TZ = ZoneInfo(CONFIG["TIMEZONE"])
def now_pt(): return datetime.now(TZ)

# ─────────────────────────────────────────────────────────────────
#  🎯  SEARCH QUERIES
# ─────────────────────────────────────────────────────────────────
SEARCH_QUERIES = [
    "product designer",
    "founding product designer",
    "UI designer",
    "UX designer",
    "UI/UX designer",
    "UX researcher",
    # ── adjacent roles ──
    "founding designer",
    "product design engineer",
    "design technologist",
    "interaction designer",
    "design systems designer",
    "brand designer",
    "user researcher",
    "new grad designer",
]

# US-focused. "United States" pulls nationwide (LinkedIn/Indeed); the
# location_rank() filter then keeps US-only and ranks by priority.
LOCATIONS = [
    "San Francisco, CA",
    "San Francisco Bay Area, CA",
    "United States",
]

# ─────────────────────────────────────────────────────────────────
#  🏢  BIG TECH LIST
# ─────────────────────────────────────────────────────────────────
BIG_TECH = {
    "google", "meta", "apple", "amazon", "netflix", "microsoft",
    "uber", "airbnb", "stripe", "openai", "anthropic", "figma",
    "notion", "slack", "dropbox", "lyft", "pinterest", "salesforce",
    "adobe", "canva", "linear", "vercel", "databricks", "robinhood",
    "coinbase", "doordash", "instacart", "reddit", "asana", "airtable",
    "miro", "webflow", "brex", "rippling", "scale ai", "perplexity",
    "cursor", "replit", "twitch", "snap", "bytedance", "tiktok",
    "palantir", "spacex", "tesla", "waymo", "mistral", "cohere",
}

# ─────────────────────────────────────────────────────────────────
#  🔍  RELEVANCE FILTER
# ─────────────────────────────────────────────────────────────────
INCLUDE = [
    "ux", "ui", "user experience", "user interface", "product designer",
    "interaction designer", "visual designer", "ux researcher",
    "user researcher", "design researcher", "design systems",
    "design technologist", "service designer", "founding designer",
    "motion designer", "brand designer", "product design",
]
EXCLUDE = [
    "graphic designer", "fashion", "interior design", "industrial design",
    "game designer", "floral", "packaging", "print designer",
    "instructional designer", "curriculum", "learning designer",
    "software engineer", "data engineer", "devops", "web developer",
    # physical / industrial / engineering design (titles) — digital UI/UX only.
    # "mechanical" catches e.g. "Mechanical Design Engineer", which otherwise
    # sneaks through on the "design engineer" include. (Broader words like
    # "manufacturing"/"electrical" live in PHYSICAL_DESIGN as whole-word matches
    # to avoid nuking e.g. a UX role for "Manufacturing Cloud".)
    "industrial designer", "hardware designer", "mechanical designer",
    "mechanical", "cad designer", "footwear designer",
    "apparel designer", "furniture designer", "soft goods designer",
    "packaging designer",
    # seniority — we want roles for ≤4 years of experience
    "senior", "staff", "principal", "lead", "director", "head of",
    "vp ", "vice president", "manager",
]
# Physical / industrial product design is NOT UI/UX. These terms are near-
# exclusive to hardware/industrial work, so a hit anywhere in the posting is a
# reliable signal even when the title is just "Product Designer" / "Design
# Engineer". High-precision on purpose — collaboration-context words like
# "hardware"/"manufacturing" alone are omitted to avoid nuking digital
# designers who merely work near a hardware team.
PHYSICAL_DESIGN = [
    "industrial design", "industrial designer", "solidworks", "autocad",
    "keyshot", "rhino 3d", "rhinoceros 3d", "injection molding",
    "injection moulding", "design for manufacturing", "sheet metal",
    "cad software", "3d cad", "cad modeling", "cmf design",
    "color material finish", "soft goods", "footwear", "plastic part",
    "physical product", "consumer hardware", "mechanical engineer",
    "mechanical design", "manufacturing engineer", "fab design", "clean room",
    "electrical engineer", "fabrication", "semiconductor", "wafer",
]
NEW_GRAD_SIGNALS = [
    "new grad", "new graduate", "entry level", "entry-level", "junior",
    "associate", "0-2 years", "0-1 year", "recent graduate",
    "early career", "2026", "2025 grad",
]

def _physical_design(text: str) -> bool:
    """True if the posting reads as physical/industrial design (hardware, CAD,
    footwear…) rather than digital UI/UX. Word-boundary matched for precision."""
    for kw in PHYSICAL_DESIGN:
        if re.search(rf"\b{re.escape(kw)}\b", text):
            return True
    return False

def _kw_hit(kw: str, text: str) -> bool:
    # Short ambiguous tokens (ui/ux) must match as whole words, else
    # "recrUIter", "bUIld", "deluXe"… create false design matches.
    if len(kw) <= 2:
        return re.search(rf"\b{re.escape(kw)}\b", text) is not None
    return kw in text

# Year figures framed as "preferred / a plus / bonus" don't disqualify — many
# roles open to new grads still list a higher "preferred" number.
_PREF_RE = re.compile(r'(preferred|a plus|nice to have|bonus|ideal|or more)', re.I)
def _too_senior(text: str) -> bool:
    # Exclude roles whose MINIMUM required experience is 5+ years.
    # "3-5 years" → min 3 (kept); "5+ years" / "6 years" → min 5+ (dropped),
    # unless the figure is framed as preferred rather than required.
    for m in re.finditer(r'(\d+)\s*\+?\s*(?:-|to|–|—)?\s*\d*\s*(?:years|yrs)\b', text):
        if int(m.group(1)) >= 5:
            window = text[max(0, m.start() - 40): m.end() + 40]
            if _PREF_RE.search(window):
                continue
            return True
    return False

# ── Visa sponsorship — best-effort from the posting text. Many roles don't
#    say either way (→ None); we only flag explicit statements. "no" is checked
#    first because "sponsorship" appears in both the yes and no phrasings. ──
_VISA_NO_RE = re.compile(
    r'(no (?:visa )?sponsorship|not able to sponsor|cannot sponsor|unable to sponsor|'
    r'do(?:es)? not (?:offer |provide )?sponsor|not (?:offer|provide|able to offer) sponsor|'
    r'without (?:requiring )?(?:visa )?sponsorship|not (?:be )?(?:able|eligible) .{0,20}sponsor|'
    r'authorized to work .{0,40}without sponsorship|no(?:t)? .{0,20}immigration sponsorship)', re.I)
_VISA_YES_RE = re.compile(
    r'(visa sponsorship|will sponsor|we sponsor|sponsor(?:ship)? (?:is )?available|'
    r'offer(?:s)? (?:visa )?sponsorship|provide(?:s)? (?:visa )?sponsorship|open to sponsor|'
    r'able to sponsor|can sponsor|\bh-?1b\b|green card sponsor|immigration sponsorship)', re.I)

def extract_visa(text: str):
    if not text:
        return None
    if _VISA_NO_RE.search(text):
        return "no"
    if _VISA_YES_RE.search(text):
        return "yes"
    return None

def classify(title: str, company: str = "", description: str = "") -> dict:
    text = f"{title} {description}".lower()
    tl   = title.lower()
    co   = company.lower()
    for ex in EXCLUDE:
        if ex in tl:
            return {"relevant": False}
    if _physical_design(text):          # drop physical/industrial product design
        return {"relevant": False}
    if _too_senior(text):
        return {"relevant": False}
    if not any(_kw_hit(kw, text) for kw in INCLUDE):
        return {"relevant": False}
    return {
        "relevant":    True,
        "is_new_grad": any(s in text for s in NEW_GRAD_SIGNALS),
        "is_big_tech": any(bt in co for bt in BIG_TECH),
    }

# ─────────────────────────────────────────────────────────────────
#  📝  LOGGING
# ─────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(CONFIG["LOG_FILE"]), logging.StreamHandler()],
)
log = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────
#  💾  STATE
# ─────────────────────────────────────────────────────────────────
def load_json(path, default):
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception as e:
            log.warning(f"load_json({path}) failed, using default: {e}")
    return default

def save_json(path, data):
    """Write via a temp file + rename. A direct write leaves the file
    half-formed while json.dump runs, and the website fetches these paths on
    a 60s timer — it would occasionally parse a truncated file and silently
    fall back to an empty list."""
    tmp = f"{path}.tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)          # atomic on POSIX
    except Exception:
        if os.path.exists(tmp):
            try: os.remove(tmp)
            except OSError: pass
        raise

def load_seen() -> set:    return set(load_json(CONFIG["SEEN_FILE"], []))
def save_seen(s):          save_json(CONFIG["SEEN_FILE"], list(s))
def load_pending() -> list: return load_json(CONFIG["PENDING_FILE"], [])
def save_pending(p):       save_json(CONFIG["PENDING_FILE"], p)

# ── Website job store (jid → record with status + first_seen) ──
def load_store() -> dict:  return load_json(CONFIG["STORE_FILE"], {})
def save_store(s):         save_json(CONFIG["STORE_FILE"], s)
def load_offset() -> int:  return int(load_json(CONFIG["TG_OFFSET_FILE"], 0))
def save_offset(o):        save_json(CONFIG["TG_OFFSET_FILE"], o)

# ── Backoff tracker ──
BACKOFF = {}
def is_cooling(source): return now_pt() < datetime.fromisoformat(BACKOFF[source]) if source in BACKOFF else False
def set_cooldown(source, mins=30):
    BACKOFF[source] = (now_pt() + timedelta(minutes=mins)).isoformat()
    log.warning(f"⏸ {source} cooling down {mins} min")

def job_id(title, company, location):
    loc = location.lower()
    if any(x in loc for x in ["san francisco", "bay area", "palo alto", "mountain view", "sunnyvale", "san jose"]):
        loc = "bayarea"
    elif "remote" in loc:
        loc = "remote"
    key = f"{title.lower().strip()}|{company.lower().strip()}|{loc}"
    return hashlib.md5(key.encode()).hexdigest()

# ─────────────────────────────────────────────────────────────────
#  📬  TELEGRAM ONLY
# ─────────────────────────────────────────────────────────────────
_LAST_SEND = {"t": 0.0}   # monotonic timestamp of the last Telegram send (rate limiter)
def send_telegram(msg: str, reply_markup: dict = None,
                  token: str = None, chat_id: str = None) -> bool:
    # Defaults target the job channel; pass token/chat_id to reach another
    # channel (e.g. the funding channel).
    token   = token or CONFIG["TELEGRAM_BOT_TOKEN"]
    chat_id = chat_id or CONFIG["TELEGRAM_CHAT_ID"]
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id":    chat_id,
        "text":       msg,
        "parse_mode": "HTML",
        "disable_web_page_preview": False,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    # Telegram throttles to ~1 msg/sec per chat / ~20 per min to a group. We
    # space sends and honor the server's retry_after so burst alerts aren't
    # silently dropped (the old code returned False and lost the message).
    for attempt in range(4):
        gap = 1.1 - (time.monotonic() - _LAST_SEND["t"])
        if gap > 0:
            time.sleep(gap)
        try:
            r = requests.post(url, json=payload, timeout=10)
            _LAST_SEND["t"] = time.monotonic()
            if r.status_code == 429:
                try:
                    wait = int(r.json().get("parameters", {}).get("retry_after", 2))
                except Exception:
                    wait = 2
                log.warning(f"Telegram 429 — waiting {wait}s (attempt {attempt+1}/4)")
                time.sleep(wait + 1)
                continue
            if r.status_code != 200:
                log.error(f"Telegram error {r.status_code}: {r.text[:100]}")
                return False
            return True
        except Exception as e:
            log.error(f"Telegram: {e}")
            time.sleep(2)
    log.error("Telegram: gave up after repeated 429s")
    return False

def send_funding(msg: str) -> bool:
    return send_telegram(msg, token=CONFIG["TELEGRAM_FUNDING_BOT_TOKEN"],
                         chat_id=CONFIG["TELEGRAM_FUNDING_CHAT_ID"])

def funding_enabled() -> bool:
    return bool(CONFIG["TELEGRAM_FUNDING_CHAT_ID"])

def notify(job: dict, reminder: bool = False, jid: str = ""):
    title   = job.get("title", "?")
    company = job.get("company", "?")
    loc     = job.get("location", "?")
    salary  = job.get("salary", "Not listed")
    url     = job.get("url", "")
    source  = job.get("source", "")
    ng      = job.get("is_new_grad", False)
    bt      = job.get("is_big_tech", False)

    badges = ""
    if job.get("is_funded"): badges += "💰 JUST RAISED  "
    if ng: badges += "🎓 NEW GRAD FRIENDLY  "
    if bt: badges += "⭐ BIG TECH"

    # Tap-to-track buttons (move the job between dashboard sections)
    kb = {"inline_keyboard": [[
        {"text": "✅ Applied",  "callback_data": f"a:{jid}"},
        {"text": "🗑 Dismiss",  "callback_data": f"d:{jid}"},
    ]]} if jid else None

    if reminder:
        send_telegram(
            f"⏰ <b>REMINDER — Applied yet?</b>\n\n"
            f"🎨 <b>{title}</b>\n"
            f"🏢 <b>{company}</b>\n"
            f"📍 {loc}\n\n"
            f"Posted ~7 mins ago. Early applicants get 3× more callbacks!\n\n"
            f'🔗 <a href="{url}">Apply Now →</a>',
            reply_markup=kb,
        )
    else:
        send_telegram(
            f"🚨 <b>NEW JOB — Act in 2 Minutes!</b>\n"
            + (f"{badges}\n" if badges else "") +
            f"\n🎨 <b>{title}</b>\n"
            f"🏢 <b>{company}</b>\n"
            f"📍 <b>{loc}</b>\n"
            f"💰 <b>{salary}</b>\n"
            f"🌐 <b>{source}</b>\n\n"
            f'🔗 <a href="{url}">View &amp; Apply Now →</a>\n\n'
            f"<i>⚡ Seen within 2 mins of posting!</i>",
            reply_markup=kb,
        )

# ─────────────────────────────────────────────────────────────────
#  🔘  TELEGRAM CALLBACKS — tap Applied / Dismiss to update dashboard
# ─────────────────────────────────────────────────────────────────
TG_API = lambda m: f"https://api.telegram.org/bot{CONFIG['TELEGRAM_BOT_TOKEN']}/{m}"

def update_status(jid: str, status: str):
    store = load_store()
    if jid in store:
        store[jid]["status"] = status
        store[jid]["applied_at"] = now_pt().isoformat() if status == "applied" else None
        save_store(store)
        return store[jid]
    return None

def _answer_callback(cqid: str, text: str = ""):
    try:
        requests.post(TG_API("answerCallbackQuery"),
                      json={"callback_query_id": cqid, "text": text}, timeout=10)
    except Exception as e:
        log.error(f"answerCallback: {e}")

def _mark_message(chat_id, msg_id, status):
    if not (chat_id and msg_id): return
    label = "✅ Applied" if status == "applied" else "🗑 Dismissed"
    try:
        requests.post(TG_API("editMessageReplyMarkup"),
                      json={"chat_id": chat_id, "message_id": msg_id,
                            "reply_markup": {"inline_keyboard": [[{"text": label, "callback_data": "noop"}]]}},
                      timeout=10)
    except Exception as e:
        log.error(f"editMarkup: {e}")

def poll_telegram():
    """Short-poll getUpdates and apply any Applied/Dismiss button taps."""
    try:
        r = requests.get(TG_API("getUpdates"),
                         params={"offset": load_offset() + 1, "timeout": 0,
                                 "allowed_updates": json.dumps(["callback_query"])}, timeout=15)
        if r.status_code != 200:
            return
        changed = False
        for upd in r.json().get("result", []):
            save_offset(upd["update_id"])
            cq = upd.get("callback_query")
            if not cq:
                continue
            data    = cq.get("data", "")
            msg     = cq.get("message", {}) or {}
            chat_id = (msg.get("chat") or {}).get("id")
            msg_id  = msg.get("message_id")
            if ":" in data:
                action, jid = data.split(":", 1)
                status = {"a": "applied", "d": "dismissed"}.get(action)
                if status and update_status(jid, status):
                    changed = True
                    _answer_callback(cq["id"], "✅ Marked applied" if status == "applied" else "🗑 Dismissed")
                    _mark_message(chat_id, msg_id, status)
                    continue
            _answer_callback(cq["id"])
        if changed:
            publish_site()
    except Exception as e:
        log.error(f"poll_telegram: {e}")

# ─────────────────────────────────────────────────────────────────
#  🔎  JOBSPY SCRAPER
# ─────────────────────────────────────────────────────────────────
H = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

def _http_get(name: str, url: str, *, timeout: int = 15,
              accept_json: bool = False, cooldown: int = 60):
    """Shared fetch for the RSS/custom scrapers. Respects each source's
    cooldown, backs off on 429, and logs non-200s so a dead source is
    distinguishable from a genuinely empty one. Returns the Response or None."""
    if is_cooling(name):
        return None
    hdrs = {**H, "Accept": "application/json"} if accept_json else H
    try:
        r = requests.get(url, headers=hdrs, timeout=timeout)
        if r.status_code == 429:
            set_cooldown(name, cooldown)
            return None
        if r.status_code != 200:
            log.warning(f"{name}: HTTP {r.status_code}")
            return None
        return r
    except Exception as e:
        log.error(f"{name}: {e}")
        return None

def scrape_jobspy(query: str, location: str, sites=None) -> list:
    try:
        from jobspy import scrape_jobs
    except ImportError:
        log.error("JobSpy not installed! Run: pip3 install python-jobspy")
        return []

    if sites is None:
        # Google Jobs AGGREGATES LinkedIn/Indeed/Glassdoor/ZipRecruiter postings,
        # so we get Glassdoor/ZipRecruiter coverage through it without scraping
        # them directly (they hard-block JobSpy: Glassdoor 400, ZipRecruiter 403,
        # regardless of IP). ZipRecruiter's official API is the cloud path.
        sites = ["linkedin", "indeed", "google"]

    active = [s for s in sites if not is_cooling(s)]
    if not active:
        return []

    try:
        df = scrape_jobs(
            site_name=active,
            search_term=query,
            location=location,
            results_wanted=CONFIG["RESULTS_PER_SEARCH"],
            hours_old=CONFIG["HOURS_OLD"],
            country_indeed="USA",
            job_type="fulltime",
        )
        if df is None or df.empty:
            return []

        # JobSpy returns pandas NaN (a truthy float) for missing pay — guard
        # against it, else int(NaN) raises and the whole query's rows are lost.
        def _money(x):
            try:
                if x is None or (isinstance(x, float) and math.isnan(x)):
                    return None
                return int(x)
            except (ValueError, TypeError):
                return None

        jobs = []
        for _, row in df.iterrows():
            salary = "Not listed"
            lo = _money(row.get("min_amount"))
            hi = _money(row.get("max_amount"))
            if lo and hi:
                salary = f"${lo:,} – ${hi:,} / {row.get('interval','yr')}"
            elif lo:
                salary = f"${lo:,}+"

            job = {
                "title":    str(row.get("title", "")).strip(),
                "company":  str(row.get("company", "")).strip(),
                "location": str(row.get("location", location)).strip(),
                "url":      str(row.get("job_url", "")),
                "salary":   salary,
                "description": str(row.get("description", ""))[:400],
                "posted_at": str(row.get("date_posted", "Recently")),
                "source":   str(row.get("site", "")).title(),
                "visa":     extract_visa(str(row.get("description", ""))),  # full text
            }
            if job["title"] and job["url"]:
                jobs.append(job)
        return jobs

    except Exception as e:
        err = str(e).lower()
        log.error(f"JobSpy [{query}@{location}]: {e}")
        if "429" in err or "rate" in err or "blocked" in err or "403" in err or "400" in err:
            if "linkedin"  in err: set_cooldown("linkedin", 60)
            if "indeed"    in err: set_cooldown("indeed", 30)
            if "glassdoor" in err: set_cooldown("glassdoor", 45)
            if "ziprecruiter" in err or "zip_recruiter" in err: set_cooldown("zip_recruiter", 45)
            if "google"    in err: set_cooldown("google", 30)
        return []

def scrape_rss(name: str, url: str, default_location="Remote") -> list:
    r = _http_get(name, url)
    if r is None: return []
    jobs = []
    try:
        # feedparser tolerates real-world quirks (undefined entities, raw &,
        # custom namespaces) that the strict stdlib XML parser rejects.
        feed = feedparser.parse(r.content)
        for entry in feed.entries[:12]:
            title = (entry.get("title") or "").strip()
            link  = (entry.get("link") or "").strip()
            desc  = (entry.get("summary") or entry.get("description") or "").strip()
            company = "Unknown"
            if ": " in title and name == "WeWorkRemotely":
                parts = title.split(": ", 1)
                company, title = parts[0].strip(), parts[1].strip()
            else:
                company = (
                    (entry.get("author") or "").strip() or
                    (entry.get("company_name") or "").strip() or
                    "Unknown"
                )
            salary = "See posting"
            m = re.search(r'\$[\d,]+(?:\s*[-–]\s*\$[\d,]+)?', desc)
            if m: salary = m.group(0)
            jobs.append({
                "title": title, "company": company,
                "location": default_location, "url": link,
                "salary": salary,
                "description": re.sub(r"<[^>]+>", "", desc)[:300],
                "posted_at": "Recently", "source": name,
            })
    except Exception as e:
        log.error(f"RSS {name}: {e}")
    return jobs

RSS_FEEDS = [
    ("WeWorkRemotely", "https://weworkremotely.com/categories/remote-design-jobs.rss"),
    ("Dribbble",       "https://dribbble.com/jobs.rss?location=United+States"),
    ("AuthenticJobs",  "https://authenticjobs.com/feed/?type=4"),
    ("Coroflot",       "https://www.coroflot.com/jobs/rss?discipline=interaction_ux_ui"),
    # ── Added (verified working) ──
    ("NoDesk",         "https://nodesk.co/remote-jobs/design/index.xml"),
    ("RealWFA",        "https://www.realworkfromanywhere.com/remote-design-jobs/rss.xml"),
    ("RealWFA-Product","https://www.realworkfromanywhere.com/remote-product-jobs/rss.xml"),
    ("RemoteOK",       "https://remoteok.com/remote-design-jobs.rss"),
    ("Himalayas",      "https://himalayas.app/jobs/rss"),
    ("JobsCollider",   "https://jobscollider.com/remote-design-jobs.rss"),
    ("JobsCollider-Product", "https://jobscollider.com/remote-product-jobs.rss"),
    ("HackerNews",     "https://hnrss.org/newest?q=ux+designer"),
]

# ─────────────────────────────────────────────────────────────────
#  🌉  SF / BAY AREA + STARTUP SOURCES (custom scrapers)
# ─────────────────────────────────────────────────────────────────
# ── US-only location filter with priority tiers ──
#   1 = San Francisco · 2 = Bay Area · 3 = Seattle/LA/NY/Philly ·
#   4 = other US · 5 = US-remote · None = explicit foreign (excluded)
NON_US = [
    "india", "bengaluru", "bangalore", "mumbai", "delhi", "hyderabad", "pune",
    "chennai", "gurgaon", "noida", "kolkata", "ahmedabad",
    "dubai", "abu dhabi", "uae", "united arab emirates", "qatar", "doha",
    "saudi", "riyadh", "bahrain", "kuwait", "oman",
    "united kingdom", "england", "scotland", " uk", "u.k", "london", "manchester",
    "canada", "toronto", "vancouver", "montreal", "ottawa", "ontario", "calgary",
    "germany", "berlin", "munich", "hamburg", "france", "paris", "lyon",
    "netherlands", "amsterdam", "spain", "madrid", "barcelona", "portugal", "lisbon",
    "ireland", "dublin", "poland", "warsaw", "krakow", "romania", "bucharest", "ukraine",
    "italy", "rome", "milan", "sweden", "stockholm", "denmark", "copenhagen",
    "norway", "oslo", "finland", "helsinki", "switzerland", "zurich", "geneva",
    "austria", "vienna", "belgium", "brussels", "czech", "prague", "hungary", "budapest",
    "greece", "athens", "singapore", "australia", "sydney", "melbourne", "brisbane",
    "new zealand", "auckland", "brazil", "sao paulo", "mexico", "argentina",
    "colombia", "bogota", "chile", "peru", "japan", "tokyo", "china", "beijing",
    "shanghai", "hong kong", "taiwan", "south korea", "seoul",
    "pakistan", "nepal", "bangladesh", "sri lanka", "nigeria", "lagos", "kenya",
    "nairobi", "egypt", "cairo", "morocco", "tunisia", "ghana", "uzbekistan",
    "south africa", "philippines", "manila", "indonesia", "jakarta", "vietnam",
    "hanoi", "thailand", "bangkok", "malaysia", "kuala lumpur", "turkey", "türkiye",
    "istanbul", "israel", "tel aviv", "worldwide", "emea", "apac", "latam",
]
_P2_BAY = ["bay area", "oakland", "palo alto", "mountain view", "san jose",
           "sunnyvale", "berkeley", "menlo park", "redwood city", "santa clara",
           "south san francisco", "cupertino", "fremont", "emeryville", "san mateo"]
_P3_CITIES = ["seattle", "los angeles", "l.a.", "new york", "nyc", "manhattan",
              "brooklyn", "philadelphia", "philly"]
_US_STATE_RE = re.compile(
    r',\s*(a[klzr]|c[aot]|d[ce]|fl|ga|hi|i[adln]|k[sy]|la|m[adeinost]|n[cdehjmvy]|'
    r'o[hkr]|pa|ri|s[cd]|t[nx]|ut|v[at]|w[aivy])\b', re.I)

def location_rank(location: str):
    t = (location or "").lower()
    if any(tok in t for tok in NON_US):
        return None
    if "san francisco" in t:
        return 1
    if any(k in t for k in _P2_BAY):
        return 2
    if any(k in t for k in _P3_CITIES):
        return 3
    if "united states" in t or "usa" in t or re.search(r'\bu\.?s\.?a?\b', t) or _US_STATE_RE.search(t):
        return 4
    if "remote" in t:
        return 5
    return None

def is_us(location: str) -> bool:
    return location_rank(location) is not None

# ── Y Combinator (workatastartup.com) — real YC startups, structured JSON ──
def scrape_yc() -> list:
    r = _http_get("yc", "https://www.workatastartup.com/jobs/l/designer", timeout=20)
    if r is None: return []
    jobs = []
    try:
        m = re.search(r'data-page="([^"]+)"', r.text)
        if not m: return []
        data = json.loads(html.unescape(m.group(1)))
        for j in data.get("props", {}).get("jobs", []):
            company = (j.get("companyName") or "Unknown").strip()
            batch   = (j.get("companyBatch") or "").strip()
            jobs.append({
                "title":    (j.get("title") or "").strip(),
                "company":  f"{company} ({batch})" if batch else company,
                "location": (j.get("location") or "See posting").strip(),
                "url":      j.get("applyUrl") or "",
                "salary":   (j.get("salary") or "Not listed").strip(),
                "description": (j.get("companyOneLiner") or "")[:300],
                "posted_at": "Recently", "source": "Y Combinator",
            })
    except Exception as e:
        log.error(f"YC: {e}")
    return jobs

# ── OpenDoors Careers — public Supabase REST API (filtered to SF/Bay/Remote) ──
OPENDOORS_API = "https://jpshpibjgrxvcbnpapyq.supabase.co/rest/v1/jobs"
OPENDOORS_KEY = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impwc2hw"
                 "aWJqZ3J4dmNibnBhcHlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA1NDU3MzEsImV4cCI6MjA4"
                 "NjEyMTczMX0.O-tgJ-mB3guaIhtOOzyHIF-dgqMLGhvliaTWR9W7HAY")
def scrape_opendoors() -> list:
    if is_cooling("opendoors"): return []
    jobs = []
    try:
        r = requests.get(
            OPENDOORS_API,
            params={"select": "title,company_name,city,country,work_type,description,apply_url",
                    "status": "eq.published"},
            headers={"apikey": OPENDOORS_KEY, "Authorization": f"Bearer {OPENDOORS_KEY}",
                     "Accept": "application/json"}, timeout=20)
        if r.status_code == 429: set_cooldown("opendoors", 60); return []
        if r.status_code != 200: return []
        for j in r.json():
            wt   = (j.get("work_type") or "").lower()
            city = (j.get("city") or "").strip()
            ctry = (j.get("country") or "").strip()
            if "remote" in wt:
                loc = f"Remote ({city})" if city else "Remote"
            else:
                loc = ", ".join(p for p in [city, ctry] if p) or "See posting"
            if not is_us(loc):
                continue
            jobs.append({
                "title":    (j.get("title") or "").strip(),
                "company":  (j.get("company_name") or "Unknown").strip(),
                "location": loc,
                "url":      j.get("apply_url") or "",
                "salary":   "Not listed",
                "description": re.sub(r"<[^>]+>", "", j.get("description") or "")[:300],
                "posted_at": "Recently", "source": "OpenDoors",
            })
    except Exception as e:
        log.error(f"OpenDoors: {e}")
    return jobs

# ── Built In SF — design/UX jobs via server-rendered JSON-LD ItemList ──
def scrape_builtinsf() -> list:
    r = _http_get("builtin", "https://www.builtinsf.com/jobs/design-ux", timeout=20)
    if r is None: return []
    jobs = []
    try:
        page = html.unescape(r.text)
        for block in re.findall(r'<script type="application/ld[^"]*json">(.*?)</script>', page, re.S):
            try:
                data = json.loads(block)
            except Exception:
                continue
            graph = data.get("@graph", []) if isinstance(data, dict) else []
            for node in graph:
                if not isinstance(node, dict) or node.get("@type") != "ItemList":
                    continue
                for el in node.get("itemListElement", []):
                    title = (el.get("name") or "").strip()
                    url   = (el.get("url") or "").strip()
                    if not (title and url):
                        continue
                    jobs.append({
                        "title": title, "company": "See posting",
                        "location": "San Francisco Bay Area, CA",
                        "url": url, "salary": "Not listed",
                        "description": (el.get("description") or "")[:300],
                        "posted_at": "Recently", "source": "BuiltIn SF",
                    })
    except Exception as e:
        log.error(f"BuiltIn SF: {e}")
    return jobs

# ── UIUXJobsBoard — design-only board, React-Router turbo-stream payload ──
def _turbo_decode(arr, node, depth=0):
    if depth > 8: return None
    if isinstance(node, dict):
        out = {}
        for k, vi in node.items():
            key = arr[int(k[1:])] if isinstance(k, str) and k.startswith("_") else k
            out[key] = _turbo_decode(arr, arr[vi], depth+1) if isinstance(vi, int) and 0 <= vi < len(arr) else vi
        return out
    if isinstance(node, list):
        return [_turbo_decode(arr, arr[e], depth+1) if isinstance(e, int) and 0 <= e < len(arr) else e for e in node]
    return node

def scrape_uiuxjobsboard() -> list:
    r = _http_get("uiux", "https://uiuxjobsboard.com/design-jobs.data", timeout=20)
    if r is None: return []
    jobs = []
    try:
        arr = json.loads(r.text)
        # Locate the jobs array: a list of int refs whose first item decodes to a job dict.
        refs = None
        for cand in arr:
            if isinstance(cand, list) and cand and all(isinstance(x, int) for x in cand):
                test = _turbo_decode(arr, arr[cand[0]]) if 0 <= cand[0] < len(arr) else None
                if isinstance(test, dict) and "title" in test and "slug" in test:
                    refs = cand; break
        if not refs: return []
        for idx in refs[:40]:
            j = _turbo_decode(arr, arr[idx])
            if not isinstance(j, dict): continue
            comp = j.get("company") or {}
            city = (j.get("city") or "").strip()
            loc  = "Remote" if j.get("remote") else (city or (j.get("country") or "").strip() or "See posting")
            if not is_us(loc): continue
            jobs.append({
                "title":    (j.get("title") or "").strip(),
                "company":  (comp.get("name") if isinstance(comp, dict) else "") or "Unknown",
                "location": loc,
                "url":      f"https://uiuxjobsboard.com/job/{j.get('slug','')}",
                "salary":   (j.get("salary") or "Not listed").strip(),
                "description": "",
                "posted_at": j.get("timeAgo", "Recently"),
                "source": "UIUXJobsBoard",
            })
    except Exception as e:
        log.error(f"UIUXJobsBoard: {e}")
    return jobs

# ── startups.gallery — curated startups; pull live roles from their ATS APIs ──
def _greenhouse_jobs(co: str) -> list:
    out = []
    try:
        r = requests.get(f"https://boards-api.greenhouse.io/v1/boards/{co}/jobs", headers=H, timeout=15)
        if r.status_code != 200: return []
        for j in r.json().get("jobs", []):
            loc = ((j.get("location") or {}).get("name") or "").strip()
            out.append({
                "title":    (j.get("title") or "").strip(),
                "company":  (j.get("company_name") or co).strip(),
                "location": loc or "See posting",
                "url":      j.get("absolute_url") or "",
                "salary":   "Not listed", "description": "",
                "posted_at": "Recently", "source": "Startups.Gallery",
            })
    except Exception as e:
        log.error(f"Greenhouse {co}: {e}")
    return out

def _ashby_jobs(co: str) -> list:
    out = []
    try:
        r = requests.get(f"https://api.ashbyhq.com/posting-api/job-board/{co}", headers=H, timeout=15)
        if r.status_code != 200: return []
        for j in r.json().get("jobs", []):
            loc = "Remote" if j.get("isRemote") else (j.get("location") or "See posting")
            out.append({
                "title":    (j.get("title") or "").strip(),
                "company":  co.replace("-", " ").title(),
                "location": loc,
                "url":      j.get("jobUrl") or j.get("applyUrl") or "",
                "salary":   "Not listed",
                "description": (j.get("descriptionPlain") or "")[:300],
                "posted_at": "Recently", "source": "Startups.Gallery",
            })
    except Exception as e:
        log.error(f"Ashby {co}: {e}")
    return out

def _lever_jobs(co: str) -> list:
    out = []
    try:
        r = requests.get(f"https://api.lever.co/v0/postings/{co}?mode=json", headers=H, timeout=15)
        if r.status_code != 200: return []
        for j in r.json():
            cats = j.get("categories") or {}
            posted = "Recently"
            if j.get("createdAt"):
                try: posted = datetime.fromtimestamp(j["createdAt"] / 1000, TZ).isoformat()
                except Exception: pass
            out.append({
                "title":    (j.get("text") or "").strip(),
                "company":  co.replace("-", " ").title(),
                "location": (cats.get("location") or "See posting").strip(),
                "url":      j.get("hostedUrl") or j.get("applyUrl") or "",
                "salary":   "Not listed",
                "description": re.sub(r"<[^>]+>", "", (j.get("descriptionPlain") or j.get("description") or ""))[:400],
                "posted_at": posted, "source": "Lever",
            })
    except Exception as e:
        log.error(f"Lever {co}: {e}")
    return out

# ── Curated company list (verified ATS slugs) polled directly each cycle.
#    classify() + is_us() + the 0–4yr filter trim the big boards to junior
#    design roles. Extend freely; bad slugs just log a non-200 and yield 0. ──
ATS_COMPANIES = [
    # (slug, platform, display name)
    ("figma", "greenhouse", "Figma"),       ("stripe", "greenhouse", "Stripe"),
    ("airbnb", "greenhouse", "Airbnb"),      ("dropbox", "greenhouse", "Dropbox"),
    ("coinbase", "greenhouse", "Coinbase"),  ("databricks", "greenhouse", "Databricks"),
    ("robinhood", "greenhouse", "Robinhood"),("instacart", "greenhouse", "Instacart"),
    ("reddit", "greenhouse", "Reddit"),      ("discord", "greenhouse", "Discord"),
    ("gitlab", "greenhouse", "GitLab"),      ("brex", "greenhouse", "Brex"),
    ("scaleai", "greenhouse", "Scale AI"),   ("anthropic", "greenhouse", "Anthropic"),
    ("vercel", "greenhouse", "Vercel"),
    ("plaid", "lever", "Plaid"),             ("netflix", "lever", "Netflix"),
    ("ramp", "ashby", "Ramp"),               ("notion", "ashby", "Notion"),
    ("linear", "ashby", "Linear"),           ("openai", "ashby", "OpenAI"),
    ("runway", "ashby", "Runway"),           ("replit", "ashby", "Replit"),
    ("cursor", "ashby", "Cursor"),
]

def scrape_ats() -> list:
    """Poll the curated company boards (Greenhouse / Lever / Ashby) directly."""
    if is_cooling("ats"): return []
    fetchers = {"greenhouse": _greenhouse_jobs, "lever": _lever_jobs, "ashby": _ashby_jobs}
    jobs = []
    for slug, platform, name in ATS_COMPANIES:
        fn = fetchers.get(platform)
        if not fn: continue
        try:
            for j in fn(slug):
                j["company"] = name
                j["source"]  = name           # show the company as the source
                if is_us(j.get("location", "")):
                    jobs.append(j)
        except Exception as e:
            log.error(f"ATS {name}: {e}")
        time.sleep(0.25)
    return jobs

def scrape_startups_gallery() -> list:
    r = _http_get("startupsgallery", "https://startups.gallery/jobs", timeout=20)
    if r is None: return []
    jobs = []
    try:
        gh  = set(re.findall(r'greenhouse\.io/([A-Za-z0-9_.-]+)/jobs/', r.text))
        ash = set(re.findall(r'ashbyhq\.com/([A-Za-z0-9_.-]+)/', r.text))
        for co in list(gh)[:25]:
            jobs.extend(_greenhouse_jobs(co)); time.sleep(0.5)
        for co in list(ash)[:25]:
            jobs.extend(_ashby_jobs(co)); time.sleep(0.5)
        jobs = [j for j in jobs if is_us(j["location"])]
    except Exception as e:
        log.error(f"Startups.Gallery: {e}")
    return jobs

# ── UX Jobs (Substack) — the weekly digest embeds 100s of US design roles
#    with direct apply links (Google/Apple/Amazon/Adobe…). One post → many
#    jobs, so we parse the <li> blocks rather than treat it as a plain feed. ──
SUBSTACK_UXJOBS_URL = "https://uxjobs.substack.com/feed"

def _despace_city(loc: str) -> str:
    # The digest strips spaces inside hashtags ("#SanFrancisco, CA"); restore
    # them so location_rank() can tier SF/Bay roles instead of dumping them in
    # the generic "US" bucket.
    parts = loc.split(",", 1)
    city  = re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', parts[0]).strip()
    return f"{city}, {parts[1].strip()}" if len(parts) > 1 else city

def scrape_substack_uxjobs() -> list:
    r = _http_get("substack_uxjobs", SUBSTACK_UXJOBS_URL, timeout=20)
    if r is None: return []
    jobs = []
    try:
        feed = feedparser.parse(r.content)
        for entry in feed.entries:
            if "UX Jobs" not in (entry.get("title") or ""):
                continue  # only the weekly / mid-week roundups carry the job list
            body = (entry.get("content", [{}])[0].get("value")
                    if entry.get("content") else (entry.get("summary") or ""))
            if not body:
                continue
            for li in re.findall(r"<li>(.*?)</li>", body, re.S):
                sm = re.search(r"<strong>(.*?)</strong>", li, re.S)
                am = re.search(r'href="(https?://[^"]+)"', li)
                if not (sm and am):
                    continue
                url = html.unescape(am.group(1))
                # drop the newsletter's own links, affiliate links, author bylines
                if any(x in url for x in ("substack.com", "uxjobs.io", "amzn.to", "linkedin.com/in/")):
                    continue
                label = html.unescape(re.sub(r"<[^>]+>", "", sm.group(1))).strip()
                if " - " not in label:
                    continue  # not a "Role - Company" job line
                title, company = label.rsplit(" - ", 1)
                locs = re.findall(r"#([A-Za-z .]+,\s*[A-Z]{2})", li)
                loc  = _despace_city(locs[0]) if locs else ("Remote" if "remote" in li.lower() else "United States")
                m   = re.search(r'\$[\d,]+(?:\s*[-–]\s*\$[\d,]+)?', li)
                jobs.append({
                    "title": title.strip(), "company": company.strip(),
                    "location": loc, "url": url,
                    "salary": m.group(0) if m else "See posting",
                    "description": "", "posted_at": "Recently",
                    "source": "UX Jobs (Substack)",
                })
            break  # newest digest only
    except Exception as e:
        log.error(f"Substack UX Jobs: {e}")
    return jobs[:150]

# ── ZipRecruiter — OFFICIAL Job Search API (replaces the scraper we had to
#    disable: the public site 403s bots, and the bot can't reach Claude's
#    ZipRecruiter MCP tool from an autonomous process). DORMANT until a
#    ZIPRECRUITER_API_KEY is set in .env — get one via the publisher program
#    at https://www.ziprecruiter.com/publishers . UNVERIFIED end-to-end
#    (no key on hand to test); written against the documented v1 shape. ──
def scrape_ziprecruiter_api(query: str, location: str) -> list:
    api_key = os.environ.get("ZIPRECRUITER_API_KEY", "").strip()
    if not api_key or is_cooling("ziprecruiter_api"):
        return []
    jobs = []
    try:
        r = requests.get(
            "https://api.ziprecruiter.com/jobs/v1",
            params={"search": query, "location": location, "radius_miles": 25,
                    "days_ago": max(1, CONFIG["HOURS_OLD"] // 24),
                    "jobs_per_page": CONFIG["RESULTS_PER_SEARCH"], "page": 1,
                    "api_key": api_key},
            headers=H, timeout=20)
        if r.status_code == 429:
            set_cooldown("ziprecruiter_api", 60); return []
        if r.status_code != 200:
            log.warning(f"ZipRecruiter API: HTTP {r.status_code}")
            return []
        for j in r.json().get("jobs", []):
            comp = (j.get("hiring_company") or {}).get("name") or "Unknown"
            lo, hi, interval = j.get("salary_min"), j.get("salary_max"), j.get("salary_interval", "year")
            if lo and hi:
                salary = f"${int(lo):,} – ${int(hi):,} / {interval}"
            elif lo:
                salary = f"${int(lo):,}+"
            else:
                salary = "Not listed"
            jobs.append({
                "title":    (j.get("name") or "").strip(),
                "company":  comp.strip(),
                "location": (j.get("location") or "").strip() or location,
                "url":      j.get("url") or "",
                "salary":   salary,
                "description": re.sub(r"<[^>]+>", "", j.get("snippet") or "")[:400],
                "posted_at": j.get("posted_time_friendly", "Recently"),
                "source":   "ZipRecruiter",
            })
    except Exception as e:
        log.error(f"ZipRecruiter API: {e}")
    return jobs

# ═════════════════════════════════════════════════════════════════
#  💰  FUNDING RADAR — fresh raises = design hire incoming
#  Scans VC news + SEC Form D, then for each freshly-funded company
#  checks its Greenhouse/Ashby board for OPEN DESIGN ROLES. Matched
#  roles are injected into the job board; the raise itself is alerted
#  to a separate funding channel and shown in the "Just Raised" tab.
# ═════════════════════════════════════════════════════════════════
# a16z / Sequoia / First Round don't expose a working RSS feed (404 / 403),
# so we follow each via a Google News query instead — this actually surfaces
# the funding rounds they lead, not just their blog posts.
def _gnews(query: str) -> str:
    return ("https://news.google.com/rss/search?q="
            f"{requests.utils.quote(query)}&hl=en-US&gl=US&ceid=US:en")

FUNDING_FEEDS = [
    # ── Core tech/VC press (verified working) ──
    ("TechCrunch Venture",  "https://techcrunch.com/category/venture/feed/"),
    ("TechCrunch Startups", "https://techcrunch.com/category/startups/feed/"),
    ("TechCrunch Funding",  "https://techcrunch.com/tag/funding/feed/"),
    ("VentureBeat",         "https://venturebeat.com/category/business/feed/"),
    ("Crunchbase News",     "https://news.crunchbase.com/feed/"),
    ("StrictlyVC",          "https://strictlyvc.com/feed/"),
    ("GeekWire Funding",    "https://www.geekwire.com/tag/funding/feed/"),
    ("YC Blog",             "https://www.ycombinator.com/blog/rss.xml"),
    ("Fortune",             "https://fortune.com/feed/"),
    ("SiliconANGLE",        "https://siliconangle.com/feed/"),
    ("Axios",               "https://api.axios.com/feed/"),
    # ── Funding-specific sources (added) ──
    ("Tech Funding News",   "https://techfundingnews.com/feed/"),
    ("TechStartups",        "https://techstartups.com/feed/"),
    ("AlleyWatch",          "https://www.alleywatch.com/feed/"),
    ("SaaStr",              "https://www.saastr.com/feed/"),
    ("The SaaS News",       "https://thesaasnews.com/feed"),
    # ── VC firms followed via Google News (no usable native RSS) ──
    ("a16z (news)",         _gnews('"Andreessen Horowitz" (raises OR funding OR "series") when:7d')),
    ("Sequoia (news)",      _gnews('"Sequoia Capital" (raises OR funding OR "series") when:7d')),
    ("First Round (news)",  _gnews('"First Round Capital" (raises OR funding OR "series") when:7d')),
    # ── Broad early-stage funding sweep (catches raises no single outlet covers) ──
    ("Funding Sweep (news)", _gnews('startup ("raises" OR "raised") ("seed" OR "series a" OR "series b") when:2d')),
]

AMOUNT_RE = re.compile(r'\$\s*([\d,.]+)\s*(billion|million|B|M)\b', re.IGNORECASE)
STAGE_RE  = re.compile(r'\b(pre-?seed|seed|series\s+[a-f]|bridge|extension)\b', re.IGNORECASE)
STAGE_PRIORITY = {
    "pre-seed": 10, "preseed": 10, "seed": 9,
    "series a": 8, "series b": 7, "series c": 6,
    "series d": 5, "bridge": 6, "extension": 5,
}
TIER1_VCS = {
    "a16z", "andreessen", "sequoia", "benchmark", "greylock", "accel",
    "kleiner", "lightspeed", "general catalyst", "founders fund",
    "index ventures", "y combinator", "ycombinator", "first round",
    "bessemer", "spark capital", "thrive capital", "khosla", "lux capital", "coatue",
}
FUNDING_SKIP_SECTORS = [
    "biotech", "pharma", "drug", "clinical", "medical device",
    "aerospace", "defense", "military", "mining", "agriculture",
]
FUNDING_WORDS = [
    "raises", "raised", "funding", "investment", "round",
    "backed", "seed", "series", "capital", "million", "billion",
]

# ── Where is the company based? Best-effort from the headline/blurb.
#    Catches "San Francisco-based X raises…" and "Seattle startup Y…",
#    else falls back to scanning a short list of common startup hubs. ──
_FUND_CITIES = [
    "San Francisco", "Bay Area", "Silicon Valley", "Palo Alto", "Mountain View", "San Jose",
    "Oakland", "Menlo Park", "Redwood City", "San Mateo", "Santa Clara", "Sunnyvale",
    "New York", "Manhattan", "Brooklyn", "Boston", "Cambridge", "Seattle", "Bellevue",
    "Los Angeles", "Santa Monica", "San Diego", "Austin", "Dallas", "Houston", "Denver",
    "Boulder", "Chicago", "Miami", "Atlanta", "Washington", "Philadelphia", "Portland",
    "Pittsburgh", "Salt Lake City", "Nashville", "Raleigh", "Detroit", "Minneapolis",
    "London", "Berlin", "Paris", "Amsterdam", "Tel Aviv", "Bangalore", "Bengaluru",
    "Singapore", "Toronto", "Vancouver", "Tokyo", "Sydney", "Dublin", "Stockholm", "Munich",
    "Barcelona", "Madrid", "Zurich", "Bangkok", "São Paulo", "Mexico City", "Waterloo",
]
# "San Francisco-based X", and "X based/headquartered/located in <City>".
_BASED_RE   = re.compile(r'\b([A-Z][A-Za-z.]+(?:\s[A-Z][A-Za-z.]+){0,2})[-–]based\b')
_BASEDIN_RE = re.compile(r'\b(?:based|headquartered|located)\s+in\s+'
                         r'([A-Z][A-Za-z.]+(?:\s[A-Z][A-Za-z.]+){0,2})')

def extract_location(text: str):
    if not text:
        return None
    for rx in (_BASED_RE, _BASEDIN_RE):
        m = rx.search(text)
        if m:
            return m.group(1).strip()
    for city in _FUND_CITIES:
        if re.search(r'\b' + re.escape(city) + r'\b', text, re.IGNORECASE):
            return city
    return None

def extract_funding(text: str) -> dict:
    result = {"amount": None, "stage": None, "investors": None, "priority": 3, "location": None}
    result["location"] = extract_location(text)
    m = AMOUNT_RE.search(text)
    if m:
        num  = float(m.group(1).replace(",", ""))
        unit = m.group(2).lower()
        result["amount"] = f"${num}B" if unit in ("billion", "b") else f"${num}M"
    m = STAGE_RE.search(text)
    if m:
        stage = m.group(0).lower().strip()
        result["stage"]    = stage.title()
        result["priority"] = STAGE_PRIORITY.get(stage, 3)
    inv_m = re.search(r'(?:led by|backed by|investors?[:\s]+)([\w\s,]+?)(?:\.|,\s+\w+\s+said|\n)',
                      text, re.IGNORECASE)
    if inv_m:
        investors = inv_m.group(1).strip().rstrip(",")
        result["investors"] = investors
        if any(t in investors.lower() for t in TIER1_VCS):
            result["priority"] += 3
    return result

# ── Founders — best-effort from the article text. Funding pieces usually name
#    the people ("founded by X and Y", "co-founder and CEO X", "CEO X"). We pull
#    those names so the Just-Raised card can deep-link to their LinkedIn. ──
# NB: keep the NAME pattern case-SENSITIVE (no global re.I — that would let
#     [A-Z] match lowercase and capture junk like "founded by ryan"). Keyword
#     parts use scoped inline (?i:…) so "Founded"/"FOUNDED" still match.
_PNAME = r'[A-Z][a-z]+(?:\s+[A-Z][a-z.\'\-]+){1,2}'      # 2–3 capitalised words
_FOUNDER_BLOCK = re.compile(
    r'(?i:\b(?:co-?found(?:ed|er[s]?)|found(?:ed|er[s]?))\b'
    r'(?:\s+and\s+(?:co-)?(?:ceo|cto|coo|president))?'
    r'(?:\s+(?:by|are|is|:|,))?)\s+'
    r'(' + _PNAME + r'(?:\s*(?:,|(?i:and)|&)\s*' + _PNAME + r')*)')
_CEO_RE     = re.compile(r'(?i:\b(?:ceo|chief executive(?:\s+officer)?))\s+(' + _PNAME + r')')
_NAME_SPLIT = re.compile(r'\s*(?:,|and|&)\s*', re.I)
_NOT_A_PERSON = ("capital", "ventures", "venture", "partners", "fund", "group",
                 "holdings", "labs", "technologies", "inc", "llc")

def extract_founders(text: str, company: str = "") -> list:
    """Return up to 3 founder/CEO names mentioned in the article text."""
    if not text:
        return []
    blocks = [m.group(1) for m in _FOUNDER_BLOCK.finditer(text)]
    m = _CEO_RE.search(text)
    if m:
        blocks.append(m.group(1))
    co = (company or "").lower()
    out, seen = [], set()
    for block in blocks:
        for name in _NAME_SPLIT.split(block):
            name = name.strip(" ,.&")
            low  = name.lower()
            if len(name.split()) not in (2, 3):           continue
            if low in seen or (co and (low == co or low in co or co in low)): continue
            if any(t in low for t in _NOT_A_PERSON):       continue
            seen.add(low); out.append(name)
            if len(out) >= 3:
                return out
    return out

def funding_is_relevant(title: str, description: str) -> bool:
    text = f"{title} {description}".lower()
    if not any(w in text for w in FUNDING_WORDS):
        return False
    if any(s in text for s in FUNDING_SKIP_SECTORS):
        return False
    return True

# Narrow set = "this segment is the funding sentence" (for ':' splits).
_FUNDVERB_RE = re.compile(
    r'\b(raises?|raised|secures?|secured|closes?|closed|lands?|nabs?|bags?|'
    r'snags?|scores?|hauls?|nets?|pulls?|funding|round|backed|invests?|investment)\b', re.I)
# Broad set = "the company name ends here" (where to cut the title).
_CUT_RE = re.compile(
    r'\b(raises?|raised|secures?|secured|closes?|closed|lands?|nabs?|bags?|snags?|'
    r'scores?|hauls?|nets?|pulls?|gets?|gains?|announces?|launch(?:es|ed)?|unveils?|'
    r'debuts?|invests?|seeks?|seeking|locks?|emerges?|is|are|was|were|eyeing|eyes|'
    r'says?|to|valued?|hits?|reaches?|after|with|for|on)\b', re.I)
_SEP_RE = re.compile(r'\s+[-–—|]\s+')   # " - Publisher" / "Company – descriptor"
# "Seattle startup Emphere" / "Oslo-based AI startup Mimir" → the name follows "startup".
_DESCRIPTOR_RE = re.compile(r'\bstartups?\b\s+(.+)$', re.I)

def _clean_company(title: str) -> str:
    """Pull a clean company name out of a headline, incl. Google News titles
    like 'Co raises $X led by VC - Publisher' or 'Lead-in: Co raises $X'."""
    t = (title or "").strip()
    t = _SEP_RE.split(t)[0]                       # drop trailing " - Publisher" / descriptors
    if ":" in t:                                  # "Editorial lead-in: Company raises ..."
        segs = [s.strip() for s in t.split(":") if s.strip()]
        verby = [s for s in segs if _FUNDVERB_RE.search(s)]
        t = verby[0] if verby else segs[-1]
    dm = _DESCRIPTOR_RE.search(t)                 # strip "City/AI startup <Name>" lead-in
    if dm and dm.group(1) and not _CUT_RE.match(dm.group(1)):
        t = dm.group(1)
    m = _CUT_RE.search(t)
    if m:
        t = t[:m.start()]
    t = t.split(",")[0].strip(" –—-:•·[](){}").strip()
    return t or (title or "").split(",")[0].strip()

# A roundup/editorial headline isn't a single company — skip these.
_ROUNDUP_RE = re.compile(
    r'\b(funding wrap|wrap|weekly|this week|week in|roundup|round-up|recap|digest|'
    r'report|rises?|grew|grows|list of|top \d|deals?|acquisitions?|edition|frenzy|'
    r'race|investments?|takes the bulk)\b', re.I)

# Headline lead-ins. "How Paris-based ColibriTD raised…" leaves "How
# Paris-based ColibriTD" behind, which is a sentence, not a company.
_LEADIN_RE = re.compile(
    r'^(how|why|what|when|where|who|this|these|those|the|its|his|her|their|'
    r'tonight|today|former|inside|meet|join|exclusive|after|before|now|new|'
    r'top|best|first|last|more|most|amid|as|is|are|was|were|will|can|could|should)\b', re.I)
# We want the company that RAISED, not the firm that wrote the cheque.
_VCWORD_RE = re.compile(r'\b(capital|ventures?|partners|funds?|equity|holdings|advisors)\b', re.I)
# "Join theCUBE Aug. 31-Sept. 2" — an event listing, not a raise.
_DATEY_RE = re.compile(
    r'\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b\.?\s*\d|'
    r'\b\d{1,2}\s*[-–]\s*\d{1,2}\b', re.I)
_PARTICLES = {"de", "da", "van", "der", "von", "of", "for", "by", "la", "le", "el"}

def _all_capitalised(name: str) -> bool:
    """Every word of a real multi-word company name is capitalised or an
    acronym — 'Ellis AI', 'Deep Cogito'. A stray lowercase verb means we
    caught a sentence instead: 'Nvidia agrees', 'Instinct has'."""
    words = [w.strip("'‘’\"()[]{}.,:;-–—") for w in name.split()]
    words = [w for w in words if w]
    if len(words) < 2:
        return True
    return all(w.lower() in _PARTICLES or w[0].isupper() or w[0].isdigit()
               for w in words[1:])

def _is_company_like(name: str) -> bool:
    """Heuristic: does this look like a real company name vs. a news headline?

    Tuned against the 3267 records the radar had actually stored, where 15%+
    of names were fragments like 'Ribbit Capital looks' or 'CrowdStrike and
    Okta shares jump'. Rejects a third of them; what survives reads clean."""
    n = (name or "").strip(" '‘’\"•·-–—:")
    if not (2 <= len(n) <= 40):           return False
    if re.match(r'^\d', n):               return False   # "30", "3 top VCs"
    if any(c in n for c in "%[]{}"):      return False
    if len(n.split()) > 4:                return False   # names are 1-3 words
    if _ROUNDUP_RE.search(n):             return False
    if _LEADIN_RE.match(n):               return False
    if _VCWORD_RE.search(n):              return False
    if _DATEY_RE.search(n):               return False
    if re.search(r'\band\b', n, re.I):    return False   # two entities, not one
    if n.lower() == n and " " in n:       return False   # all-lowercase multiword ≠ a name
    if not _all_capitalised(n):           return False
    return True

def scrape_funding_rss(name: str, url: str) -> list:
    r = _http_get(name, url)
    if r is None: return []
    items = []
    try:
        feed = feedparser.parse(r.content)
        for entry in feed.entries[:20]:
            title = (entry.get("title") or "").strip()
            link  = (entry.get("link") or "").strip()
            desc  = re.sub(r"<[^>]+>", "", (entry.get("summary") or entry.get("description") or "")).strip()
            if not funding_is_relevant(title, desc):
                continue
            company = _clean_company(title)
            if not _is_company_like(company):     # skip roundups / non-company headlines
                continue
            f = extract_funding(f"{title} {desc}")
            items.append({
                "company":   company,
                "amount":    f["amount"],
                "stage":     f["stage"],
                "investors": f["investors"],
                "location":  f["location"],
                "founders":  extract_founders(f"{title}. {desc}", company),
                "source":    name,
                "url":       link,
                "priority":  f["priority"],
            })
    except Exception as e:
        log.error(f"Funding RSS {name}: {e}")
    return items

def fetch_sec_edgar() -> list:
    items = []
    try:
        today = now_pt().strftime("%Y-%m-%d")
        r = _http_get("sec",
            "https://efts.sec.gov/LATEST/search-index?q=%22Form+D%22"
            f"&dateRange=custom&startdt={today}&enddt={today}&forms=D",
            timeout=20, accept_json=True)
        if r is None: return []
        for hit in r.json().get("hits", {}).get("hits", [])[:20]:
            src     = hit.get("_source", {})
            company = src.get("entity_name", "Unknown")
            raw     = src.get("total_offering_amount", 0)
            if raw and raw < 1_000_000: continue
            amount  = f"${raw/1_000_000:.1f}M" if raw else None
            items.append({
                "company":   company,
                "amount":    amount,
                "stage":     "SEC Form D Filing",
                "investors": "See filing",
                "source":    "SEC EDGAR",
                "url":       "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany"
                             f"&company={requests.utils.quote(company)}&type=D",
                "priority":  3,
            })
    except Exception as e:
        log.error(f"SEC EDGAR: {e}")
    return items

# ── Enrichment: does this freshly-funded company have open design roles? ──
_CO_SUFFIX_RE = re.compile(r'\b(inc|llc|ltd|corp|co|technologies|technology|labs|ai|io|app)\b\.?',
                           re.IGNORECASE)
def _ats_slugs(company: str):
    base = re.sub(r'\([^)]*\)', '', company).strip().lower()      # drop "(YC W24)"
    base = _CO_SUFFIX_RE.sub('', base)
    words = re.sub(r'[^a-z0-9 ]', '', base).split()
    if not words: return []
    cands = ["".join(words), words[0]]
    if len(words) > 1:
        cands.append("-".join(words))
    seen, out = set(), []
    for c in cands:
        if c and c not in seen:
            seen.add(c); out.append(c)
    return out

def find_company_design_roles(company: str) -> list:
    """Best-effort: try the company's Greenhouse/Ashby board for US design roles."""
    found = []
    for slug in _ats_slugs(company)[:3]:        # cap lookups per company
        for fetch in (_greenhouse_jobs, _ashby_jobs, _lever_jobs):
            try:
                for j in fetch(slug):
                    if not j.get("title") or not j.get("url"):
                        continue
                    if not is_us(j.get("location", "")):
                        continue
                    if not classify(j["title"], j.get("company", ""), j.get("description", "")).get("relevant"):
                        continue
                    found.append(j)
            except Exception:
                pass
            time.sleep(0.3)
        if found:
            break
    # de-dupe by url
    uniq, seen = [], set()
    for j in found:
        if j["url"] not in seen:
            seen.add(j["url"]); uniq.append(j)
    return uniq[:6]

def funding_id(company, amount):
    return hashlib.md5(f"{(company or '').lower()}|{amount or ''}".encode()).hexdigest()

def notify_funding(item: dict, roles: list = None, reminder: bool = False):
    company   = item.get("company", "Unknown")
    amount    = item.get("amount") or "Undisclosed"
    stage     = item.get("stage") or "?"
    investors = item.get("investors") or "Undisclosed"
    source    = item.get("source", "")
    url       = item.get("url", "")
    priority  = item.get("priority", 0)
    roles     = roles or []

    tier1 = "⭐ TIER 1 VC  " if priority >= 8  else ""
    hot   = "💥 HOT  "      if priority >= 10 else ""

    roles_block = ""
    if roles:
        lines = "\n".join(f'• <a href="{r["url"]}">{r["title"]}</a> — {r.get("location","")}' for r in roles)
        roles_block = f"\n\n🎯 <b>{len(roles)} open design role(s):</b>\n{lines}"

    if reminder:
        send_funding(
            f"⏰ <b>REMINDER — Reached out yet?</b>\n\n"
            f"💰 <b>{company}</b> raised <b>{amount}</b>\n"
            f"Stage: {stage}  |  Investors: {investors}\n\n"
            f"Fresh raise = design hire incoming. Contact the founder!{roles_block}\n\n"
            f'🔗 <a href="{url}">Read More →</a>'
        )
    else:
        send_funding(
            f"💰 <b>NEW FUNDING ALERT!</b>\n{hot}{tier1}\n\n"
            f"🏢 <b>{company}</b>\n"
            f"💵 <b>Raised:</b> {amount}\n"
            f"📈 <b>Stage:</b> {stage}\n"
            f"👥 <b>Investors:</b> {investors}\n"
            f"📰 <b>Source:</b> {source}{roles_block}\n\n"
            f'🔗 <a href="{url}">Read Full Story →</a>\n\n'
            f"💡 <i>Fresh raise = design hiring mode. Reach out within 48 hrs!</i>"
        )

# Jobs and raises older than this never reach the website. The stores keep
# the full history; the published files stay small so the page loads fast.
MAX_PUBLISH_AGE_DAYS = 30

# The Just Raised column filters to San Francisco / Bay Area, so every other
# raise is downloaded by the browser and never rendered. Publish only what
# the site can show. Set to False to publish every raise again.
PUBLISH_SF_RAISES_ONLY = True
_SF_RE = re.compile(r"san francisco|bay area|palo alto|mountain view|san jose|oakland|"
                    r"menlo park|sunnyvale|berkeley|redwood city|san mateo|santa clara|\bsf\b", re.I)

def _is_sf(rec: dict) -> bool:
    """Mirrors isSF() in docs/app.js — keep the two in step."""
    roles = rec.get("roles") or [{}]
    where = rec.get("location") or (roles[0] or {}).get("location") or ""
    return bool(_SF_RE.search(where))

# Only these reach docs/jobs*.json; anything else is bot-side bookkeeping.
WEB_JOB_FIELDS = ("id", "title", "company", "location", "salary", "url", "source",
                  "is_new_grad", "is_big_tech", "visa", "founders", "posted_at",
                  "priority", "first_seen", "status")

def _web_job(rec: dict) -> dict:
    return {k: rec[k] for k in WEB_JOB_FIELDS if k in rec}

def _fresh_enough(rec: dict) -> bool:
    """True if rec.first_seen is within MAX_PUBLISH_AGE_DAYS (undated = keep)."""
    v = (rec or {}).get("first_seen")
    if not v:
        return True
    try:
        t = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except Exception:
        return True                      # unparseable stamp: keep, don't guess
    # first_seen is written by now_pt(), so compare in the same zone
    now = now_pt()
    if t.tzinfo is None:
        t = t.replace(tzinfo=now.tzinfo)
    return (now - t).days <= MAX_PUBLISH_AGE_DAYS


def publish_funding():
    try:
        store = load_json(CONFIG["FUNDING_STORE_FILE"], {})
        # Re-apply the company-name check on publish, not just on ingest, so
        # tightening it also cleans records the old looser rule let through.
        published = [v for v in store.values()
                     if v.get("status") != "dismissed" and _fresh_enough(v)
                     and _is_company_like(v.get("company", ""))
                     and (not PUBLISH_SF_RAISES_ONLY or _is_sf(v))]
        published.sort(key=lambda f: f.get("first_seen", ""), reverse=True)
        os.makedirs(CONFIG["SITE_DIR"], exist_ok=True)
        save_json(CONFIG["FUNDING_WEB_FILE"], published)
    except Exception as e:
        log.error(f"publish_funding: {e}")

def run_funding_check(job_seen: set, job_store: dict, job_pending: list,
                      jobs_silent: bool) -> int:
    """Scan funding sources, enrich with open design roles, alert + inject.
    Mutates the passed job state in place; returns the count of new raises."""
    if not funding_enabled():
        return 0
    log.info(f"💰 Funding check {now_pt().strftime('%H:%M:%S %Z')}")
    f_seen    = set(load_json(CONFIG["SEEN_FUNDING_FILE"], []))
    f_store   = load_json(CONFIG["FUNDING_STORE_FILE"], {})
    f_pending = load_json(CONFIG["PENDING_FUNDING_FILE"], [])
    f_silent  = not os.path.exists(CONFIG["FUNDING_BACKFILL_FLAG"])

    raises = []
    for name, url in FUNDING_FEEDS:
        raises.extend(scrape_funding_rss(name, url)); time.sleep(0.5)
    raises.extend(fetch_sec_edgar())
    raises.sort(key=lambda x: x.get("priority", 0), reverse=True)

    new_count = 0
    for item in raises:
        company = item.get("company", "")
        amount  = item.get("amount", "")
        if not company:
            continue
        fid = funding_id(company, amount)
        if fid in f_seen:
            continue
        f_seen.add(fid)
        new_count += 1

        roles = find_company_design_roles(company)
        # Inject matched design roles into the job board (they're real openings)
        for r in roles:
            jid = job_id(r["title"], r.get("company", company), r.get("location", ""))
            if jid in job_seen:
                continue
            job_seen.add(jid)
            rank = location_rank(r.get("location", "")) or 4
            flags = classify(r["title"], r.get("company", ""), r.get("description", ""))
            first_seen = (now_pt() - timedelta(hours=CONFIG["NEW_HOURS"] + 1)) if jobs_silent else now_pt()
            job_store[jid] = {
                "id": jid, "title": r["title"], "company": r.get("company", company),
                "location": r.get("location", ""), "salary": r.get("salary", "Not listed"),
                "url": r.get("url", ""), "source": f"💰 {company} (just raised)",
                "is_new_grad": bool(flags.get("is_new_grad")),
                "is_big_tech": bool(flags.get("is_big_tech")),
                "is_funded": True,
                "funding_note": f"{company} raised {amount or 'a round'}",
                "founders": item.get("founders") or [],
                "posted_at": "Recently", "priority": rank,
                "first_seen": first_seen.isoformat(), "status": "active", "applied_at": None,
            }
            if not jobs_silent:
                notify({**r, "is_funded": True}, jid=jid)
                job_pending.append({
                    "job": r,
                    "remind_at": (now_pt() + timedelta(minutes=CONFIG["REMINDER_MINUTES"])).isoformat(),
                })
                time.sleep(1)

        if not f_silent:
            log.info(f"💰 {company} — {amount} [{item.get('source')}] · {len(roles)} role(s)")
            notify_funding(item, roles)
            f_pending.append({
                "item": item,
                "remind_at": (now_pt() + timedelta(minutes=CONFIG["REMINDER_MINUTES"])).isoformat(),
            })
            time.sleep(1)

        f_store[fid] = {
            "id": fid, "company": company, "amount": amount or "Undisclosed",
            "stage": item.get("stage") or "?", "investors": item.get("investors") or "Undisclosed",
            "source": item.get("source", ""), "url": item.get("url", ""),
            "priority": item.get("priority", 0),
            "founders": item.get("founders") or [],
            # company HQ from the headline, else fall back to the first role's location
            "location": item.get("location") or (roles[0].get("location") if roles else None),
            "roles": [{"title": r["title"], "url": r["url"], "location": r.get("location", "")} for r in roles],
            "first_seen": (now_pt() - timedelta(hours=CONFIG["NEW_HOURS"] + 1)).isoformat() if f_silent else now_pt().isoformat(),
            "status": "active",
        }

    # Funding reminders
    still = []
    for p in f_pending:
        due = datetime.fromisoformat(p["remind_at"])
        if due.tzinfo is None: due = due.replace(tzinfo=TZ)
        if now_pt() >= due:
            notify_funding(p["item"], reminder=True)
        else:
            still.append(p)

    save_json(CONFIG["SEEN_FUNDING_FILE"], list(f_seen))
    save_json(CONFIG["PENDING_FUNDING_FILE"], still)
    save_json(CONFIG["FUNDING_STORE_FILE"], f_store)
    publish_funding()
    if f_silent:
        open(CONFIG["FUNDING_BACKFILL_FLAG"], "w").close()
        log.info(f"🔇 Funding backfill: seeded {new_count} raises (no Telegram alerts).")
    else:
        log.info(f"✅ {new_count} new raises." if new_count else "😴 No new funding.")
    return new_count

# ─────────────────────────────────────────────────────────────────
#  🌐  WEBSITE — data only. The page lives in docs/index.html + style.css
#  + app.js (hand-authored, committed once). Python writes ONLY the data
#  file docs/jobs.json — that file is the single link between bot and site.
# ─────────────────────────────────────────────────────────────────
def _owned_paths() -> list:
    """The files THIS runner actually generates — nothing else.

    Staging all of docs/ was the bug that took the laptop half off the air
    for five weeks: it re-committed the cloud runner's funding.json and
    jobs.cloud.json every cycle, so the two runners were never editing
    "different files" the way git_publish assumed, and every pull conflicted.
    It also swept up any hand-edited source sitting in docs/."""
    paths = [CONFIG["WEB_FILE"]]                       # jobs.{local,cloud}.json
    if DO_APIS:
        paths.append(CONFIG["FUNDING_WEB_FILE"])       # funding radar is cloud-side
    if MODE == "local":
        paths.append(CONFIG["LOCAL_HEARTBEAT_FILE"])   # watchdog stamp
    return [p for p in paths if os.path.exists(p)]

def _pull_rebase() -> bool:
    """Rebase onto the remote, and clean up after ourselves if it conflicts.

    The old code ignored this return code. A conflicted rebase left the repo
    half-applied, the push failed, and the next cycle committed on top of the
    broken state — which is how it ended up wedged at 659 of 664 commits."""
    r = subprocess.run(["git", "pull", "--rebase", "--autostash"],
                       capture_output=True, text=True)
    if r.returncode == 0:
        return True
    subprocess.run(["git", "rebase", "--abort"], capture_output=True)
    log.warning(f"pull --rebase failed, aborted cleanly: {(r.stderr or '')[:160]}")
    return False

def git_publish():
    if not os.path.isdir(".git"):
        return  # repo/remote not set up yet — nothing to publish to
    try:
        owned = _owned_paths()
        if not owned:
            return
        subprocess.run(["git", "add", "--"] + owned, capture_output=True)
        # Only commit/push when one of OUR files actually changed
        if subprocess.run(["git", "diff", "--cached", "--quiet", "--"] + owned).returncode != 0:
            subprocess.run(["git", "commit", "-m", "\U0001F4CA Update job dashboard data"], capture_output=True)
            def _push():
                if not _pull_rebase():
                    return None
                return subprocess.run(["git", "push"], capture_output=True, text=True)
            push = _push()
            if push is None or push.returncode != 0:   # racing push landed first → retry once
                push = _push()
            if push is not None and push.returncode == 0:
                log.info("\U0001F4E4 Dashboard published to GitHub")
            else:
                err = (push.stderr[:120] if push is not None else "rebase conflict")
                log.warning(f"git push failed (will retry next cycle): {err}")
    except FileNotFoundError:
        log.warning("git not found \u2014 skipping publish")
    except Exception as e:
        log.error(f"git_publish: {e}")

def publish_site():
    try:
        store = load_store()
        # Website shows undismissed jobs from the last MAX_PUBLISH_AGE_DAYS,
        # newest first. Older postings stay in the store but are not published.
        published = [_web_job(v) for v in store.values()
                     if v.get("status") not in ("dismissed", "closed") and _fresh_enough(v)]
        published.sort(key=lambda j: j.get("first_seen", ""), reverse=True)
        os.makedirs(CONFIG["SITE_DIR"], exist_ok=True)
        save_json(CONFIG["WEB_FILE"], published)
        if CONFIG.get("PUBLISH_TO_GIT"):
            git_publish()
    except Exception as e:
        log.error(f"publish_site: {e}")

# ─────────────────────────────────────────────────────────────────
#  🩺  LAPTOP-HALF WATCHDOG
#  The laptop (MODE=local) scrapes LinkedIn/Indeed/Glassdoor/ZipRecruiter/
#  Google and can only run while the Mac is awake, logged in and online. If
#  the Mac sleeps or drops offline the site silently loses those sources.
#  So the laptop stamps a heartbeat every cycle, and the always-on cloud
#  runner (MODE=cloud, on GitHub Actions) watches it — pinging Telegram once
#  when it goes quiet for > LOCAL_SILENT_ALERT_HOURS, and once when it's back.
# ─────────────────────────────────────────────────────────────────
RESTART_HELP = (
    "🖥 <b>How to bring the laptop half back</b>\n"
    "1. Wake your Mac and make sure it's online.\n"
    "2. Usually that's enough — it restarts itself when you log in.\n\n"
    "If it's still quiet, open <b>Terminal</b> "
    "(Cmd+Space → type “Terminal” → Enter) and paste:\n\n"
    "<b>Check if it's running:</b>\n"
    "<code>launchctl list | grep com.opentabs.jobbot</code>\n"
    "→ a number on the left = alive; a “-” or nothing = not running.\n\n"
    "<b>Restart it:</b>\n"
    "<code>launchctl kickstart -k gui/$(id -u)/com.opentabs.jobbot</code>\n"
    "→ no output means it worked.\n\n"
    "<b>See what it's been doing:</b>\n"
    "<code>tail -20 ~/Library/Logs/opentabs/out.log</code>"
)

def write_local_heartbeat():
    """Laptop half: stamp 'I'm alive' into docs/ so the cloud sees it via git."""
    try:
        save_json(CONFIG["LOCAL_HEARTBEAT_FILE"], {
            "ts":   int(now_pt().timestamp()),
            "iso":  now_pt().strftime("%b %d, %I:%M %p %Z"),
            "host": "laptop",
        })
    except Exception as e:
        log.warning(f"write_local_heartbeat: {e}")

def check_local_health():
    """Cloud half: alert once when the laptop half goes silent past the
    threshold, and once when it recovers. State persists in a committed
    .cloud.json file so we never double-ping across the 15-min cloud runs."""
    try:
        hb    = load_json(CONFIG["LOCAL_HEARTBEAT_FILE"], None)
        st    = load_json(CONFIG["LOCAL_WATCH_STATE"], {"alerted": False})
        limit = CONFIG["LOCAL_SILENT_ALERT_HOURS"] * 3600
        now   = int(now_pt().timestamp())
        # No heartbeat committed yet → the laptop half hasn't published its
        # first stamp. Don't false-alarm before it's ever run.
        if not hb or "ts" not in hb:
            return
        age     = now - int(hb["ts"])
        already = bool(st.get("alerted"))
        if age > limit and not already:
            send_telegram(
                f"⚠️ <b>Your laptop scraper is quiet.</b>\n\n"
                f"The local half — <b>LinkedIn · Indeed · Glassdoor · "
                f"ZipRecruiter · Google</b> — hasn't checked in for "
                f"<b>{age/3600:.1f} hours</b> (last seen {hb.get('iso','?')}).\n\n"
                f"Those job boards are frozen on the site until it's back. "
                f"The cloud half (funding radar + API boards) is still running "
                f"fine, so the site isn't dead — just missing the big boards.\n\n"
                + RESTART_HELP
            )
            save_json(CONFIG["LOCAL_WATCH_STATE"],
                      {"alerted": True, "down_since": int(hb["ts"]), "notified_at": now})
            log.warning(f"⚠️ laptop half silent {age/3600:.1f}h — Telegram alert sent.")
        elif age <= limit and already:
            send_telegram(
                "✅ <b>Your laptop scraper is back.</b>\n\n"
                "The local half just checked in — LinkedIn / Indeed / Glassdoor "
                "/ ZipRecruiter / Google are refreshing again. Nothing to do. 🎉"
            )
            save_json(CONFIG["LOCAL_WATCH_STATE"], {"alerted": False})
            log.info("✅ laptop half recovered — Telegram recovery sent.")
    except Exception as e:
        log.warning(f"check_local_health: {e}")

# ─────────────────────────────────────────────────────────────────
#  ⏳  DEAD-POSTING EXPIRY
#  Nothing ever checked whether a listing was still open, so the board
#  accumulated weeks of filled roles. Link-checking is only trustworthy
#  where a failure actually means "gone":
#    · 404 / 410            — definitive (Workable, Greenhouse, Lever…)
#    · an explicit phrase   — LinkedIn answers 200 but does say
#                             "no longer accepting applications"
#    · 401 / 403 / 429 / 5xx / timeouts — a BLOCK, not a death. Indeed
#      401s every request; treating that as dead would wipe the board.
#  Two consecutive dead readings are required before a job is retired, so
#  one bad night on a flaky host cannot hide live listings.
# ─────────────────────────────────────────────────────────────────
DEAD_PHRASES = (
    "no longer accepting applications",
    "this job is no longer available",
    "this position has been filled",
    "this posting has expired",
    "job posting is closed",
)
# Bot-walled: they answer 401/403 whether the job is alive or dead.
UNCHECKABLE_SOURCES = {"Indeed", "Glassdoor", "ZipRecruiter", "Google"}
EXPIRY_BATCH        = 25      # links probed per cycle
EXPIRY_MIN_AGE_DAYS = 3       # don't bother probing fresh finds
EXPIRY_STRIKES      = 2       # consecutive dead reads before retiring

def check_posting_alive(url: str):
    """True = still open · False = definitely gone · None = can't tell."""
    if not url or url == "#":
        return None
    try:
        r = requests.get(url, headers=H, timeout=12, allow_redirects=True)
    except Exception:
        return None                      # network trouble is not evidence
    if r.status_code in (404, 410):
        return False
    if r.status_code != 200:
        return None                      # 401/403/429/5xx → blocked, not dead
    if any(p in r.text.lower() for p in DEAD_PHRASES):
        return False
    return True

def expire_dead_postings(store: dict) -> int:
    """Probe the least-recently-checked postings and retire the dead ones."""
    now = now_pt()
    cands = []
    for rec in store.values():
        if rec.get("status") != "active":            continue
        if rec.get("source") in UNCHECKABLE_SOURCES: continue
        try:
            if (now - datetime.fromisoformat(rec["first_seen"])).days < EXPIRY_MIN_AGE_DAYS:
                continue
        except Exception:
            continue
        cands.append(rec)
    cands.sort(key=lambda r: r.get("checked_at") or "")   # never-checked first
    closed = 0
    for rec in cands[:EXPIRY_BATCH]:
        alive = check_posting_alive(rec.get("url", ""))
        rec["checked_at"] = now.isoformat()
        if alive is False:
            rec["dead_strikes"] = rec.get("dead_strikes", 0) + 1
            if rec["dead_strikes"] >= EXPIRY_STRIKES:
                rec["status"] = "closed"
                closed += 1
        elif alive is True:
            rec["dead_strikes"] = 0
        time.sleep(0.4)
    if closed:
        log.info(f"⏳ retired {closed} closed posting(s)")
    return closed

# ─────────────────────────────────────────────────────────────────
#  🔄  MAIN CHECK
# ─────────────────────────────────────────────────────────────────
def run_check():
    log.info(f"🔍 Job check {now_pt().strftime('%H:%M:%S %Z')}")
    seen    = load_seen()
    pending = load_pending()
    store   = load_store()
    # Clean the existing board: drop non-US / too-senior jobs and (re)tag priority
    for _jid in list(store.keys()):
        _rec  = store[_jid]
        _rank = location_rank(_rec.get("location", ""))
        if _rank is None or not classify(_rec.get("title", ""), _rec.get("company", "")).get("relevant"):
            del store[_jid]
        else:
            _rec["priority"] = _rank
    expire_dead_postings(store)      # retire listings that have since closed
    new_count = 0
    all_jobs  = []

    batch = []
    # ── Browser-scraped sites (LinkedIn/Indeed/Glassdoor/ZipRecruiter/Google).
    #    Residential-IP only → MODE "local"/"all". ──
    if DO_SCRAPERS:
        # JobSpy — rotate through SEARCH_QUERIES a few per cycle so we don't hit
        # the sites with all queries every run (the main block trigger). Over
        # consecutive cycles the cursor walks the whole list.
        q_off = load_json(CONFIG["QUERY_OFFSET_FILE"], 0)
        n_q   = min(CONFIG["QUERIES_PER_CYCLE"], len(SEARCH_QUERIES))
        batch = [SEARCH_QUERIES[(q_off + i) % len(SEARCH_QUERIES)] for i in range(n_q)]
        save_json(CONFIG["QUERY_OFFSET_FILE"], (q_off + n_q) % len(SEARCH_QUERIES))
        log.info(f"🔎 JobSpy queries this cycle: {', '.join(batch)}")
        for query in batch:
            for loc in LOCATIONS:
                all_jobs.extend(scrape_jobspy(query, loc))
                time.sleep(2)

    # ── API / RSS / ATS sources — datacenter-friendly → MODE "cloud"/"all". ──
    if DO_APIS:
        # RSS design boards
        for name, url in RSS_FEEDS:
            all_jobs.extend(scrape_rss(name, url))
            time.sleep(1)

        # SF / Bay Area + startup sources
        all_jobs.extend(scrape_yc())
        all_jobs.extend(scrape_opendoors())
        all_jobs.extend(scrape_builtinsf())
        all_jobs.extend(scrape_uiuxjobsboard())
        all_jobs.extend(scrape_startups_gallery())
        all_jobs.extend(scrape_substack_uxjobs())
        all_jobs.extend(scrape_ats())          # curated Greenhouse/Lever/Ashby boards
        # ZipRecruiter official API — no-op unless ZIPRECRUITER_API_KEY is set
        for query in (batch or SEARCH_QUERIES[:CONFIG["QUERIES_PER_CYCLE"]]):
            all_jobs.extend(scrape_ziprecruiter_api(query, "United States"))
    log.info(f"📥 Collected {len(all_jobs)} raw postings before filtering.")

    # First ever run = SILENT backfill: seed the board with the current
    # backlog (aged into "Yet to Apply") without blasting Telegram. A flag
    # file marks it done, so every later run alerts new jobs normally.
    silent = not os.path.exists(CONFIG["BACKFILL_FLAG"])

    # Process
    for job in all_jobs:
        if not job.get("title") or not job.get("url"):
            continue
        flags = classify(job.get("title",""), job.get("company",""), job.get("description",""))
        if not flags["relevant"]:
            continue
        job.update(flags)
        if not job.get("visa"):
            job["visa"] = extract_visa(job.get("description", ""))   # best-effort
        rank = location_rank(job.get("location", ""))
        if rank is None:
            continue  # not in the USA — skip
        jid = job_id(job["title"], job.get("company",""), job.get("location",""))
        if jid in seen:
            continue
        seen.add(jid)
        new_count += 1
        # backfilled jobs are aged so they land in "Yet to Apply", not "New"
        first_seen = (now_pt() - timedelta(hours=CONFIG["NEW_HOURS"] + 1)) if silent else now_pt()
        store[jid] = {
            "id":          jid,
            "title":       job["title"],
            "company":     job.get("company", "Unknown"),
            "location":    job.get("location", ""),
            "salary":      job.get("salary", "Not listed"),
            "url":         job.get("url", ""),
            "source":      job.get("source", ""),
            "is_new_grad": bool(job.get("is_new_grad")),
            "is_big_tech": bool(job.get("is_big_tech")),
            "visa":        job.get("visa"),          # "yes" | "no" | None
            "founders":    extract_founders(job.get("description", ""), job.get("company", "")),
            "posted_at":   job.get("posted_at", "Recently"),
            "priority":    rank,
            "first_seen":  first_seen.isoformat(),
            "status":      "active",
            "applied_at":  None,
        }
        if not silent:
            log.info(f"🆕 {job['title']} @ {job.get('company')} [{job.get('source')}]")
            notify(job, jid=jid)
            pending.append({
                "job": job,
                "remind_at": (now_pt() + timedelta(minutes=CONFIG["REMINDER_MINUTES"])).isoformat(),
            })
            time.sleep(1)

    # 💰 Funding radar — fresh raises + the design roles they're hiring for.
    # Mutates seen/store/pending in place (injects matched roles as job cards).
    # RSS/SEC + ATS lookups → datacenter-friendly, so cloud-side only.
    if DO_APIS:
        run_funding_check(seen, store, pending, jobs_silent=silent)

    # Reminders — skip jobs already applied/dismissed from Telegram
    still = []
    for item in pending:
        j    = item["job"]
        rjid = job_id(j["title"], j.get("company", ""), j.get("location", ""))
        if store.get(rjid, {}).get("status") in ("applied", "dismissed"):
            continue
        due = datetime.fromisoformat(item["remind_at"])
        if due.tzinfo is None: due = due.replace(tzinfo=TZ)
        if now_pt() >= due:
            notify(j, reminder=True, jid=rjid)
        else:
            still.append(item)

    save_seen(seen)
    save_pending(still)
    save_store(store)
    # 🩺 Laptop half stamps a fresh heartbeat into docs/ so it rides along in
    #    this cycle's publish push; the cloud runner watches that stamp.
    if DO_SCRAPERS:
        write_local_heartbeat()
    publish_site()
    if MODE == "cloud":
        check_local_health()
    if silent:
        open(CONFIG["BACKFILL_FLAG"], "w").close()
        log.info(f"🔇 Silent backfill: seeded {new_count} jobs to the board (no Telegram alerts).")
    else:
        log.info(f"✅ {new_count} new jobs." if new_count else "😴 No new jobs this cycle.")

# ─────────────────────────────────────────────────────────────────
#  💓  HEARTBEAT + DAILY DIGEST
# ─────────────────────────────────────────────────────────────────
def heartbeat():
    send_telegram(f"💓 Job Bot alive @ {now_pt().strftime('%H:%M %Z')}")

def daily_digest():
    send_telegram(
        f"☀️ <b>Morning Shruty!</b> Job Bot is running 🤖\n\n"
        f"📅 {now_pt().strftime('%A, %B %d, %Y')}\n"
        f"🎯 {len(SEARCH_QUERIES)} search queries active\n"
        f"🌐 LinkedIn · Indeed · Glassdoor · ZipRecruiter\n"
        f"   + Remotive · Dribbble · WeWorkRemotely + more\n"
        f"🏢 {len(BIG_TECH)} big tech companies monitored\n"
        + (f"💰 {len(FUNDING_FEEDS)} funding feeds + SEC Form D → design-role radar\n" if funding_enabled() else "")
        + f"\n<i>🎓 Graduating May 2026 — let's get that offer!</i>"
    )

# ─────────────────────────────────────────────────────────────────
#  🚀  START
# ─────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    log.info("=" * 60)
    log.info(f"  🎨 JOB BOT — Starting [mode={MODE}{' · run-once' if RUN_ONCE else ''}]")
    log.info("=" * 60)

    if DO_SCRAPERS:
        try:
            import jobspy
            log.info("✅ JobSpy ready.")
        except ImportError:
            log.error("❌ Run: pip3 install python-jobspy"); exit(1)

    # One-shot (GitHub Actions cron): run a single cycle and exit. Skip the
    # "I'm LIVE" announcements (they'd fire every 15 min) and the daemon loop.
    if RUN_ONCE:
        run_check()
        log.info("✅ run-once complete — exiting.")
        raise SystemExit(0)

    send_telegram(
        f"🎨 <b>Job Bot is LIVE!</b>\n\n"
        f"⚡ First alert: <b>2 min</b> after posting\n"
        f"⏰ Reminder: <b>7 min</b>\n"
        f"💓 Heartbeat: every hour\n\n"
        f"🌐 Sources: LinkedIn · Indeed · Glassdoor\n"
        f"   ZipRecruiter · Remotive · Dribbble\n"
        f"   WeWorkRemotely · Jobicy + more\n\n"
        f"🎓 <b>New Grad + Mid Level</b> roles\n"
        f"🏠 Remote · Hybrid · On-site Bay Area\n\n"
        + (f'📊 <a href="https://{CONFIG["GITHUB_USER"]}.github.io/{CONFIG["GITHUB_REPO"]}/">Your job dashboard</a>\n'
           f"   Tap ✅/🗑 on alerts to sort jobs\n\n" if CONFIG["GITHUB_USER"] else "") +
        f"<i>Graduating May 2026 — let's get that offer! 🚀</i>"
    )

    if funding_enabled():
        send_funding(
            f"💰 <b>Funding Radar is LIVE!</b>\n\n"
            f"📡 {len(FUNDING_FEEDS)} VC news feeds + SEC Form D\n"
            f"🎯 Each fresh raise → I check the company's careers board "
            f"for open design roles and push them to your job board.\n\n"
            f"<i>Fresh raise = design hire incoming. Reach out within 48 hrs! 🚀</i>"
        )

    run_check()
    schedule.every(CONFIG["POLL_INTERVAL_MINUTES"]).minutes.do(run_check)
    schedule.every(CONFIG["HEARTBEAT_HOURS"]).hours.do(heartbeat)
    schedule.every().day.at(f"{CONFIG['DAILY_DIGEST_HOUR']:02d}:00").do(daily_digest)

    log.info(f"⏱ Polling every {CONFIG['POLL_INTERVAL_MINUTES']} min.")
    while True:
        schedule.run_pending()
        poll_telegram()   # apply any Applied/Dismiss button taps
        time.sleep(30)
