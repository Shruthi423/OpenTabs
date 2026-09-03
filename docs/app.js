/* ════════════════════════════════════════════════════════════════
   OpenTabs — front-end logic (three-column board)
   Columns: Today (≤24h) · Previous (older) · Just Raised (funding).
   Applied and Trash are right-hand panels that collapse and open.
   Filing a job is always the same gesture: the Applied button on the
   card. Sort / card size / theme live in the permanent left rail.
   Data comes from jobs*.json + funding.json (written by opentabs.py).
   ════════════════════════════════════════════════════════════════ */

const NEW_MS = 24 * 3600 * 1000;        // "New" = first seen in the last 24h
let JOBS = [];                          // raw data from jobs*.json
let FUND = [];                          // raw data from funding.json

const state = {
  q: "", source: [], loc: [], date: "",              // source/loc = multi
  mode: localStorage.getItem("mode") || "board",    // board | cognition
  cog: localStorage.getItem("cogCol") || "today",   // which column cognition mode works
  cogI: 0,                                          // cursor into that column's deck
  rank: JSON.parse(localStorage.getItem("rank") || '{"today":false,"prev":false,"raised":false}'),
  theme: localStorage.getItem("theme") || "dark",
  drawer: null,                                     // null | "app" | "trash"
};
/* Labels for the confirm dialog and the empty states. */
const LABELS = { today: "Today", prev: "Previous", raised: "Just Raised", app: "Applied", trash: "Trash" };
/* Rail modes. "board" is this three-column triage surface; "brain" is
   cognition mode — the icon is in the rail but the mode does not exist
   yet, so it is listed here and deliberately not switchable. */
const MODES = ["board", "cognition"];
const COG_COLS = ["today", "prev", "raised"];
const THEMES = ["dark", "paper", "blush", "mint", "cream"];
const PAGE = 40;                        // rows rendered per column up front
const MAX_AGE_MS = 30 * 864e5;          // the site ignores anything older

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => (s || "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ── Applied marks + Trash + dismissed raises + Undo (per-browser) ── */
/* Résumé hand-off state, per job: "sent" = pasted into Claude, "done" =
   the tailored résumé is downloaded. There is no way to see into the Claude
   tab, so "done" is a mark you flip — same contract as Applied. */
function loadResumes() { try { return JSON.parse(localStorage.getItem("resumes") || "{}"); } catch { return {}; } }
function saveResumes() { localStorage.setItem("resumes", JSON.stringify(RESUMES)); }

function loadMarks() { try { return JSON.parse(localStorage.getItem("marks") || "{}"); } catch { return {}; } }
function saveMarks(m) { localStorage.setItem("marks", JSON.stringify(m)); }
let MARKS = loadMarks();                           // { jobId: "done" }
let RESUMES = loadResumes();                       // { jobId: "sent" | "done" }
function isApplied(j) { return MARKS[j.id] === "done" || j.status === "applied"; }

function loadSet(key) { try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch { return new Set(); } }
let TRASH = loadSet("trash");                      // Set<jobId>
function saveTrash() { localStorage.setItem("trash", JSON.stringify([...TRASH])); }
let DISMISSED = loadSet("raisedDismissed");        // Set<fundingId>
function saveDismissed() { localStorage.setItem("raisedDismissed", JSON.stringify([...DISMISSED])); }

/* Major VCs worth naming on the card. Matched against the investors text
   client-side so it also works on records already stored, which never had a
   tier-1 field written. Keep in step with TIER1_VCS in opentabs.py. */
const TIER1_VCS = [
  ["andreessen", "a16z"], ["a16z", "a16z"], ["sequoia", "Sequoia"],
  ["benchmark", "Benchmark"], ["greylock", "Greylock"], ["accel", "Accel"],
  ["kleiner", "Kleiner Perkins"], ["lightspeed", "Lightspeed"],
  ["general catalyst", "General Catalyst"], ["founders fund", "Founders Fund"],
  ["index ventures", "Index"], ["y combinator", "Y Combinator"],
  ["ycombinator", "Y Combinator"], ["first round", "First Round"],
  ["bessemer", "Bessemer"], ["spark capital", "Spark"],
  ["thrive capital", "Thrive"], ["khosla", "Khosla"], ["lux capital", "Lux"],
  ["coatue", "Coatue"], ["tiger global", "Tiger Global"], ["dst global", "DST"],
  ["insight partners", "Insight"], ["greenoaks", "Greenoaks"],
];
function tier1Of(f) {
  const hay = (f.investors || "").toLowerCase();
  const hit = TIER1_VCS.find(([k]) => hay.includes(k));
  return hit ? hit[1] : null;
}

/* Funding records have no stable id field — derive one the same way twice. */
function fundId(f) { return (f.id || (f.company || "") + "|" + (f.url || f.first_seen || "")); }

const UNDO_STACK = [];   // {type:"mark",ids,prev} | {type:"trash"|"restore"|"dismiss",ids}
function pushUndo(e) { UNDO_STACK.push(e); }
function undoLast() {
  const e = UNDO_STACK.pop();
  if (!e) return;
  if (e.type === "mark") {
    e.ids.forEach((id, i) => {
      const prev = e.prev[i];
      if (prev === undefined) delete MARKS[id]; else MARKS[id] = prev;
    });
    saveMarks(MARKS);
  } else if (e.type === "trash")     { e.ids.forEach((id) => TRASH.delete(id)); saveTrash(); }
  else if (e.type === "restore")     { e.ids.forEach((id) => TRASH.add(id));    saveTrash(); }
  else if (e.type === "dismiss")     { e.ids.forEach((id) => DISMISSED.delete(id)); saveDismissed(); }
  render(true);
}
/* Mark / un-mark a set of jobs as applied, recording one undo entry. */
/* MARKS has always been {id: "done"} with no date, so the drawer could only
   ever show one undifferentiated pile. Dates live in a parallel map rather
   than inside the mark: marks already in your browser stay valid, they just
   have no date and fall under "Earlier". */
function loadAppliedAt() { try { return JSON.parse(localStorage.getItem("appliedAt") || "{}"); } catch { return {}; } }
function saveAppliedAt() { localStorage.setItem("appliedAt", JSON.stringify(APPLIED_AT)); }
let APPLIED_AT = loadAppliedAt();            // { jobId: ISO date }

function appliedWhen(j) {
  return APPLIED_AT[j.id] || j.applied_at || "";
}

function setApplied(ids, applied) {
  if (!ids.length) return;
  pushUndo({ type: "mark", ids, prev: ids.map((id) => MARKS[id]) });
  const now = new Date().toISOString();
  ids.forEach((id) => {
    if (applied) { MARKS[id] = "done"; APPLIED_AT[id] = now; }
    else { delete MARKS[id]; delete APPLIED_AT[id]; }
  });
  saveMarks(MARKS); saveAppliedAt();
}

/* ── helpers ──────────────────────────────────────────────────── */
function ago(when) {
  const d = (Date.now() - new Date(when).getTime()) / 1000;
  if (isNaN(d)) return "";
  if (d < 3600)  return Math.max(1, Math.floor(d / 60)) + "m ago";
  if (d < 86400) return Math.floor(d / 3600) + "h ago";
  return Math.floor(d / 86400) + "d ago";
}
// best available timestamp in ms — real posted_at if present, else first_seen
function jobTime(j) {
  if (j.posted_at && j.posted_at !== "Recently") {
    const t = Date.parse(j.posted_at);
    if (!isNaN(t)) return t;
  }
  return new Date(j.first_seen).getTime() || 0;
}
function postedAgo(j) { const t = jobTime(j); return t ? ago(t) : "recently"; }

/* Roughly one posting in five is behind a login (YC, a few boards) and the
   bot gave up fetching its text. Those still hand off fine — you just get
   the title and the link — but you should know that before you click, not
   after Claude writes a résumé off two lines. "jd" is absent while a
   posting is still queued, so only an explicit "no" warns. */
function thinJD(j) {
  return j.jd === "no"
    ? '<span class="badge thin" title="This posting is behind a login, so the bot couldn\'t read it. Résumé will hand over the title and link only — copy the description yourself for a better one.">no description</span>'
    : "";
}
// which location group a job falls in (for the Location filter)
function locGroup(j) {
  const t = (j.location || "").toLowerCase(), p = j.priority || 9;
  if (p === 1 || p === 2) return "sfbay";
  if (/new york|nyc|manhattan|brooklyn/.test(t)) return "ny";
  if (p === 5 || /remote/.test(t)) return "remote";
  return "us";
}
function bucket(j) {                      // which column a job belongs to
  if (isApplied(j)) return "app";
  const age = Date.now() - new Date(j.first_seen).getTime();
  return age <= NEW_MS ? "today" : "prev";
}

/* ── collapse multi-city reposts ───────────────────────────────────
   Companies post one role across many cities — Epic runs the same "User
   Experience Designer" in 25 of them. job_id hashes title+company+location,
   so those never collapse on the scraper side and a fifth of the board ends
   up being a handful of jobs repeated. Group them here into one card that
   carries every member's id, so filing it files all of them. */
const normTitle = (t) => (t || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const normCo    = (c) => (c || "").toLowerCase().replace(/\b(inc|llc|ltd|corp|co)\b\.?/g, "").replace(/[^a-z0-9]/g, "");

/* Placeholder company names ("See posting", blank) are not identities —
   clustering on them would merge unrelated jobs that happen to share a
   title. Those stay individual. */
const NO_CO = new Set(["", "seeposting", "unknown", "confidential", "undisclosed"]);

function groupDupes(list) {
  const by = new Map();
  list.forEach((j) => {
    const co = normCo(j.company);
    const k = NO_CO.has(co) ? "solo|" + j.id : co + "|" + normTitle(j.title);
    (by.get(k) || by.set(k, []).get(k)).push(j);
  });
  return [...by.values()].map((members) => {
    if (members.length === 1) return members[0];
    // Represent the cluster with its best-located copy, newest as tiebreak —
    // if one of the 25 cities is San Francisco, that's the one worth showing.
    const rep = members.slice().sort((a, b) =>
      (a.priority || 9) - (b.priority || 9) || jobTime(b) - jobTime(a))[0];
    const locs = [...new Set(members.map((m) => m.location).filter(Boolean))];
    return { ...rep, _ids: members.map((m) => m.id), _locs: locs, _n: members.length };
  });
}
/* Every id a card stands for — one for a normal job, many for a cluster. */
function idsOf(j) { return j._ids || [j.id]; }

/* ── fit score ─────────────────────────────────────────────────────
   A ranking, not a filter: every card stays on the board and the count is
   identical either way — only the order changes. Weights come from what
   Shruthi actually said matters:
     · SF and the Bay first, everything else after
     · startups preferred, but big tech stays visible (a small plus, never
       a penalty — the point is not to miss those roles)
     · early-career roles up top
     · salary is noise right now, so it scores nothing
   Each contribution carries a label so the card can show its reasoning. */
const STARTUP_SOURCES = ["Startups.Gallery", "OpenDoors", "Y Combinator", "YC",
                         "Greenhouse", "Lever", "Ashby", "UIUXJobsBoard"];

function scoreJob(j) {
  const why = [];
  let n = 0;
  // Location order Shruthi set: SF/Bay, then New York, then Remote, then
  // everywhere else. Scored off locGroup so it matches the Location filter
  // exactly — location_rank has no New York tier of its own.
  const g = locGroup(j);
  if (g === "sfbay")       { n += 50; why.push((j.priority || 9) === 1 ? "SF" : "Bay Area"); }
  else if (g === "ny")     { n += 38; why.push("New York"); }
  else if (g === "remote") { n += 28; why.push("Remote"); }
  else                     { n += 18; }

  if (j.is_new_grad) { n += 25; why.push("New grad"); }
  if (/founding/i.test(j.title || "")) { n += 15; why.push("Founding"); }

  const src = j.source || "";
  if (/just raised/i.test(src))                        { n += 22; why.push("Just raised"); }
  else if (STARTUP_SOURCES.some((x) => src.includes(x))) { n += 18; why.push("Startup board"); }
  if (j.is_big_tech) { n += 5; why.push("Big tech"); }   // visible, never penalised


  // recency, tapering off over a week
  const days = (Date.now() - jobTime(j)) / 864e5;
  if (days <= 7) n += Math.round(20 * (1 - days / 7));
  if (days <= 1) why.push("Fresh");

  return { n, why: why.slice(0, 3) };
}

/* Raises rank on how actionable they are, not how big the round was. */
function scoreRaise(f) {
  const why = [];
  let n = 0;
  const roles = (f.roles || []).length;
  if (roles)               { n += 40 + Math.min(roles, 4) * 5; why.push(`${roles} role${roles > 1 ? "s" : ""}`); }
  if ((f.priority || 0) >= 8) { n += 20; why.push("Tier-1 VC"); }
  if ((f.founders || []).length) { n += 12; why.push("Founder known"); }
  const days = (Date.now() - (new Date(f.first_seen).getTime() || 0)) / 864e5;
  if (days <= 14) n += Math.round(25 * (1 - days / 14));   // reach out inside 2 weeks
  if (days <= 2) why.push("Fresh");
  return { n, why: why.slice(0, 3) };
}

function rankOn(col) { return !!state.rank[col]; }

/* ── filtering + sorting: jobs ────────────────────────────────── */
function visible() {
  let out = JOBS.filter((j) => {
    if (TRASH.has(j.id)) return false;
    if (state.q) {
      const hay = (j.title + " " + j.company).toLowerCase();
      if (!hay.includes(state.q.toLowerCase())) return false;
    }
    if (state.source.length && !state.source.includes(j.source)) return false;
    if (state.loc.length && !state.loc.includes(locGroup(j))) return false;
    if (state.date && Date.now() - jobTime(j) > (+state.date) * 3600 * 1000) return false;
    return true;
  });
  // group AFTER filtering, so a Location filter narrows a cluster to the
  // cities that actually match rather than hiding the whole thing
  out = groupDupes(out);
  out.sort((a, b) => jobTime(b) - jobTime(a));      // always newest first
  return out;
}

/* ── filtering + sorting: funding (Just Raised column) ─────────── */
/* SF / Bay Area test — the Just Raised column is SF-only on purpose. */
function isSF(f) {
  const t = (f.location || (f.roles && f.roles[0] && f.roles[0].location) || "").toLowerCase();
  return /san francisco|bay area|palo alto|mountain view|san jose|oakland|menlo park|sunnyvale|berkeley|redwood city|san mateo|santa clara|\bsf\b/.test(t);
}
function locOf(f) { return f.location || (f.roles && f.roles[0] && f.roles[0].location) || ""; }
function visibleRaises() {
  const out = FUND.filter((f) => {
    if (f.status === "dismissed") return false;
    if (DISMISSED.has(fundId(f))) return false;
    // Mirrors _sf_or_unknown() in opentabs.py: show the raise when it's
    // SF/Bay, or when no location could be read at all.
    if (locOf(f).trim() && !isSF(f)) return false;
    if (state.q) {
      const hay = (f.company + " " + (f.investors || "") + " " + (f.stage || "")).toLowerCase();
      if (!hay.includes(state.q.toLowerCase())) return false;
    }
    if (state.date) {
      const t = new Date(f.first_seen).getTime() || 0;
      if (!t || Date.now() - t > (+state.date) * 3600 * 1000) return false;
    }
    return true;
  });
  out.sort((a, b) => (b.first_seen || "").localeCompare(a.first_seen || ""));  // newest first
  return out;
}

/* ── glyphs ───────────────────────────────────────────────────── */
const LI_SVG = '<svg class="ico-li" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" aria-label="LinkedIn"><path d="M216,24H40A16,16,0,0,0,24,40V216a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V40A16,16,0,0,0,216,24ZM96,176a8,8,0,0,1-16,0V112a8,8,0,0,1,16,0ZM88,96a12,12,0,1,1,12-12A12,12,0,0,1,88,96Zm96,80a8,8,0,0,1-16,0V140a20,20,0,0,0-40,0v36a8,8,0,0,1-16,0V112a8,8,0,0,1,15.79-1.78A36,36,0,0,1,184,140Z"></path></svg>';
const MONEY_SVG = '<svg class="ico-money" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" aria-label="Just raised"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm40-68a28,28,0,0,1-28,28h-4v8a8,8,0,0,1-16,0v-8H104a8,8,0,0,1,0-16h36a12,12,0,0,0,0-24H116a28,28,0,0,1,0-56h4V72a8,8,0,0,1,16,0v8h16a8,8,0,0,1,0,16H116a12,12,0,0,0,0,24h24A28,28,0,0,1,168,148Z"></path></svg>';
const WEB_SVG = '<svg width="12" height="12" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24ZM101.63,168h52.74C149,186.34,140,202.87,128,215.89,116,202.87,107,186.34,101.63,168ZM98,152a145.72,145.72,0,0,1,0-48h60a145.72,145.72,0,0,1,0,48ZM40,128a87.61,87.61,0,0,1,3.33-24H81.79a161.79,161.79,0,0,0,0,48H43.33A87.61,87.61,0,0,1,40,128ZM154.37,88H101.63C107,69.66,116,53.13,128,40.11,140,53.13,149,69.66,154.37,88Zm19.84,16h38.46a88.15,88.15,0,0,1,0,48H174.21a161.79,161.79,0,0,0,0-48Zm32.16-16H170.94a142.39,142.39,0,0,0-20.26-45A88.37,88.37,0,0,1,206.37,88ZM105.32,43A142.39,142.39,0,0,0,85.06,88H49.63A88.37,88.37,0,0,1,105.32,43ZM49.63,168H85.06a142.39,142.39,0,0,0,20.26,45A88.37,88.37,0,0,1,49.63,168Zm101.05,45a142.39,142.39,0,0,0,20.26-45h35.43A88.37,88.37,0,0,1,150.68,213Z"></path></svg>';
const LI_MINI = '<svg width="12" height="12" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M216,24H40A16,16,0,0,0,24,40V216a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V40A16,16,0,0,0,216,24ZM96,176a8,8,0,0,1-16,0V112a8,8,0,0,1,16,0Zm-8-80a12,12,0,1,1,12-12A12,12,0,0,1,88,96Zm96,80a8,8,0,0,1-16,0V140a20,20,0,0,0-40,0v36a8,8,0,0,1-16,0V112a8,8,0,0,1,15.79-1.78A36,36,0,0,1,184,140Z"></path></svg>';
/* Broom — the "sweep this off the board" action on every card */
const CHECK_SVG = '<svg viewBox="0 0 256 256" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z"></path></svg>';
const BROOM_SVG = '<svg width="16" height="16" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M235.5,216.81c-22.56-11-35.5-34.58-35.5-64.8V134.73a15.94,15.94,0,0,0-10.09-14.87L165,110a8,8,0,0,1-4.48-10.34l21.32-53a28,28,0,0,0-16.1-37,28.14,28.14,0,0,0-35.82,16,.61.61,0,0,0,0,.12L108.9,79a8,8,0,0,1-10.37,4.49L73.11,73.14A15.89,15.89,0,0,0,55.74,76.8C34.68,98.45,24,123.75,24,152a111.45,111.45,0,0,0,31.18,77.53A8,8,0,0,0,61,232H232a8,8,0,0,0,3.5-15.19ZM67.14,88l25.41,10.3a24,24,0,0,0,31.23-13.45l21-53c2.56-6.11,9.47-9.27,15.43-7a12,12,0,0,1,6.88,15.92L145.69,93.76a24,24,0,0,0,13.43,31.14L184,134.73V152c0,.33,0,.66,0,1L55.77,101.71A108.84,108.84,0,0,1,67.14,88Zm48,128a87.53,87.53,0,0,1-24.34-42,8,8,0,0,0-15.49,4,105.16,105.16,0,0,0,18.36,38H64.44A95.54,95.54,0,0,1,40,152a85.9,85.9,0,0,1,7.73-36.29l137.8,55.12c3,18,10.56,33.48,21.89,45.16Z"></path></svg>';

/* Outreach deep-links — free layer (no scraping, no API keys). */
const coDomain = (co) => (co || "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]/g, "");
const coSlug   = (co) => (co || "").toLowerCase().replace(/\([^)]*\)/g, " ")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const outreachUrls = {
  site: (co) => coDomain(co) ? "https://" + coDomain(co) + ".com" : "#",
  company: (co) => coSlug(co) ? "https://www.linkedin.com/company/" + coSlug(co) : "#",
  founder: (nm, co) => "https://www.google.com/search?q=" +
    encodeURIComponent('site:linkedin.com/in "' + (nm || "") + '" ' + (co || "")),
};

function sourceLabel(src) {
  src = src || "";
  if (/just raised/i.test(src)) return MONEY_SVG + '<span>' + esc(src.replace(/^\s*💰\s*/, "")) + '</span>';
  if (/linkedin/i.test(src)) return LI_SVG + '<span>LinkedIn</span>';
  return esc(src);
}

function setNum(el, val) { if (el) el.textContent = val; }
/* One shared flyout label for the icon-only rail. Fixed-position so it
   escapes the rail's own scroll box, which would otherwise clip it. */
let TIP = null, tipT = 0, tipHold = false;
function railTip() {
  if (!TIP) { TIP = document.createElement("div"); TIP.className = "rail-tip"; document.body.appendChild(TIP); }
  return TIP;
}
/* A detached element reports a 0,0 rect, which pins the tip to the corner —
   fall back to the rail button so the message still lands somewhere sane. */
function tipAnchor(el) {
  return el && el.isConnected ? el : ($("#projBtn") || $(".rail"));
}
function showTip(el, msg) {
  el = tipAnchor(el);
  if (!el) return;
  const t = railTip(), r = el.getBoundingClientRect();
  t.textContent = msg || el.dataset.tip || "";
  t.classList.add("on");                       // measurable before placing it
  // Prefer the right, flip left when the element is near the right edge.
  const w = t.offsetWidth, right = r.right + 10;
  t.style.left = (right + w > window.innerWidth - 12 ? Math.max(12, r.left - w - 10) : right) + "px";
  t.style.top = Math.min(Math.max(12, r.top + r.height / 2), window.innerHeight - 12) + "px";
}
function hideTip() { if (TIP && !tipHold) TIP.classList.remove("on"); }
/* Briefly pin a different label to a rail button, then release it. */
function flashTip(el, msg) {
  tipHold = true;
  showTip(el, msg);
  clearTimeout(tipT);
  tipT = setTimeout(() => { tipHold = false; hideTip(); }, 1400);
}
/* Entrance animation is CSS now: the class is set for one frame's worth of
   renders and only the first rows in each column animate, so a filter
   keystroke never repaints thousands of cards. */
function reveal() {
  $$(".rows").forEach((r) => {
    r.classList.remove("anim");
    void r.offsetWidth;                 // restart the animation
    r.classList.add("anim");
  });
}

/* ── card markup ──────────────────────────────────────────────── */
/* mode: today | prev (board) · app | trash (right panels) */
/* ────────────────────────────────────────────────────────────────
   📄  RÉSUMÉ HAND-OFF
   One click puts the full job description on the clipboard and opens
   the Claude project that already knows how to write the résumé, so
   the loop is click → ⌘V → enter instead of open-posting, select-all,
   copy, switch tab, new chat, paste.

   Deliberately NOT automated end-to-end: the project's preloaded
   instructions are what make the résumé good, and there is no API
   that can start a chat inside one. Anything that generated résumés
   on the side would be a second set of instructions drifting away
   from the ones actually being tuned.
   ──────────────────────────────────────────────────────────────── */

/* Descriptions are one write-once file per posting, published under the
   directory of the runner that found it — see publish_jds() in
   opentabs.py. Fetching 4KB on click beats loading a megabyte on boot. */
const JD_DIRS = { local: "./jd/local/", cloud: "./jd/cloud/", all: "./jd/all/" };
const JD_CACHE = new Map();                    // id → Promise<string>

function jdText(job) {
  if (JD_CACHE.has(job.id)) return JD_CACHE.get(job.id);
  const dirs = [JD_DIRS[job._src] || JD_DIRS.all, JD_DIRS.all];
  const p = (async () => {
    for (const d of [...new Set(dirs)]) {
      try {
        const r = await fetch(d + encodeURIComponent(job.id) + ".txt", { cache: "force-cache" });
        if (r.ok) return (await r.text()).trim();
      } catch { /* try the next directory */ }
    }
    return "";                                 // login-walled posting: link only
  })();
  JD_CACHE.set(job.id, p);
  return p;
}

/* Neither Claude nor ChatGPT has a public way to open a *new chat inside a
   project* by URL. What works is the project's own page: it carries a
   composer, so landing there and pasting starts a fresh chat in the project
   — which is exactly the loop we want. Link to a single conversation
   instead and every job would pile into that one chat, so warnProject()
   calls that out rather than letting it fail quietly. */
function projectUrl() { return localStorage.getItem("projectUrl") || ""; }
/* Résumé tailoring and a 300-character intro are different instruction sets
   and one project doing both does neither well — but that's a preference,
   not a requirement, so an empty outreach link just reuses the other. */
function outreachProjectUrl() { return localStorage.getItem("outreachUrl") || projectUrl(); }
function projectName(u) {
  return /claude\.ai/i.test(u) ? "Claude"
    : /chatgpt\.com|openai\.com/i.test(u) ? "ChatGPT"
    : "your project";
}

const CHAT_URL = /(claude\.ai\/chat\/|chatgpt\.com\/c\/|chat\.openai\.com\/c\/)/i;
function warnProject(u) {
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) return "That doesn't look like a link — it should start with https://";
  if (CHAT_URL.test(u)) return "That's a link to one conversation, not a project. Every job would land in the same chat.";
  return "";
}

/* What lands on the clipboard: enough for the project's instructions to
   work with, and nothing that pretends to be a prompt — the prompt already
   lives in the project. */
function resumeBlock(job, jd) {
  const head = [
    job.title,
    [job.company, job.location, job.salary].filter((v) => v && v !== "Unknown" && v !== "Not listed").join(" · "),
    job.url,
  ].filter(Boolean).join("\n");
  return jd ? head + "\n\n" + jd + "\n" : head + "\n";
}

async function handoff(job, btn) {
  const url = projectUrl();
  // Deferred by a tick: this same click is still bubbling toward the
  // outside-click handler, which would shut the panel as it opened.
  if (!url) { setTimeout(() => openProjPanel(job), 0); return; }
  let jd = "";
  try { jd = await jdText(job); } catch { /* link-only is still useful */ }
  const text = resumeBlock(job, jd);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    flashTip(tipAnchor(btn), "Clipboard blocked — allow it in Safari/Chrome settings");
    return;
  }
  window.open(url, "_blank", "noopener");
  flashTip(tipAnchor(btn), jd
    ? `Job description copied — paste it in ${projectName(url)}`
    : "No description found — title + link copied");
  RESUMES[job.id] = RESUMES[job.id] === "done" ? "done" : "sent";
  saveResumes();
}

/* ── the project-link panel ──
   Opened from the rail, or automatically by the first Résumé click. In that
   second case the job rides along so the click finishes itself on Save
   instead of making you hunt for the button again. */
let projPending = null;                        // job waiting on a link
let projPendingKind = "";                      // "resume" | "outreach"

function openProjPanel(job, forOutreach) {
  projPending = job || null;
  projPendingKind = job ? (forOutreach ? "outreach" : "resume") : "";
  const el = $("#projPick"), btn = $("#projBtn"), inp = $("#projInput"), out = $("#outInput");
  const r = btn.getBoundingClientRect();
  el.hidden = false;
  el.style.left = (r.right + 10) + "px";
  el.style.top = Math.min(r.top, window.innerHeight - el.offsetHeight - 12) + "px";
  btn.setAttribute("aria-expanded", "true");
  inp.value = projectUrl();
  out.value = localStorage.getItem("outreachUrl") || "";
  inp.classList.remove("bad"); out.classList.remove("bad");
  const hint = $("#projHint");
  hint.classList.remove("warn");
  hint.textContent = projPending
    ? "Paste your project link and we'll pick up where you left off."
    : "Open your Claude or ChatGPT project, copy the address bar, paste it here.";
  // Land the cursor on the field the click was actually blocked on.
  const first = projPendingKind === "outreach" && !localStorage.getItem("outreachUrl") ? out : inp;
  first.focus(); first.select();
}

function closeProjPanel() {
  $("#projPick").hidden = true;
  $("#projBtn").setAttribute("aria-expanded", "false");
  projPending = null;
  projPendingKind = "";
}

function saveProject() {
  const inp = $("#projInput"), out = $("#outInput"), hint = $("#projHint");
  const u = inp.value.trim(), o = out.value.trim();
  if (!u && !o) return clearProject();
  // A malformed link can't work, so it's refused; a chat link *can* work,
  // it just isn't what you want — say so once, and save it if you insist.
  for (const [el, v] of [[inp, u], [out, o]]) {
    const warn = warnProject(v);
    if (warn && !el.classList.contains("bad")) {
      el.classList.add("bad");
      hint.classList.add("warn");
      hint.textContent = warn + " Press Save again to use it anyway.";
      el.focus();
      return;
    }
  }
  if (u) localStorage.setItem("projectUrl", u); else localStorage.removeItem("projectUrl");
  if (o) localStorage.setItem("outreachUrl", o); else localStorage.removeItem("outreachUrl");
  const job = projPending, kind = projPendingKind;
  closeProjPanel();
  if (!job) return;
  if (kind === "outreach") stepOutreach(job, null);
  else handoff(job).then(() => render(false));
}

function clearProject() {
  localStorage.removeItem("projectUrl");
  localStorage.removeItem("outreachUrl");
  closeProjPanel();
}

/* ────────────────────────────────────────────────────────────────
   🤝  LINKEDIN OUTREACH
   Same hand-off shape as the résumé button — copy, open, come back
   and mark — but stretched over days, because a connection request
   has to be accepted before the follow-up makes sense.

   Nothing here sends anything. LinkedIn's terms forbid automated
   activity and an account restriction would cost far more than the
   clicks save, so every message is one you paste and send yourself.

   State is keyed by company, not by job: two open roles at the same
   place are one conversation, and reaching out twice is worse than
   not reaching out at all.
   ──────────────────────────────────────────────────────────────── */
function coKey(co) { return coSlug(co) || (co || "").trim().toLowerCase(); }
function loadOutreach() { try { return JSON.parse(localStorage.getItem("outreach") || "{}"); } catch { return {}; } }
function saveOutreach() { localStorage.setItem("outreach", JSON.stringify(OUTREACH)); }
let OUTREACH = loadOutreach();     // { coKey: { stage, at, company } }

const OUT_STAGES = ["drafted", "requested", "accepted", "followed"];
function outOf(j) { return OUTREACH[coKey(j.company)] || null; }
function daysSince(iso) {
  const t = new Date(iso).getTime();
  return t ? Math.floor((Date.now() - t) / 86400000) : 0;
}

/* The company's People tab, already filtered — the "search the company,
   scroll for someone relevant" step, collapsed into one click. Falls back
   to a plain people search when the slug guess is too thin to trust. */
const OUT_ROLES = "design";
function peopleUrl(co) {
  const slug = coSlug(co);
  return slug && slug.length > 2
    ? `https://www.linkedin.com/company/${slug}/people/?keywords=${encodeURIComponent(OUT_ROLES)}`
    : "https://www.linkedin.com/search/results/people/?keywords=" +
      encodeURIComponent(`${co || ""} ${OUT_ROLES}`.trim());
}

/* Connection notes cap at 300 characters and LinkedIn truncates silently,
   so the ask carries its own limit rather than trusting it to be
   remembered in the project instructions. */
function outreachBlock(job, jd, followUp) {
  const head = [
    followUp
      ? "Follow-up message — they accepted my connection request."
      : "LinkedIn connection request — 300 characters maximum.",
    "",
    job.title,
    [job.company, job.location].filter((v) => v && v !== "Unknown").join(" · "),
    job.url,
  ].filter((v) => v !== undefined).join("\n");
  return jd ? head + "\n\n" + jd + "\n" : head + "\n";
}

async function outreachHandoff(job, btn, followUp) {
  const url = outreachProjectUrl();
  if (!url) { setTimeout(() => openProjPanel(job, true), 0); return false; }
  let jd = "";
  try { jd = await jdText(job); } catch { /* the role and link are enough */ }
  try {
    await navigator.clipboard.writeText(outreachBlock(job, jd, followUp));
  } catch {
    flashTip(tipAnchor(btn), "Clipboard blocked — allow it in Safari/Chrome settings");
    return false;
  }
  window.open(url, "_blank", "noopener");
  flashTip(tipAnchor(btn), followUp
    ? `Follow-up brief copied — paste it in ${projectName(url)}`
    : `Connection note brief copied — paste it in ${projectName(url)}`);
  return true;
}

/* One button walking the whole arc. Every step except the two that draft
   a message is you telling the board what happened on LinkedIn — the same
   contract as Applied, for the same reason: nothing here can see your
   inbox. */

/* Advance one step. The two drafting steps also copy-and-open; the rest
   just record what you did. */
function stepOutreach(job, btn) {
  const k = coKey(job.company), st = OUTREACH[k];
  // Step one just opens LinkedIn. It records "looking" so the button knows
  // to offer the note next, but the drawer ignores that stage — opening a
  // search is not a commitment and shouldn't show up as a pending thread.
  if (!st) {
    OUTREACH[k] = { stage: "looking", at: new Date().toISOString(), company: job.company };
    saveOutreach();
    window.open(peopleUrl(job.company), "_blank", "noopener");
    render(false);
    return;
  }
  // The drafting steps only advance once the note is really on the
  // clipboard — a click that stopped to ask for a project link must not
  // leave the card claiming a request was drafted.
  if (st.stage === "looking") {
    outreachHandoff(job, btn, false).then((ok) => {
      if (!ok) return;
      st.stage = "drafted"; st.at = new Date().toISOString();
      saveOutreach(); render(false);
    });
    return;
  }
  if (st.stage === "drafted")   { st.stage = "requested"; st.at = new Date().toISOString(); }
  else if (st.stage === "requested") { st.stage = "accepted"; st.at = new Date().toISOString(); }
  else if (st.stage === "accepted")  {
    outreachHandoff(job, btn, true).then((ok) => {
      if (!ok) return;
      st.stage = "followed"; st.at = new Date().toISOString();
      saveOutreach(); render(false);
    });
    return;
  }
  else { outreachHandoff(job, btn, true); return; }       // already done: draft again
  saveOutreach();
  render(false);
}

/* The drawer is the whole point of tracking any of this: a connection
   request you sent nine days ago is invisible on a job board sorted by
   posting date, and that's exactly the one you'd forget. Grouped by what
   you'd do next, oldest first inside each group. */
const OUT_GROUPS = [
  { key: "accepted",  title: "Ready to follow up", note: "They accepted — send your message." },
  { key: "requested", title: "Waiting on",         note: "Request sent. Click a card when they accept." },
  { key: "drafted",   title: "Drafted, not sent",  note: "Note written but the request hasn't gone out." },
  // Browsing a company's people isn't a commitment, so it doesn't count
  // toward the tab — but it has to be listed, because the card is now
  // showing "Note" and the ✕ here is the only way back to "People".
  { key: "looking",   title: "Just looking",       note: "Opened a people search. No note drafted yet." },
  { key: "followed",  title: "Done",               note: "" },
];
/* Anything needing a move from you — the number on the tab. "Done" and
   drafts you haven't sent aren't chores, so they don't nag. */
function outreachDue() {
  return Object.values(OUTREACH).filter((r) => r.stage === "accepted" || r.stage === "requested").length;
}
const OUT_TRACKED = OUT_GROUPS.map((g) => g.key);
function outreachRows() {
  const byCo = new Map();
  JOBS.forEach((j) => { const k = coKey(j.company); if (!byCo.has(k)) byCo.set(k, j); });
  return Object.entries(OUTREACH)
    .filter(([, r]) => OUT_TRACKED.includes(r.stage))
    .map(([k, r]) => ({ k, ...r, job: byCo.get(k) || null }));
}
function renderOutreach() {
  const rows = outreachRows();
  const host = $("#rows-out");
  if (!rows.length) {
    host.innerHTML = '<div class="col-empty">No outreach yet. Hit <b>People</b> on a job card to start one.</div>';
    return;
  }
  host.innerHTML = OUT_GROUPS.map((g) => {
    const list = rows.filter((r) => r.stage === g.key)
                     .sort((a, b) => (a.at || "").localeCompare(b.at || ""));
    if (!list.length) return "";
    return `<div class="out-group">
        <div class="out-head">${esc(g.title)}<em>${list.length}</em></div>
        ${g.note ? `<div class="out-note">${esc(g.note)}</div>` : ""}
        ${list.map((r) => {
          const d = daysSince(r.at);
          const when = d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
          const stale = r.stage === "requested" && d >= 7;
          return `<div class="out-row${g.key === "accepted" ? " due" : ""}${stale ? " stale" : ""}"${r.job ? ` data-out-id="${esc(r.job.id)}"` : ""}>
              <span class="out-co">${esc(r.company || r.k)}</span>
              <span class="out-when">${esc(when)}</span>
              <button class="out-reset" data-out-reset="${esc(r.k)}" title="Forget this thread" aria-label="Forget this thread">✕</button>
              ${r.job ? `<span class="out-role">${esc(r.job.title)}</span>` : '<span class="out-role gone">posting has aged off the board</span>'}
            </div>`;
        }).join("")}
      </div>`;
  }).join("");
}

/* Three states, one button. Primary → in progress → highlighted, which is
   as close to "it knows the résumé is ready" as a static site can honestly
   get: the middle click is you telling it. */
/* Middle state is the only one that doesn't re-open the project: it's you
   confirming the résumé came back, which is what turns the button on. */
function stepResume(job, btn) {
  if (RESUMES[job.id] === "sent") { RESUMES[job.id] = "done"; saveResumes(); render(false); return; }
  handoff(job, btn).then(() => render(false));
}

/* ── Verbs ──
   Buttons were the problem. A globe, a broom and a checkmark are mute, and
   a pill labelled "Downloaded?" is a checkbox in costume. Words are the
   clearest affordance there is, so the card stops drawing controls and
   writes a line instead. State lives in the tense: "tailor résumé" becomes
   "résumé tailored" once it is. */
const RESUME_VERB = {
  undefined: { label: "tailor résumé", hint: "Copy the job description and open your project" },
  sent:      { label: "saved it?",     hint: "Mark the tailored résumé as saved" },
  done:      { label: "résumé tailored", done: true, hint: "Done — click to hand it over again" },
};
function outreachVerb(j) {
  const st = outOf(j);
  if (!j.company || j.company === "Unknown") return null;   // nothing to search
  if (!st) return { label: "find people", hint: `Designers and design hiring at ${j.company}` };
  if (st.stage === "looking")   return { label: "write a note", hint: "Draft a connection note" };
  if (st.stage === "drafted")   return { label: "request sent?", hint: "Mark the connection request as sent" };
  if (st.stage === "requested") { const d = daysSince(st.at);
    return { label: `accepted?${d ? " · " + d + "d" : ""}`, hint: `Asked ${d || 0} days ago — click when they accept` }; }
  if (st.stage === "accepted")  return { label: "follow up", live: true, hint: "Draft your follow-up message" };
  return { label: "followed up", done: true, hint: "Done — click to draft another" };
}
function verb(act, v) {
  if (!v) return "";
  return `<button class="verb${v.done ? " is-done" : ""}${v.live ? " is-live" : ""}${v.quiet ? " quiet" : ""}" ` +
         `data-act="${act}" title="${esc(v.hint)}">${esc(v.label)}</button>`;
}

/* A posting ages out. Full ink for three days, then it thins toward a floor
   so a three-week-old listing reads as the near-miss it is — urgency you can
   see down the column instead of a date you have to stop and read. Only the
   posting fades; your own verbs stay live. */
function decayOf(j) {
  const t = jobTime(j);
  if (!t) return 1;
  const days = (Date.now() - t) / 86400000;
  return Math.max(0.5, 1 - Math.min(1, Math.max(0, days - 3) / 25) * 0.5);
}

function jobHTML(j, n, mode) {
  const idx = String(n).padStart(2, "0");
  const badges =
    (j.is_new_grad ? '<span class="badge">New Grad</span>' : "") +
    (j.is_big_tech ? '<span class="badge">Big Tech</span>' : "")
    + thinJD(j);
  // The nouns carry the links: the company name goes to its site, the title
  // to the posting. Nothing is added to the card to make that possible.
  const site = outreachUrls.site(j.company);
  const co = site !== "#"
    ? `<a class="co" href="${esc(site)}" target="_blank" rel="noopener" title="${esc(j.company)} website">${esc(j.company)}</a>`
    : `<span class="co">${esc(j.company)}</span>`;
  const line = [
    esc(j.location || "—") + (j._n ? ` <span class="dupe" title="${esc(j._locs.slice(0, 12).join(" · "))}">+${j._n - 1} more</span>` : ""),
    esc(j.salary && j.salary !== "Not listed" ? j.salary : ""),
    "posted " + esc(postedAgo(j)),
  ].filter(Boolean).join('<span class="sep">·</span>');

  const verbs = mode === "trash"
    ? verb("restore", { label: "put it back" })
    : [ verb("resume", RESUME_VERB[RESUMES[j.id]] || RESUME_VERB.undefined),
        verb("reach", outreachVerb(j)),
        mode === "app"
          ? verb("unapply", { label: "not applied after all", quiet: true, hint: "Move back to the board" })
          : verb("apply", { label: "mark applied", hint: "File this to Applied" }),
      ].filter(Boolean).join('<span class="vsep">·</span>')
      + `<span class="verbs-tail">${verb("delete", { label: "not for me", quiet: true, hint: "Move to Trash" })}</span>`;

  return `<div class="job" data-id="${esc(j.id)}"${j._ids ? ` data-ids="${esc(j._ids.join(" "))}"` : ""} data-url="${esc(j.url || "#")}" data-title="${esc(j.title)}" data-flip-id="${esc(j.id)}" style="--age:${decayOf(j).toFixed(3)}">
      <div class="job-top">
        <span class="idx">${idx}</span>
        ${co}
        <span class="src">${sourceLabel(j.source)}</span>
      </div>
      <a class="job-title" href="${esc(j.url || "#")}" target="_blank" rel="noopener">${esc(j.title)}</a>
      <div class="job-meta">${line}</div>
      ${badges ? `<div class="badges">${badges}</div>` : ""}
      ${j._why && j._why.length ? `<div class="score-trace">${j._why.map((w) => `<b>${esc(w)}</b>`).join("")}</div>` : ""}
      <div class="verbs">${verbs}</div>
    </div>`;
}

/* A funding record, built on exactly the same skeleton as a job card:
   index + company + source on top, one headline line, one meta line, the
   outreach chips, then badges left / action right in the foot. Only the
   content differs, so the three columns line up and read the same way. */
/* the funding extractor writes "?" / "-" for fields it could not read */
function val(v) {
  const t = (v || "").trim();
  return /^(\?|-|—|n\/a|unknown|undisclosed\?)$/i.test(t) ? "" : t;
}
function raiseHTML(f, n) {
  const idx   = String(n).padStart(2, "0");
  const loc   = locOf(f);
  const roles = f.roles || [];
  const vc = tier1Of(f);
  const badges =
    (vc ? `<span class="badge vc">${esc(vc)}</span>` : "") +
    (roles.length ? `<span class="badge">${roles.length} design role${roles.length > 1 ? "s" : ""}</span>` : "");
  // headline = what happened, the way a job card's headline is the role
  const amt = val(f.amount), stage = val(f.stage);
  const headline = amt ? esc(amt) + (stage ? " · " + esc(stage) : "")
                       : (stage ? esc(stage) : "Undisclosed round");
  const rolesLine = roles.length
    ? `<div class="roles">` + roles.slice(0, 2).map((r) =>
        `<a class="role" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>`).join('<span class="sep">·</span>') +
      (roles.length > 2 ? `<span class="more-roles">+${roles.length - 2}</span>` : "") + `</div>`
    : '<div class="roles none">No design roles posted yet — DM the founder.</div>';
  const trace = f._why && f._why.length ? `<div class="score-trace">${f._why.map((w) => `<b>${esc(w)}</b>`).join("")}</div>` : "";
  return `<div class="job raise" data-id="${esc(fundId(f))}">
      <div class="job-top">
        <span class="idx">${idx}</span>
        <a class="co" href="${esc(outreachUrls.site(f.company))}" target="_blank" rel="noopener" title="${esc(f.company)} website">${esc(f.company)}</a>
        <span class="src">${esc(f.source || "")}</span>
      </div>
      <div class="job-title">${headline}</div>
      <div class="job-meta">
        ${esc(val(loc) || "Location unknown")}<span class="sep">/</span>${esc(val(f.investors) || "—")}<span class="sep">/</span>Raised ${ago(f.first_seen)}
      </div>
      ${rolesLine}${trace}
      ${badges ? `<div class="badges">${badges}</div>` : ""}
      <div class="verbs">
        ${f.url ? `<a class="verb" href="${esc(f.url)}" target="_blank" rel="noopener">read the article</a><span class="vsep">·</span>` : ""}
        ${verb("reach", { label: "find people", hint: `Designers and design hiring at ${f.company}` })}
        <span class="verbs-tail">${verb("dismiss", { label: "not for me", quiet: true, hint: "Dismiss this raise" })}</span>
      </div>
    </div>`;
}

/* ── rendering ────────────────────────────────────────────────────
   Only the first PAGE rows of a column are put in the DOM; a sentinel at
   the end pulls in the next page as it scrolls into view. Previous alone
   can hold thousands of rows, and building all of them on every keystroke
   was the single biggest thing making the page feel slow. */
const LIMITS = { today: PAGE, prev: PAGE, raised: PAGE, app: PAGE, trash: PAGE };
const LISTS  = { today: [], prev: [], raised: [], app: [], trash: [] };
let MORE_IO = null;

/* "Applied" as one long pile answers "did I apply?" but never "what did I
   send this week?" — so it breaks on the day you applied. Undated marks
   from before this existed collect under Earlier rather than pretending to
   a date they never had. */
function dayBucket(iso) {
  if (!iso) return "Earlier";
  const t = new Date(iso); if (isNaN(t)) return "Earlier";
  const startOf = (d) => { const x = new Date(d); x.setHours(0,0,0,0); return x.getTime(); };
  const days = Math.round((startOf(Date.now()) - startOf(t)) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return t.toLocaleDateString(undefined, { weekday: "long" });
  if (days < 14) return "Last week";
  return t.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
function datedCards(list) {
  let out = "", last = null, n = 0;
  list.forEach((j) => {
    const b = dayBucket(appliedWhen(j));
    if (b !== last) {
      const count = list.filter((x) => dayBucket(appliedWhen(x)) === b).length;
      out += `<div class="day-head">${esc(b)}<em>${count}</em></div>`;
      last = b;
    }
    out += jobHTML(j, ++n, "app");
  });
  return out;
}

/* ── CSV export ──
   The durable half of the answer to "my state lives in one browser". Every
   mark, date and outreach stage in one file you can keep in Drive or Excel
   — opening it in a spreadsheet is also the fastest way to see the whole
   search at once, which the three-column board deliberately doesn't do. */
/* sourceLabel() builds an icon + label for the card; a CSV wants the label
   on its own, or the whole cell is an inlined <svg>. */
function sourceText(src) {
  const d = document.createElement("div");
  d.innerHTML = sourceLabel(src);
  return (d.textContent || "").trim();
}
function csvCell(v) {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportCSV() {
  const head = ["Company", "Role", "Location", "Salary", "Source", "Posted",
                "Status", "Applied on", "Résumé", "Outreach", "Outreach updated", "URL"];
  const stamp = (v) => (v ? new Date(v).toISOString().slice(0, 10) : "");
  const rows = JOBS.filter((j) => !TRASH.has(j.id)).map((j) => {
    const o = outOf(j) || {};
    return [
      j.company, j.title, j.location, j.salary, sourceText(j.source), stamp(jobTime(j)),
      isApplied(j) ? "Applied" : "Open",
      stamp(appliedWhen(j)),
      { sent: "Downloaded?", done: "Saved" }[RESUMES[j.id]] || "",
      { looking: "Looking", drafted: "Drafted", requested: "Requested",
        accepted: "Accepted", followed: "Followed up" }[o.stage] || "",
      stamp(o.at), j.url,
    ].map(csvCell).join(",");
  });
  // BOM so Excel reads the accents in "Résumé" instead of mojibake
  const blob = new Blob(["\uFEFF" + [head.join(","), ...rows].join("\r\n")],
                        { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `opentabs-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return rows.length;
}

function drawRows(k) {
  const items = LISTS[k], limit = LIMITS[k];
  const rows = $("#rows-" + k);
  if (!rows) return;
  if (!items.length) {
    rows.innerHTML = `<div class="col-empty">${k === "trash" ? "Trash is empty." : "Nothing here."}</div>`;
    return;
  }
  const slice = items.slice(0, limit);
  const cards = k === "raised"
    ? slice.map((f, i) => raiseHTML(f, i + 1)).join("")
    : k === "app"
      ? datedCards(slice)
      : slice.map((j, i) => jobHTML(j, i + 1, k)).join("");
  rows.innerHTML = cards + (items.length > limit
    ? `<div class="more" data-more="${k}">${limit} of ${items.length} — keep scrolling</div>` : "");
}
/* Watch each column's sentinel; when it appears, extend that column only. */
function watchMore() {
  if (!MORE_IO) {
    MORE_IO = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const k = e.target.dataset.more;
        LIMITS[k] += PAGE;
        drawRows(k);
        watchMore();
      });
    }, { rootMargin: "700px 0px" });
  }
  MORE_IO.disconnect();
  $$(".more").forEach((el) => MORE_IO.observe(el));
}

function render(animate, reset) {
  if (reset) Object.keys(LIMITS).forEach((k) => (LIMITS[k] = PAGE));

  const jobs = visible();                        // filter row applies to all
  const groups = { today: [], prev: [], app: [] };
  jobs.forEach((j) => groups[bucket(j)].push(j));
  // Sort by when you applied, not when the job was posted — the comment
  // always claimed the former and the code did the latter, which the day
  // headings would have exposed as jumbled dates.
  groups.app.sort((a, b) => (appliedWhen(b) || "").localeCompare(appliedWhen(a) || "")
                            || jobTime(b) - jobTime(a));

  // unfiltered totals, so a column head can say "showing 3 of 76" — grouped
  // the same way as the cards, else the two numbers disagree
  const totals = { today: 0, prev: 0, app: 0 };
  groupDupes(JOBS.filter((j) => !TRASH.has(j.id))).forEach((j) => totals[bucket(j)]++);

  LISTS.today  = groups.today;
  LISTS.prev   = groups.prev;
  LISTS.raised = visibleRaises();
  LISTS.app    = groups.app;

  // Ranking is per column, so Previous can sort by fit (where "newest" of
  // 1600 old jobs means little) while Today stays chronological.
  ["today", "prev"].forEach((k) => {
    if (!rankOn(k)) { LISTS[k].forEach((j) => delete j._why); return; }
    LISTS[k].forEach((j) => { const r = scoreJob(j); j._score = r.n; j._why = r.why; });
    LISTS[k].sort((a, b) => b._score - a._score || jobTime(b) - jobTime(a));
  });
  if (rankOn("raised")) {
    LISTS.raised.forEach((f) => { const r = scoreRaise(f); f._score = r.n; f._why = r.why; });
    LISTS.raised.sort((a, b) => b._score - a._score);
  } else {
    LISTS.raised.forEach((f) => delete f._why);
  }
  $$('[data-rank]').forEach((b) => {
    const on = rankOn(b.dataset.rank);
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  LISTS.trash  = groupDupes(JOBS.filter((j) => TRASH.has(j.id)));

  const raisesTotal = FUND.filter((f) => f.status !== "dismissed" && !DISMISSED.has(fundId(f))
                                        && (!locOf(f).trim() || isSF(f))).length;

  ["today", "prev", "raised", "app", "trash"].forEach(drawRows);
  watchMore();

  setCount("today",  LISTS.today.length,  totals.today);
  setCount("prev",   LISTS.prev.length,   totals.prev);
  setCount("raised", LISTS.raised.length, raisesTotal);
  setCount("app",    LISTS.app.length,    totals.app);
  setCount("trash",  LISTS.trash.length,  LISTS.trash.length);

  renderOutreach();
  const due = outreachDue();
  $$('[data-count="out"]').forEach((el) => (el.textContent = due));
  $("#tabOutreach").classList.toggle("has-due", due > 0);

  $$('[data-clear]').forEach((b) => (b.hidden = !(LISTS[b.dataset.clear] || []).length));

  $("#status").textContent = JOBS.length ? "Updated " + new Date().toLocaleTimeString() : "No data yet";
  setNum($("#statOpen"), totals.today + totals.prev);
  setNum($("#statDone"), totals.app);
  setNum($("#statRaises"), raisesTotal);

  // a pile with nothing in it is not worth entering — kept current here so
  // filtering the board down to nothing is reflected before the picker opens
  $$('.cog-pick-opt').forEach((o) => { o.disabled = !(LISTS[o.dataset.col] || []).length; });

  syncCog();
  if (animate) reveal();
}
/* Count badge + the "showing N of M" note that makes filtering visible. */
function setCount(k, shown, total) {
  $$(`[data-count="${k}"]`).forEach((el) => (el.textContent = total));
  $$(`[data-showing="${k}"]`).forEach((el) =>
    (el.textContent = shown === total ? "" : `showing ${shown} of ${total}`));
}

/* ══ Cognition mode ═══════════════════════════════════════════════
   A cursor over one column. You chose a shrinking deck, so filing a card
   removes it and the next one slides into the same slot — which means the
   left arrow can never show you what you just did. Every action therefore
   carries its own Undo, and progress counts down instead of claiming a
   total that keeps moving. ─────────────────────────────────────────── */
const COG_LABEL = { today: "Today", prev: "Previous", raised: "Just Raised" };
let cogDir = 1;                       // last direction travelled, for the slide

function cogDeck() { return LISTS[state.cog] || []; }

/* ── the rail picker ── */
function togglePicker(btn) {
  const el = $("#cogPick");
  if (!el.hidden) return closePicker();
  const r = btn.getBoundingClientRect();
  el.hidden = false;
  el.style.left = (r.right + 10) + "px";
  el.style.top = Math.min(r.top, window.innerHeight - el.offsetHeight - 12) + "px";
  btn.setAttribute("aria-expanded", "true");
}
function closePicker() {
  $("#cogPick").hidden = true;
  const b = $('[data-mode="cognition"]');
  if (b) b.setAttribute("aria-expanded", "false");
}

/* ── enter / leave ── */
function enterCog(col) {
  if (!COG_COLS.includes(col)) return;
  closePicker();
  state.cog = col;
  state.mode = "cognition";
  localStorage.setItem("mode", "cognition");
  localStorage.setItem("cogCol", col);
  // resume where you left this pile, if that card is still undecided
  const at = localStorage.getItem("cogAt:" + col);
  const i = at ? cogDeck().findIndex((r) => cogKey(r) === at) : -1;
  state.cogI = i > -1 ? i : 0;
  COG_RESTORED = true;                       // entering already resumed
  cogDir = 1;
  applyChrome();
  renderCog();
}
function exitCog() {
  if (state.mode !== "cognition") return;
  state.mode = "board";
  localStorage.setItem("mode", "board");
  hideToast();
  applyChrome();
  render(false, true);
}

/* Jobs carry .id; funding records don't, so derive one the same way twice. */
function cogKey(rec) { return state.cog === "raised" ? fundId(rec) : rec.id; }

/* ── moving ── */
function step(d) {
  const deck = cogDeck();
  if (!deck.length) return;
  const next = state.cogI + d;
  if (next < 0 || next >= deck.length) return;   // the ends are hard stops
  state.cogI = next;
  cogDir = d;
  hideToast();
  renderCog();
}

/* ── deciding ── */
/* Filing removes the card from the deck, so the cursor stays put and the
   next one arrives in its place. Nothing is lost: the toast holds the way
   back until you move on. */
function cogAct(act) {
  const rec = cogDeck()[state.cogI];
  if (!rec) return;
  const id = cogKey(rec);
  const ids = state.cog === "raised" ? [id] : idsOf(rec);
  // These two don't file the card away, so they don't advance the deck —
  // you draft the note, then decide what to do with the job.
  if (act === "resume")       { stepResume(rec, $(".cog-card [data-cog-act='resume']")); return; }
  if (act === "reach")        { stepOutreach(rec, $(".cog-card [data-cog-act='reach']")); return; }
  if (act === "apply")        { setApplied(ids, true);  toast(ids.length > 1 ? `Filed ${ids.length} postings to Applied` : "Filed to Applied", id); }
  else if (act === "trash")   { pushUndo({ type: "trash", ids }); ids.forEach((x) => TRASH.add(x)); saveTrash(); toast(ids.length > 1 ? `Moved ${ids.length} postings to Trash` : "Moved to Trash", id); }
  else if (act === "dismiss") { pushUndo({ type: "dismiss", ids: [id] }); DISMISSED.add(id); saveDismissed(); toast("Dismissed", id); }
  else return;
  cogDir = 1;
  render(false, true);        // rebuilds LISTS, then syncCog draws the next card
}
function clampCog() {
  const n = cogDeck().length;
  state.cogI = n ? Math.min(state.cogI, n - 1) : 0;
}

/* ── the toast: one action, one way back ── */
let toastT = 0;
function toast(msg, restoreId) {
  const el = $("#cogToast");
  el.innerHTML = `<span>${esc(msg)}</span><button type="button">Undo</button>`;
  el.querySelector("button").onclick = () => {
    undoLast();                                  // also re-renders the board
    hideToast();
    const i = cogDeck().findIndex((r) => cogKey(r) === restoreId);
    if (i > -1) state.cogI = i;                  // land back on the card you undid
    renderCog();
  };
  el.classList.add("on");
  clearTimeout(toastT);
  toastT = setTimeout(hideToast, 5000);
}
function hideToast() { clearTimeout(toastT); const el = $("#cogToast"); if (el) el.classList.remove("on"); }

/* ── the card ── */
function cogJobHTML(j) {
  const badges =
    (j.is_new_grad ? '<span class="badge">New Grad</span>' : "") +
    (j.is_big_tech ? '<span class="badge">Big Tech</span>' : "") +
    thinJD(j);
  const rv = RESUME_VERB[RESUMES[j.id]] || RESUME_VERB.undefined;
  const ov = outreachVerb(j);
  return `<article class="cog-card">
      <div class="cog-src">${sourceLabel(j.source)}<span class="sep">/</span>Posted ${postedAgo(j)}</div>
      <div class="cog-co">${esc(j.company || "—")}</div>
      <h3 class="cog-title">${esc(j.title)}</h3>
      <div class="cog-meta">${esc(j.location || "—")}${j._n ? `<span class="dupe">+${j._n - 1} more ${j._n - 1 === 1 ? "city" : "cities"}</span>` : ""}<span class="sep">/</span>${esc(j.salary || "Salary not listed")}</div>
      ${badges ? `<div class="badges">${badges}</div>` : ""}
      <div class="verbs verbs-lg">
        <a class="verb" href="${esc(j.url || "#")}" target="_blank" rel="noopener">read it <kbd>&crarr;</kbd></a>
        <span class="vsep">·</span>
        ${ov ? `<button class="verb${ov.done ? " is-done" : ""}${ov.live ? " is-live" : ""}" type="button" data-cog-act="reach" title="${esc(ov.hint)}">${esc(ov.label)} <kbd>P</kbd></button><span class="vsep">·</span>` : ""}
        <button class="verb${rv.done ? " is-done" : ""}" type="button" data-cog-act="resume" title="${esc(rv.hint)}">${esc(rv.label)} <kbd>R</kbd></button>
        <span class="verbs-tail">
          <button class="verb" type="button" data-cog-act="apply">mark applied <kbd>A</kbd></button>
          <button class="verb quiet" type="button" data-cog-act="trash">not for me <kbd>X</kbd></button>
        </span>
      </div>
    </article>`;
}
function cogRaiseHTML(f) {
  const roles = f.roles || [];
  const amt = val(f.amount), stage = val(f.stage);
  const headline = amt ? esc(amt) + (stage ? " · " + esc(stage) : "") : (stage ? esc(stage) : "Undisclosed round");
  const vc = tier1Of(f);
  const badges =
    (vc ? `<span class="badge vc">${esc(vc)}</span>` : "") +
    (roles.length ? `<span class="badge">${roles.length} design role${roles.length > 1 ? "s" : ""}</span>` : "");
  const rolesLine = roles.length
    ? `<div class="roles">` + roles.map((r) =>
        `<a class="role" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>`).join("") + `</div>`
    : `<div class="roles none">No design roles posted yet — DM the founder.</div>`;
  return `<article class="cog-card">
      <div class="cog-src">${esc(f.source || "—")}<span class="sep">/</span>Raised ${ago(f.first_seen)}</div>
      <a class="cog-co" href="${esc(outreachUrls.company(f.company))}" target="_blank" rel="noopener">${esc(f.company)}</a>
      <h3 class="cog-title">${headline}</h3>
      <div class="cog-meta">${esc(val(locOf(f)) || "Location unknown")}<span class="sep">/</span>${esc(val(f.investors) || "Investors undisclosed")}</div>
      ${badges ? `<div class="badges">${badges}</div>` : ""}
      ${rolesLine}
      <div class="verbs verbs-lg">
        ${f.url ? `<a class="verb" href="${esc(f.url)}" target="_blank" rel="noopener">read the article <kbd>&crarr;</kbd></a><span class="vsep">·</span>` : ""}
        <button class="verb" type="button" data-cog-act="dismiss">not for me <kbd>X</kbd></button>
      </div>
    </article>`;
}
function cogDoneHTML() {
  const others = COG_COLS.filter((c) => c !== state.cog && (LISTS[c] || []).length);
  return `<div class="cog-done">
      <h3>${esc(COG_LABEL[state.cog])} is clear.</h3>
      <p>Nothing left to work through in this pile.</p>
      <div class="cog-jump">
        ${others.map((c) => `<button class="cog-act" type="button" data-focus="${c}">${esc(COG_LABEL[c])} <em>${LISTS[c].length}</em></button>`).join("")}
        <button class="cog-act" type="button" id="cogDoneBack">Back to board</button>
      </div>
    </div>`;
}

/* The 60s poll calls render(); without this guard it would restart the
   card's slide animation every minute for no reason. */
let COG_SIG = "";
function cogSig() {
  const deck = cogDeck(), rec = deck[state.cogI];
  // The card's buttons now carry state, so that state belongs in the
  // signature — without it the label stays "Résumé" after you've already
  // handed the job off, and the mode looks broken.
  const st = rec ? (RESUMES[rec.id] || "-") + (outOf(rec) || {}).stage : "";
  return state.cog + "|" + (rec ? cogKey(rec) : "-") + "|" + deck.length + "|" + st;
}
let COG_RESTORED = false;
function syncCog() {
  if (state.mode !== "cognition") return;
  // A reload restores the mode from localStorage but goes through neither
  // enterCog nor its resume step, so do that here on the first loaded pass.
  if (!COG_RESTORED && LOADED) {
    COG_RESTORED = true;
    const at = localStorage.getItem("cogAt:" + state.cog);
    const i = at ? cogDeck().findIndex((r) => cogKey(r) === at) : -1;
    if (i > -1) state.cogI = i;
  }
  clampCog();
  if (cogSig() !== COG_SIG) renderCog();
}

function renderCog() {
  if (state.mode !== "cognition" || !LOADED) return;
  const deck = cogDeck();
  clampCog();
  const rec = deck[state.cogI];
  const stage = $("#cogStage");

  $("#cogCol").textContent = COG_LABEL[state.cog];
  $("#cogLeft").textContent = deck.length ? `${deck.length} left` : "";
  $("#cogPrev").disabled = !rec || state.cogI === 0;
  $("#cogNext").disabled = !rec || state.cogI >= deck.length - 1;

  stage.classList.remove("to-next", "to-prev");
  void stage.offsetWidth;                        // restart the slide
  stage.innerHTML = rec
    ? (state.cog === "raised" ? cogRaiseHTML(rec) : cogJobHTML(rec))
    : cogDoneHTML();
  stage.classList.add(cogDir < 0 ? "to-prev" : "to-next");

  // Just Raised has no Applied state, so it gets a different legend.
  $("#cogKeys").innerHTML = rec
    ? '<kbd>&larr;</kbd><kbd>&rarr;</kbd> move <span class="sep">/</span>'
      + (state.cog === "raised"
          ? '<kbd>X</kbd> dismiss <span class="sep">/</span><kbd>&crarr;</kbd> read'
          : '<kbd>A</kbd> applied <span class="sep">/</span><kbd>X</kbd> trash <span class="sep">/</span><kbd>&crarr;</kbd> open')
      + ' <span class="sep">/</span><kbd>Esc</kbd> board'
    : '<kbd>Esc</kbd> board';

  COG_SIG = cogSig();
  if (rec) localStorage.setItem("cogAt:" + state.cog, cogKey(rec));
  else     localStorage.removeItem("cogAt:" + state.cog);

  // the end card offers the other piles
  $$("[data-focus]", stage).forEach((b) => b.addEventListener("click", () => enterCog(b.dataset.focus)));
  const back = $("#cogDoneBack"); if (back) back.addEventListener("click", exitCog);
}

/* ── keyboard: the whole point of a focus mode ── */
function bindCogKeys() {
  document.addEventListener("keydown", (e) => {
    if (state.mode !== "cognition") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (e.key === "ArrowLeft")  { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    else if (k === "a") {
      e.preventDefault();
      if (state.cog === "raised") return;      // raises are read or dismissed, not applied
      cogAct("apply");
    }
    else if (k === "x") { e.preventDefault(); cogAct(state.cog === "raised" ? "dismiss" : "trash"); }
    else if (k === "r" && state.cog !== "raised") { e.preventDefault(); cogAct("resume"); }
    else if (k === "p" && state.cog !== "raised") { e.preventDefault(); cogAct("reach"); }
    // The primary link is a verb now; .cog-open no longer exists, so Enter
    // was silently doing nothing.
    else if (e.key === "Enter") { e.preventDefault(); const a = $(".cog-card a.verb"); if (a) a.click(); }
    else if (e.key === "Escape") { e.preventDefault(); exitCog(); }
  });
}

/* ── touch: edge arrows are a desktop idea ── */
function bindCogSwipe() {
  const stage = $("#cogStage");
  let x0 = null, y0 = null;
  stage.addEventListener("touchstart", (e) => {
    const t = e.changedTouches[0]; x0 = t.clientX; y0 = t.clientY;
  }, { passive: true });
  stage.addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
  }, { passive: true });
}

/* ── apply persisted size/theme/sort to the DOM ────────────────── */
function applyChrome() {
  if (!THEMES.includes(state.theme)) state.theme = "dark";
  // a mode saved before it shipped (or after one is removed) falls back
  if (!MODES.includes(state.mode)) state.mode = "board";
  if (!COG_COLS.includes(state.cog)) state.cog = "today";
  document.documentElement.setAttribute("data-theme", state.theme);
  document.documentElement.setAttribute("data-mode", state.mode);
  $$('[data-mode]').forEach((b) => {
    const on = b.dataset.mode === state.mode;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  $$('.sw').forEach((b) => b.classList.toggle("is-on", b.dataset.theme === state.theme));
}

/* ── right-hand panels (Applied · Trash) ───────────────────────── */
function openDrawer(which) {
  state.drawer = which || null;
  ["app", "trash", "out"].forEach((k) => document.body.classList.toggle("drawer-" + k, which === k));
  document.body.classList.toggle("drawer-open", !!which);
}

/* ── Clear-all confirm popup ───────────────────────────────────── */
let pendingClear = null;
function closeModal() { $("#modalScrim").hidden = true; pendingClear = null; }
function openModal(k) {
  if (!LABELS[k]) return;
  pendingClear = k;
  const copy = k === "trash"
    ? ['This will restore <b>everything in Trash</b> to the board. Continue?', "Yes, restore all"]
    : k === "raised"
      ? ['This will dismiss every raise shown in <b>Just Raised</b>. Undo still works. Continue?', "Yes, dismiss"]
      : [`This will move everything shown in <b>“${esc(LABELS[k])}”</b> to Trash. Continue?`, "Yes, move to Trash"];
  $("#modalMsg").innerHTML = copy[0];
  $("#modalYes").textContent = copy[1];
  $("#modalScrim").hidden = false;
}

/* ── wire up all the controls ─────────────────────────────────── */
function bind() {
  // debounced: typing used to rebuild every card in every column per keystroke
  let qT = 0;
  $("#q").addEventListener("input", (e) => {
    state.q = e.target.value;
    clearTimeout(qT);
    qT = setTimeout(() => render(false, true), 180);
  });
  ddInit();

  // Mode switch. Modes that aren't built yet stay inert — clicking one
  // says so rather than half-switching into a surface that isn't there.
  $$('[data-mode]').forEach((b) => {
    ["pointerenter", "focus"].forEach((ev) =>
      b.addEventListener(ev, () => { if (!tipHold) showTip(b); }));
    ["pointerleave", "blur"].forEach((ev) => b.addEventListener(ev, hideTip));
  });
  $$('[data-mode]').forEach((b) => b.addEventListener("click", (e) => {
    const m = b.dataset.mode;
    // The brain is a doorway, not a switch: it asks which pile to work.
    if (m === "cognition") { e.stopPropagation(); togglePicker(b); return; }
    if (m === "board") exitCog();
  }));

  // picker + per-column shortcuts
  $$('[data-rank]').forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.rank;
    state.rank[k] = !state.rank[k];
    localStorage.setItem("rank", JSON.stringify(state.rank));
    render(true, true);
  }));

  $$('.cog-pick-opt').forEach((b) => b.addEventListener("click", () => enterCog(b.dataset.col)));
  $$('[data-focus]').forEach((b) => b.addEventListener("click", () => enterCog(b.dataset.focus)));
  document.addEventListener("click", (e) => {
    if (!$("#cogPick").hidden && !e.target.closest("#cogPick")) closePicker();
    if (!$("#projPick").hidden && !e.target.closest("#projPick") && !e.target.closest("#projBtn")) closeProjPanel();
  });

  $("#projBtn").addEventListener("click", () => ($("#projPick").hidden ? openProjPanel() : closeProjPanel()));
  $("#projSave").addEventListener("click", saveProject);
  $("#projClear").addEventListener("click", clearProject);
  $$('[data-export]').forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    flashTip(b, `Exported ${exportCSV()} jobs to CSV`);
  }));
  $("#projInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveProject();
    if (e.key === "Escape") closeProjPanel();
  });
  // Editing after a warning clears it, so the next Save is a fresh judgement
  // rather than "press again" carrying over onto a different link.
  $("#projInput").addEventListener("input", () => {
    if (!$("#projHint").classList.contains("warn")) return;
    $("#projInput").classList.remove("bad");
    $("#projHint").classList.remove("warn");
    $("#projHint").textContent = "Open your Claude or ChatGPT project, copy the address bar, paste it here.";
  });

  $("#cogPrev").addEventListener("click", () => step(-1));
  $("#cogNext").addEventListener("click", () => step(1));
  $("#cogExit").addEventListener("click", exitCog);
  $("#cogStage").addEventListener("click", (e) => {
    const a = e.target.closest("[data-cog-act]");
    if (a) cogAct(a.dataset.cogAct);
  });
  bindCogKeys();
  bindCogSwipe();

  $$('.sw').forEach((b) => b.addEventListener("click", () => {
    state.theme = b.dataset.theme; localStorage.setItem("theme", state.theme); applyChrome();
  }));

  // right-hand panels
  $("#tabApplied").addEventListener("click", () => openDrawer(state.drawer === "app" ? null : "app"));
  $("#tabOutreach").addEventListener("click", () => openDrawer(state.drawer === "out" ? null : "out"));
  $("#tabTrash").addEventListener("click", () => openDrawer(state.drawer === "trash" ? null : "trash"));
  // A row is a shortcut back to the job it belongs to, not a control of its
  // own: the stage still advances from the card, where the context is.
  $("#drawerOutreach").addEventListener("click", (e) => {
    const rst = e.target.closest("[data-out-reset]");
    if (rst) {                                 // mis-click, or the thread died
      delete OUTREACH[rst.dataset.outReset];
      saveOutreach(); render(false);
      return;
    }
    const row = e.target.closest("[data-out-id]");
    if (!row) return;
    openDrawer(null);
    const card = $(`.job[data-id="${row.dataset.outId}"]`);
    if (card) { card.scrollIntoView({ behavior: "smooth", block: "center" }); card.classList.add("pinged"); setTimeout(() => card.classList.remove("pinged"), 1200); }
  });
  $$('.drawer-close').forEach((b) => b.addEventListener("click", () => openDrawer(null)));
  $("#drawerScrim").addEventListener("click", () => openDrawer(null));

  // ── Clear all / Restore all ──
  $$('.clear-all').forEach((b) => b.addEventListener("click", () => openModal(b.dataset.clear)));
  $("#modalNo").addEventListener("click", closeModal);
  $("#modalScrim").addEventListener("click", (e) => { if (e.target === $("#modalScrim")) closeModal(); });
  $("#modalYes").addEventListener("click", () => {
    const k = pendingClear;
    if (!k) return;
    if (k === "raised") {
      const ids = visibleRaises().map(fundId);
      if (ids.length) { pushUndo({ type: "dismiss", ids }); ids.forEach((id) => DISMISSED.add(id)); saveDismissed(); }
    } else if (k === "trash") {
      const ids = JOBS.filter((j) => TRASH.has(j.id)).map((j) => j.id);
      if (ids.length) { pushUndo({ type: "restore", ids }); ids.forEach((id) => TRASH.delete(id)); saveTrash(); }
    } else {
      const ids = visible().filter((j) => bucket(j) === k).map((j) => j.id);
      if (ids.length) { pushUndo({ type: "trash", ids }); ids.forEach((id) => TRASH.add(id)); saveTrash(); }
    }
    closeModal(); render(true);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { openDrawer(null); closeModal(); $$(".dd.open").forEach(ddClose); }
  });

  // ── Card interactions ──
  const onCardClick = (e) => {
    const raise = e.target.closest(".raise");
    if (raise) {                              // Just Raised card: dismiss or links
      if (e.target.closest('[data-act="dismiss"]')) {
        const id = raise.dataset.id;
        pushUndo({ type: "dismiss", ids: [id] }); DISMISSED.add(id); saveDismissed(); render(true);
      }
      return;                                 // every other target is a real link
    }
    const card = e.target.closest(".job"); if (!card) return;
    // The company name and the title are real links now — let the browser
    // have them rather than intercepting and re-opening.
    if (e.target.closest("a")) return;
    const id = card.dataset.id, url = card.dataset.url;
    // A collapsed card stands for every city it absorbed — filing one copy
    // and leaving the other 24 on the board would defeat the point.
    const ids = (card.dataset.ids || id).split(" ").filter(Boolean);

    if (e.target.closest('[data-act="resume"]')) {
      const job = JOBS.find((x) => x.id === id);
      if (job) stepResume(job, e.target.closest('[data-act="resume"]'));
      return;
    }
    if (e.target.closest('[data-act="reach"]')) {
      const job = JOBS.find((x) => x.id === id);
      if (job) stepOutreach(job, e.target.closest('[data-act="reach"]'));
      return;
    }
    if (e.target.closest('[data-act="apply"]'))   { setApplied(ids, true);  render(false); return; }
    if (e.target.closest('[data-act="unapply"]')) { setApplied(ids, false); render(false); return; }
    if (e.target.closest('[data-act="restore"]')) {
      pushUndo({ type: "restore", ids }); ids.forEach((x) => TRASH.delete(x)); saveTrash(); render(true); return;
    }
    if (e.target.closest('[data-act="delete"]')) {
      pushUndo({ type: "trash", ids });
      card.classList.add("leaving");
      setTimeout(() => { ids.forEach((x) => TRASH.add(x)); saveTrash(); render(false); }, 160);
      return;
    }
    // anywhere else on the card → open the posting
    if (url && url !== "#") window.open(url, "_blank", "noopener");
  };
  $("main").addEventListener("click", onCardClick);
  $("#drawerApplied").addEventListener("click", onCardClick);
  $("#drawerTrash").addEventListener("click", onCardClick);
}

/* ── Custom dropdown controller (multi-select + single) ─────────── */
function ddSummary(dd) {
  const sum = dd.querySelector(".dd-sum");
  const single = !dd.hasAttribute("data-multi");
  const checked = $$(".dd-opt input:checked", dd).filter((i) => single || i.value !== "");
  if (single) {
    const v = dd.querySelector(".dd-opt input:checked");
    const has = v && v.value !== "";
    sum.textContent = v ? v.closest(".dd-opt").querySelector("span").textContent : "Any";
    dd.classList.toggle("has-val", !!has);
  } else if (!checked.length) {
    sum.textContent = "All"; dd.classList.remove("has-val");
  } else if (checked.length === 1) {
    sum.textContent = checked[0].closest(".dd-opt").querySelector("span").textContent;
    dd.classList.add("has-val");
  } else {
    sum.textContent = checked.length + " selected"; dd.classList.add("has-val");
  }
}
function ddApply(dd) {
  const key = dd.dataset.dd;
  if (dd.hasAttribute("data-multi"))
    state[key] = $$(".dd-opt input:checked", dd).map((i) => i.value);
  else
    state[key] = (dd.querySelector(".dd-opt input:checked") || {}).value || "";
  ddSummary(dd);
  render(true, true);
}
function ddClose(dd) {
  dd.classList.remove("open");
  dd.querySelector(".dd-btn").setAttribute("aria-expanded", "false");
}
function ddInit() {
  $$(".dd").forEach((dd) => {
    const btn = dd.querySelector(".dd-btn");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = !dd.classList.contains("open");
      $$(".dd.open").forEach(ddClose);
      dd.classList.toggle("open", willOpen);
      btn.setAttribute("aria-expanded", String(willOpen));
    });
    dd.querySelector(".dd-panel").addEventListener("change", () => {
      ddApply(dd);
      if (!dd.hasAttribute("data-multi")) ddClose(dd);   // single-select closes
    });
    ddSummary(dd);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".dd")) $$(".dd.open").forEach(ddClose);
  });
}

/* ── load data + refresh loop ─────────────────────────────────── */
function populateSources() {
  const sources = [...new Set(JOBS.map((j) => j.source).filter(Boolean))].sort();
  const dd = $('.dd[data-dd="source"]');
  if (!dd) return;
  const cur = new Set(state.source);
  const panel = dd.querySelector(".dd-panel");
  panel.innerHTML = sources.length
    ? sources.map((s) =>
        `<label class="dd-opt"><input type="checkbox" value="${esc(s)}"${cur.has(s) ? " checked" : ""}><span>${esc(s)}</span></label>`).join("")
    : '<div class="dd-empty">No sources yet</div>';
  ddSummary(dd);
}

// Hybrid runners publish two files: jobs.local.json (laptop: LinkedIn/
// Indeed/Glassdoor/ZipRecruiter/Google) and jobs.cloud.json (GitHub
// Actions: API/RSS/ATS + funding roles). Both are pruned to 30 days by
// opentabs.py, and anything that slips through is dropped here too.
const JOB_FILES = ["./jobs.local.json", "./jobs.cloud.json"];
function fresh(rec) {
  const t = new Date(rec.first_seen).getTime();
  return !t || Date.now() - t <= MAX_AGE_MS;    // undated records are kept
}
const JOB_SRCS = ["local", "cloud"];        // parallel to JOB_FILES
function mergeJobs(lists) {
  const byId = new Map();
  lists.forEach((arr, i) => (Array.isArray(arr) ? arr : []).forEach((j) => {
    if (j) j._src = JOB_SRCS[i] || "all";
    if (!j || !j.id || !fresh(j)) return;
    const prev = byId.get(j.id);
    // keep the freshest copy if the same posting shows up in both files
    if (!prev || (j.first_seen || "") > (prev.first_seen || "")) byId.set(j.id, j);
  }));
  return [...byId.values()];
}

/* Cheap fingerprint of a payload. The 60s refresh usually brings back
   exactly what we already have; re-rendering on that was pure waste. */
function sigOf(jobs, fund) {
  let newest = "";
  jobs.forEach((j) => { if ((j.first_seen || "") > newest) newest = j.first_seen; });
  return jobs.length + "|" + newest + "|" + fund.length;
}
let SIG = "";
let LOADED = false;             // no card, and no "pile is clear", before data

/* no-cache revalidates rather than re-downloads: the browser sends the
   ETag and the server answers 304 when the file has not changed. The old
   ?_=timestamp buster made every 60s poll a full re-download. */
const GET = (f) => fetch(f, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : [])).catch(() => []);

function load(animate) {
  Promise.all([...JOB_FILES.map(GET), GET("./funding.json")]).then((lists) => {
    const jobs = mergeJobs(lists.slice(0, 2));
    const fund = (Array.isArray(lists[2]) ? lists[2] : []).filter(fresh);
    const sig = sigOf(jobs, fund);
    if (sig === SIG && !animate) {                 // nothing new — don't repaint
      $("#status").textContent = "Updated " + new Date().toLocaleTimeString();
      syncCog();
      return;
    }
    SIG = sig;
    LOADED = true;
    JOBS = jobs; FUND = fund;
    if (!JOBS.length) $("#status").textContent = "No data yet";
    populateSources(); render(animate, true);
  });
}

// deep links from bookmarks still open the right panel
if (location.hash === "#trash") state.drawer = "trash";
if (location.hash === "#applied") state.drawer = "app";

applyChrome();
openDrawer(state.drawer);
bind();
load(true);
setInterval(() => load(false), 60000);
