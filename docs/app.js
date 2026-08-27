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
  q: "", source: [], loc: [], date: "", visa: [],   // source/loc/visa = multi
  sort: localStorage.getItem("sort") || "new",      // new | city | pay
  size: +(localStorage.getItem("size") || 24),
  theme: localStorage.getItem("theme") || "dark",
  drawer: null,                                     // null | "app" | "trash"
};
/* Labels for the confirm dialog and the empty states. */
const LABELS = { today: "Today", prev: "Previous", raised: "Just Raised", app: "Applied", trash: "Trash" };
const SORTS = ["new", "city", "pay"];
const THEMES = ["dark", "paper", "blush", "mint", "cream"];
const PAGE = 40;                        // rows rendered per column up front
const MAX_AGE_MS = 30 * 864e5;          // the site ignores anything older

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => (s || "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ── Applied marks + Trash + dismissed raises + Undo (per-browser) ── */
function loadMarks() { try { return JSON.parse(localStorage.getItem("marks") || "{}"); } catch { return {}; } }
function saveMarks(m) { localStorage.setItem("marks", JSON.stringify(m)); }
let MARKS = loadMarks();                           // { jobId: "done" }
function isApplied(j) { return MARKS[j.id] === "done" || j.status === "applied"; }

function loadSet(key) { try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch { return new Set(); } }
let TRASH = loadSet("trash");                      // Set<jobId>
function saveTrash() { localStorage.setItem("trash", JSON.stringify([...TRASH])); }
let DISMISSED = loadSet("raisedDismissed");        // Set<fundingId>
function saveDismissed() { localStorage.setItem("raisedDismissed", JSON.stringify([...DISMISSED])); }

/* Funding records have no stable id field — derive one the same way twice. */
function fundId(f) { return (f.id || (f.company || "") + "|" + (f.url || f.first_seen || "")); }

const UNDO_STACK = [];   // {type:"mark",ids,prev} | {type:"trash"|"restore"|"dismiss",ids}
function pushUndo(e) { UNDO_STACK.push(e); refreshUndo(); }
function refreshUndo() { const b = $("#undoBtn"); if (b) b.disabled = UNDO_STACK.length === 0; }
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
  refreshUndo();
  render(true);
}
/* Mark / un-mark a set of jobs as applied, recording one undo entry. */
function setApplied(ids, applied) {
  if (!ids.length) return;
  pushUndo({ type: "mark", ids, prev: ids.map((id) => MARKS[id]) });
  ids.forEach((id) => { if (applied) MARKS[id] = "done"; else delete MARKS[id]; });
  saveMarks(MARKS);
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
function salaryNum(s) {
  const m = (s || "").replace(/,/g, "").match(/\$(\d+)(k)?/i);
  if (!m) return -1;
  return parseInt(m[1], 10) * (m[2] ? 1000 : 1);
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
    if (state.visa.length && !state.visa.includes(j.visa || "unknown")) return false;
    return true;
  });
  out.sort((a, b) => {
    if (state.sort === "new") return jobTime(b) - jobTime(a);         // newest on top
    if (state.sort === "pay") return salaryNum(b.salary) - salaryNum(a.salary);
    const pa = a.priority || 9, pb = b.priority || 9;                 // city
    if (pa !== pb) return pa - pb;
    return (b.first_seen || "").localeCompare(a.first_seen || "");
  });
  return out;
}

/* ── filtering + sorting: funding (Just Raised column) ─────────── */
/* SF / Bay Area test — the Just Raised column is SF-only on purpose. */
function isSF(f) {
  const t = (f.location || (f.roles && f.roles[0] && f.roles[0].location) || "").toLowerCase();
  return /san francisco|bay area|palo alto|mountain view|san jose|oakland|menlo park|sunnyvale|berkeley|redwood city|san mateo|santa clara|\bsf\b/.test(t);
}
function locOf(f) { return f.location || (f.roles && f.roles[0] && f.roles[0].location) || ""; }
// "$24.0M" → 24, "$1.5B" → 1500, "Undisclosed" → -1
function amtNum(a) {
  const m = (a || "").match(/\$?\s*([\d.]+)\s*([MB])/i);
  if (!m) return -1;
  return parseFloat(m[1]) * (m[2].toUpperCase() === "B" ? 1000 : 1);
}
function visibleRaises() {
  const out = FUND.filter((f) => {
    if (f.status === "dismissed") return false;
    if (DISMISSED.has(fundId(f))) return false;
    if (!isSF(f)) return false;
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
  const byNew = (a, b) => (b.first_seen || "").localeCompare(a.first_seen || "");
  out.sort((a, b) => {
    if (state.sort === "pay") return amtNum(b.amount) - amtNum(a.amount) || byNew(a, b);
    if (state.sort === "city") {
      const la = locOf(a), lb = locOf(b);
      if (!la !== !lb) return la ? -1 : 1;
      return la.localeCompare(lb) || byNew(a, b);
    }
    return byNew(a, b);
  });
  return out;
}

/* ── glyphs ───────────────────────────────────────────────────── */
const LI_SVG = '<svg class="ico-li" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" aria-label="LinkedIn"><path d="M216,24H40A16,16,0,0,0,24,40V216a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V40A16,16,0,0,0,216,24ZM96,176a8,8,0,0,1-16,0V112a8,8,0,0,1,16,0ZM88,96a12,12,0,1,1,12-12A12,12,0,0,1,88,96Zm96,80a8,8,0,0,1-16,0V140a20,20,0,0,0-40,0v36a8,8,0,0,1-16,0V112a8,8,0,0,1,15.79-1.78A36,36,0,0,1,184,140Z"></path></svg>';
const MONEY_SVG = '<svg class="ico-money" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" aria-label="Just raised"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm40-68a28,28,0,0,1-28,28h-4v8a8,8,0,0,1-16,0v-8H104a8,8,0,0,1,0-16h36a12,12,0,0,0,0-24H116a28,28,0,0,1,0-56h4V72a8,8,0,0,1,16,0v8h16a8,8,0,0,1,0,16H116a12,12,0,0,0,0,24h24A28,28,0,0,1,168,148Z"></path></svg>';
const WEB_SVG = '<svg width="12" height="12" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24ZM101.63,168h52.74C149,186.34,140,202.87,128,215.89,116,202.87,107,186.34,101.63,168ZM98,152a145.72,145.72,0,0,1,0-48h60a145.72,145.72,0,0,1,0,48ZM40,128a87.61,87.61,0,0,1,3.33-24H81.79a161.79,161.79,0,0,0,0,48H43.33A87.61,87.61,0,0,1,40,128ZM154.37,88H101.63C107,69.66,116,53.13,128,40.11,140,53.13,149,69.66,154.37,88Zm19.84,16h38.46a88.15,88.15,0,0,1,0,48H174.21a161.79,161.79,0,0,0,0-48Zm32.16-16H170.94a142.39,142.39,0,0,0-20.26-45A88.37,88.37,0,0,1,206.37,88ZM105.32,43A142.39,142.39,0,0,0,85.06,88H49.63A88.37,88.37,0,0,1,105.32,43ZM49.63,168H85.06a142.39,142.39,0,0,0,20.26,45A88.37,88.37,0,0,1,49.63,168Zm101.05,45a142.39,142.39,0,0,0,20.26-45h35.43A88.37,88.37,0,0,1,150.68,213Z"></path></svg>';
const LI_MINI = '<svg width="12" height="12" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M216,24H40A16,16,0,0,0,24,40V216a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V40A16,16,0,0,0,216,24ZM96,176a8,8,0,0,1-16,0V112a8,8,0,0,1,16,0Zm-8-80a12,12,0,1,1,12-12A12,12,0,0,1,88,96Zm96,80a8,8,0,0,1-16,0V140a20,20,0,0,0-40,0v36a8,8,0,0,1-16,0V112a8,8,0,0,1,15.79-1.78A36,36,0,0,1,184,140Z"></path></svg>';
const CLOSE_SVG = '<svg width="16" height="16" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"></path></svg>';
const TRASH_SVG = '<svg width="16" height="16" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"></path></svg>';

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
function outreachHTML(rec) {
  const founders = (rec.founders || []).slice(0, 2).map((nm) =>
    `<a class="founder" href="${esc(outreachUrls.founder(nm, rec.company))}" target="_blank" rel="noopener" ` +
    `title="Find ${esc(nm)} on LinkedIn">${esc(nm)}${LI_MINI}</a>`).join("");
  return `<div class="outreach">
        <a class="ol" href="${esc(outreachUrls.site(rec.company))}" target="_blank" rel="noopener">${WEB_SVG}Website</a>
        <a class="ol" href="${esc(outreachUrls.company(rec.company))}" target="_blank" rel="noopener">${LI_MINI}Company</a>
        ${founders ? `<span class="ol-lbl">Founders</span>${founders}` : ""}
      </div>`;
}

function sourceLabel(src) {
  src = src || "";
  if (/just raised/i.test(src)) return MONEY_SVG + '<span>' + esc(src.replace(/^\s*💰\s*/, "")) + '</span>';
  if (/linkedin/i.test(src)) return LI_SVG + '<span>LinkedIn</span>';
  return esc(src);
}

function setNum(el, val) { if (el) el.textContent = val; }
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
function jobHTML(j, n, mode) {
  const idx = String(n).padStart(2, "0");
  const badges =
    (j.is_new_grad ? '<span class="badge">New Grad</span>' : "") +
    (j.is_big_tech ? '<span class="badge">Big Tech</span>' : "") +
    (j.visa === "yes" ? '<span class="badge visa-yes">Visa ✓</span>'
     : j.visa === "no" ? '<span class="badge visa-no">No visa</span>' : "");
  // One obvious control per state: file it, un-file it, or bring it back.
  const actions =
    mode === "trash" ? '<button class="act done" data-act="restore">Restore</button>'
    : mode === "app" ? '<button class="act ghost" data-act="unapply">Un-apply</button>' +
                       `<button class="act icon del" data-act="delete" title="Move to Trash" aria-label="Move to Trash">${TRASH_SVG}</button>`
    : '<button class="act done" data-act="apply">Applied</button>' +
      `<button class="act icon del" data-act="delete" title="Move to Trash" aria-label="Move to Trash">${TRASH_SVG}</button>`;
  return `<div class="job" data-id="${esc(j.id)}" data-url="${esc(j.url || "#")}" data-title="${esc(j.title)}" data-flip-id="${esc(j.id)}">
      <div class="job-top">
        <span class="idx">${idx}</span>
        <span class="co">${esc(j.company)}</span>
        <span class="src">${sourceLabel(j.source)}</span>
      </div>
      <div class="job-title">${esc(j.title)}</div>
      <div class="job-meta">
        ${esc(j.location || "—")}<span class="sep">/</span>${esc(j.salary || "—")}<span class="sep">/</span>Posted ${postedAgo(j)}
      </div>
      <div class="job-foot">
        ${mode === "trash" ? "" : outreachHTML(j)}
        <span class="badges">${badges}</span>
        <span class="actions">${actions}</span>
      </div>
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
  const badges =
    ((f.priority || 0) >= 8 ? '<span class="badge">Tier-1 VC</span>' : "") +
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
  return `<div class="job raise" data-id="${esc(fundId(f))}">
      <div class="job-top">
        <span class="idx">${idx}</span>
        <a class="co" href="${esc(outreachUrls.company(f.company))}" target="_blank" rel="noopener" title="${esc(f.company)} on LinkedIn">${esc(f.company)}</a>
        <span class="src">${esc(f.source || "")}</span>
      </div>
      <div class="job-title">${headline}</div>
      <div class="job-meta">
        ${esc(val(loc) || "—")}<span class="sep">/</span>${esc(val(f.investors) || "—")}<span class="sep">/</span>Raised ${ago(f.first_seen)}
      </div>
      ${rolesLine}
      <div class="job-foot">
        ${outreachHTML(f)}
        <span class="badges">${badges}</span>
        <span class="actions">
          ${f.url ? `<a class="act done" href="${esc(f.url)}" target="_blank" rel="noopener">Read article</a>` : ""}
          <button class="act icon del" data-act="dismiss" title="Dismiss" aria-label="Dismiss">${CLOSE_SVG}</button>
        </span>
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
  groups.app.sort((a, b) => jobTime(b) - jobTime(a));   // most recently applied first

  // unfiltered totals, so a column head can say "showing 3 of 76"
  const totals = { today: 0, prev: 0, app: 0 };
  JOBS.forEach((j) => { if (!TRASH.has(j.id)) totals[bucket(j)]++; });

  LISTS.today  = groups.today;
  LISTS.prev   = groups.prev;
  LISTS.raised = visibleRaises();
  LISTS.app    = groups.app;
  LISTS.trash  = JOBS.filter((j) => TRASH.has(j.id));

  const raisesTotal = FUND.filter((f) => f.status !== "dismissed" && !DISMISSED.has(fundId(f)) && isSF(f)).length;

  ["today", "prev", "raised", "app", "trash"].forEach(drawRows);
  watchMore();

  setCount("today",  LISTS.today.length,  totals.today);
  setCount("prev",   LISTS.prev.length,   totals.prev);
  setCount("raised", LISTS.raised.length, raisesTotal);
  setCount("app",    LISTS.app.length,    totals.app);
  setCount("trash",  LISTS.trash.length,  LISTS.trash.length);

  $$('.clear-all').forEach((b) => (b.hidden = !LISTS[b.dataset.clear].length));

  $("#status").textContent = JOBS.length ? "Updated " + new Date().toLocaleTimeString() : "No data yet";
  setNum($("#statOpen"), totals.today + totals.prev);
  setNum($("#statDone"), totals.app);
  setNum($("#statRaises"), raisesTotal);

  refreshUndo();
  if (animate) reveal();
}
/* Count badge + the "showing N of M" note that makes filtering visible. */
function setCount(k, shown, total) {
  $$(`[data-count="${k}"]`).forEach((el) => (el.textContent = total));
  $$(`[data-showing="${k}"]`).forEach((el) =>
    (el.textContent = shown === total ? "" : `showing ${shown} of ${total}`));
}

/* ── apply persisted size/theme/sort to the DOM ────────────────── */
function applyChrome() {
  if (!THEMES.includes(state.theme)) state.theme = "dark";
  if (!SORTS.includes(state.sort)) state.sort = "new";
  document.documentElement.setAttribute("data-theme", state.theme);
  $$('.sw').forEach((b) => b.classList.toggle("is-on", b.dataset.theme === state.theme));
  $$('[data-sort]').forEach((b) => b.classList.toggle("is-on", b.dataset.sort === state.sort));
  document.documentElement.style.setProperty("--spec-size", state.size + "px");
  $("#size").value = state.size;
  $("#sizeVal").textContent = state.size;
  refreshUndo();
}

/* ── right-hand panels (Applied · Trash) ───────────────────────── */
function openDrawer(which) {
  state.drawer = which || null;
  ["app", "trash"].forEach((k) => document.body.classList.toggle("drawer-" + k, which === k));
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

  $$('[data-sort]').forEach((b) => b.addEventListener("click", () => {
    state.sort = b.dataset.sort; localStorage.setItem("sort", state.sort);
    $$('[data-sort]').forEach((x) => x.classList.toggle("is-on", x === b));
    render(true, true);
  }));

  $("#size").addEventListener("input", (e) => {
    state.size = +e.target.value; localStorage.setItem("size", state.size);
    document.documentElement.style.setProperty("--spec-size", state.size + "px");
    $("#sizeVal").textContent = state.size;
  });

  $$('.sw').forEach((b) => b.addEventListener("click", () => {
    state.theme = b.dataset.theme; localStorage.setItem("theme", state.theme); applyChrome();
  }));

  // right-hand panels
  $("#tabApplied").addEventListener("click", () => openDrawer(state.drawer === "app" ? null : "app"));
  $("#tabTrash").addEventListener("click", () => openDrawer(state.drawer === "trash" ? null : "trash"));
  $$('.drawer-close').forEach((b) => b.addEventListener("click", () => openDrawer(null)));
  $("#drawerScrim").addEventListener("click", () => openDrawer(null));

  $("#undoBtn").addEventListener("click", undoLast);

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
    if (e.target.closest(".outreach")) return;   // outreach links open on their own
    const id = card.dataset.id, url = card.dataset.url;

    if (e.target.closest('[data-act="apply"]'))   { setApplied([id], true);  render(false); return; }
    if (e.target.closest('[data-act="unapply"]')) { setApplied([id], false); render(false); return; }
    if (e.target.closest('[data-act="restore"]')) {
      pushUndo({ type: "restore", ids: [id] }); TRASH.delete(id); saveTrash(); render(true); return;
    }
    if (e.target.closest('[data-act="delete"]')) {
      pushUndo({ type: "trash", ids: [id] });
      card.classList.add("leaving");
      setTimeout(() => { TRASH.add(id); saveTrash(); render(false); }, 160);
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
function mergeJobs(lists) {
  const byId = new Map();
  lists.forEach((arr) => (Array.isArray(arr) ? arr : []).forEach((j) => {
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

function load(animate) {
  Promise.all([
    ...JOB_FILES.map((f) => fetch(f + "?_=" + Date.now()).then((r) => (r.ok ? r.json() : [])).catch(() => [])),
    fetch("./funding.json?_=" + Date.now()).then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]).then((lists) => {
    const jobs = mergeJobs(lists.slice(0, 2));
    const fund = (Array.isArray(lists[2]) ? lists[2] : []).filter(fresh);
    const sig = sigOf(jobs, fund);
    if (sig === SIG && !animate) {                 // nothing new — don't repaint
      $("#status").textContent = "Updated " + new Date().toLocaleTimeString();
      return;
    }
    SIG = sig;
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
