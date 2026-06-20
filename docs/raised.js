/* ════════════════════════════════════════════════════════════════
   OpenTabs — Just Raised page
   Reads ./funding.json (written by opentabs.py's funding radar) and
   renders a feed of recent raises + the design roles each is hiring for.
   Separate from the job board (index.html) on purpose: this page is
   funding NEWS for research/outreach, not postings to apply to.
   ════════════════════════════════════════════════════════════════ */

const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => (s || "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// share the theme chosen on the job board
const theme = localStorage.getItem("theme") || "dark";
document.documentElement.setAttribute("data-theme",
  ["dark", "paper", "blush", "mint", "cream"].includes(theme) ? theme : "dark");

function ago(when) {
  const d = (Date.now() - new Date(when).getTime()) / 1000;
  if (isNaN(d)) return "recently";
  if (d < 3600)  return Math.max(1, Math.floor(d / 60)) + "m ago";
  if (d < 86400) return Math.floor(d / 3600) + "h ago";
  return Math.floor(d / 86400) + "d ago";
}
function fmtDate(d) {
  try { return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return ""; }
}
// SF / Bay Area only (best-effort, from the extracted/role location)
function isSF(f) {
  const t = (f.location || (f.roles && f.roles[0] && f.roles[0].location) || "").toLowerCase();
  return /san francisco|bay area|palo alto|mountain view|san jose|oakland|menlo park|sunnyvale|berkeley|redwood city|san mateo|santa clara|\bsf\b/.test(t);
}
// Direct URLs derived from the company name (no scraping, no API)
const coDomain = (co) => (co || "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]/g, "");
const coSlug   = (co) => (co || "").toLowerCase().replace(/\([^)]*\)/g, " ")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
// Direct LinkedIn company page for a startup name
function linkedinUrl(co) {
  return coSlug(co) ? "https://www.linkedin.com/company/" + coSlug(co) : "#";
}
// Direct to the company's website (best-guess .com)
function siteUrl(co) {
  return coDomain(co) ? "https://" + coDomain(co) + ".com" : "#";
}
// Google search pinned to a founder's LinkedIn profile (no scraping, no API)
function founderUrl(name, co) {
  return "https://www.google.com/search?q=" +
    encodeURIComponent('site:linkedin.com/in "' + (name || "") + '" ' + (co || ""));
}

/* map-pin glyph for the highlighted location chip */
const PIN_SVG = '<svg class="ico-pin" width="13" height="13" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M200,224H150.54A266.56,266.56,0,0,0,174,200.25c27.45-31.57,42-64.85,42-96.25a88,88,0,0,0-176,0c0,31.4,14.51,64.68,42,96.25A266.56,266.56,0,0,0,105.46,224H56a8,8,0,0,0,0,16H200a8,8,0,0,0,0-16ZM128,72a32,32,0,1,1-32,32A32,32,0,0,1,128,72Z"></path></svg>';
const LI_SVG  = '<svg width="12" height="12" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M216,24H40A16,16,0,0,0,24,40V216a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V40A16,16,0,0,0,216,24ZM96,176a8,8,0,0,1-16,0V112a8,8,0,0,1,16,0Zm-8-80a12,12,0,1,1,12-12A12,12,0,0,1,88,96Zm96,80a8,8,0,0,1-16,0V140a20,20,0,0,0-40,0v36a8,8,0,0,1-16,0V112a8,8,0,0,1,15.79-1.78A36,36,0,0,1,184,140Z"></path></svg>';
const WEB_SVG = '<svg width="12" height="12" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24ZM101.63,168h52.74C149,186.34,140,202.87,128,215.89,116,202.87,107,186.34,101.63,168ZM98,152a145.72,145.72,0,0,1,0-48h60a145.72,145.72,0,0,1,0,48ZM40,128a87.61,87.61,0,0,1,3.33-24H81.79a161.79,161.79,0,0,0,0,48H43.33A87.61,87.61,0,0,1,40,128ZM154.37,88H101.63C107,69.66,116,53.13,128,40.11,140,53.13,149,69.66,154.37,88Zm19.84,16h38.46a88.15,88.15,0,0,1,0,48H174.21a161.79,161.79,0,0,0,0-48Zm32.16-16H170.94a142.39,142.39,0,0,0-20.26-45A88.37,88.37,0,0,1,206.37,88ZM105.32,43A142.39,142.39,0,0,0,85.06,88H49.63A88.37,88.37,0,0,1,105.32,43ZM49.63,168H85.06a142.39,142.39,0,0,0,20.26,45A88.37,88.37,0,0,1,49.63,168Zm101.05,45a142.39,142.39,0,0,0,20.26-45h35.43A88.37,88.37,0,0,1,150.68,213Z"></path></svg>';

function cardHTML(f, n) {
  const idx   = String(n).padStart(2, "0");
  const tier1 = (f.priority || 0) >= 8;
  // company HQ from the bot, else fall back to the first matched role's location
  const loc   = f.location || (f.roles && f.roles[0] && f.roles[0].location) || "";
  const roles = (f.roles || []).map((r) =>
    `<a class="role" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}` +
    (r.location ? `<span class="role-loc"> · ${esc(r.location)}</span>` : "") + `</a>`).join("");
  const founders = (f.founders || []).map((nm) =>
    `<a class="founder" href="${esc(founderUrl(nm, f.company))}" target="_blank" rel="noopener" ` +
    `title="Find ${esc(nm)} on LinkedIn">${esc(nm)}${LI_SVG}</a>`).join("");
  const outreach = `<div class="outreach">
        <a class="ol" href="${esc(siteUrl(f.company))}" target="_blank" rel="noopener">${WEB_SVG}Website</a>
        <a class="ol" href="${esc(linkedinUrl(f.company))}" target="_blank" rel="noopener">${LI_SVG}Company</a>
        ${founders ? `<span class="ol-lbl">Founders</span>${founders}` : ""}
      </div>`;
  return `<article class="raise">
      <div class="raise-top">
        <span class="idx">${idx}</span>
        ${tier1 ? '<span class="badge t1">Tier-1 VC</span>' : ""}
        <span class="src">${esc(f.source || "")} · ${esc(fmtDate(f.first_seen))}</span>
      </div>
      <a class="raise-co" href="${esc(linkedinUrl(f.company))}" target="_blank" rel="noopener" title="Open on LinkedIn">${esc(f.company)}</a>
      <div class="raise-highlight">
        <span class="hl hl-amt">${esc(f.amount || "Undisclosed")}</span>
        ${loc ? `<span class="hl hl-loc">${PIN_SVG}${esc(loc)}</span>` : ""}
      </div>
      <div class="raise-meta">${esc(f.stage || "—")}<span class="sep">/</span>${esc(f.investors || "—")}</div>
      ${roles ? `<div class="roles"><span class="roles-lbl">Open design roles</span>${roles}</div>`
              : `<div class="roles none">No design roles posted yet — DM the founder.</div>`}
      ${outreach}
      ${f.url ? `<a class="read" href="${esc(f.url)}" target="_blank" rel="noopener">Read article →</a>` : ""}
    </article>`;
}

let DATA = [];                                   // last fetched funding records
let rsort = localStorage.getItem("raisedSort") || "new";

// location shown on a card: company HQ, else first matched role's location
function locOf(f) { return f.location || (f.roles && f.roles[0] && f.roles[0].location) || ""; }
// "$24.0M" → 24, "$1.5B" → 1500, "Undisclosed" → -1 (for Amount sort)
function amtNum(a) {
  const m = (a || "").match(/\$?\s*([\d.]+)\s*([MB])/i);
  if (!m) return -1;
  return parseFloat(m[1]) * (m[2].toUpperCase() === "B" ? 1000 : 1);
}
const byNew = (a, b) => (b.first_seen || "").localeCompare(a.first_seen || "");
const SORTERS = {
  new: byNew,
  amount: (a, b) => amtNum(b.amount) - amtNum(a.amount) || byNew(a, b),
  loc: (a, b) => {                                // located first, then A–Z, then newest
    const la = locOf(a), lb = locOf(b);
    if (!la !== !lb) return la ? -1 : 1;
    return la.localeCompare(lb) || byNew(a, b);
  },
};

function render(data) { DATA = Array.isArray(data) ? data : []; draw(); }

function draw() {
  const live = DATA
    .filter((f) => f.status !== "dismissed" && isSF(f))   // San Francisco / Bay Area only
    .sort(SORTERS[rsort] || byNew);

  $("#raisedCount").textContent = live.length;
  $("#statRaises").textContent  = live.length;
  $("#statRaises2").textContent = live.length;
  $("#status").textContent = live.length
    ? "Updated " + new Date().toLocaleTimeString()
    : "No data yet";

  const feed = $("#feed");
  if (!live.length) {
    feed.innerHTML = '<div class="feed-empty">No San Francisco / Bay Area raises yet. ' +
      'Location is detected best-effort from the headline, so this fills in as new SF raises come through.</div>';
    return;
  }
  feed.innerHTML = live.map((f, i) => cardHTML(f, i + 1)).join("");
}

function load() {
  fetch("./funding.json?_=" + Date.now())
    .then((r) => (r.ok ? r.json() : []))
    .then(render)
    .catch(() => { $("#status").textContent = "No data yet"; $("#empty").textContent = "Couldn't load funding data."; });
}

/* ── Column / List view toggle (persisted, independent of the board) ── */
let view = localStorage.getItem("raisedView") || "cols";
function applyView() {
  if (!["cols", "list"].includes(view)) view = "cols";
  $("#feed").className = "feed " + view;
  $$('[data-rview]').forEach((b) => b.classList.toggle("is-on", b.dataset.rview === view));
}
$$('[data-rview]').forEach((b) => b.addEventListener("click", () => {
  view = b.dataset.rview; localStorage.setItem("raisedView", view); applyView();
}));

/* ── Sort by (Newest / Amount / Location), persisted ── */
function applySort() {
  if (!SORTERS[rsort]) rsort = "new";
  $$('[data-rsort]').forEach((b) => b.classList.toggle("is-on", b.dataset.rsort === rsort));
}
$$('[data-rsort]').forEach((b) => b.addEventListener("click", () => {
  rsort = b.dataset.rsort; localStorage.setItem("raisedSort", rsort); applySort(); draw();
}));

/* ── Mirror the board's section counts on the shared top nav. Reads the
   same localStorage marks/removed so the numbers match index.html.
   (Bucket rule kept in sync with bucket() in app.js.) ── */
function navCounts() {
  let marks = {}, trash = new Set();
  try { marks = JSON.parse(localStorage.getItem("marks") || "{}"); } catch {}
  try { trash = new Set(JSON.parse(localStorage.getItem("trash") || "[]")); } catch {}
  const NEW = 864e5, now = Date.now();
  fetch("./jobs.json?_=" + Date.now()).then((r) => (r.ok ? r.json() : [])).then((JOBS) => {
    const c = { new: 0, notapplied: 0, app: 0, trash: trash.size };
    (Array.isArray(JOBS) ? JOBS : []).forEach((j) => {
      if (trash.has(j.id)) return;
      if (marks[j.id] === "done" || j.status === "applied") c.app++;
      else { const age = now - new Date(j.first_seen).getTime(); age <= NEW ? c.new++ : c.notapplied++; }
    });
    Object.entries(c).forEach(([k, v]) =>
      document.querySelectorAll(`[data-count="${k}"]`).forEach((e) => (e.textContent = v)));
  }).catch(() => {});
}

applySort();
applyView();
navCounts();
load();
setInterval(() => { load(); navCounts(); }, 60000);   // live: silent refresh every 60s
