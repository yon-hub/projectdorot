// Intrinsic Ground Truth — UI. Vanilla ES module, no build step.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n, d = 0) => n == null ? "—" : Number(n).toFixed(d);
const view = $("#view");
let TAX = null; let STATUS = null;

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, { headers: { "content-type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}
function toast(msg, err = false) {
  const t = document.createElement("div"); t.className = "toast" + (err ? " err" : ""); t.textContent = msg;
  $("#toasts").appendChild(t); setTimeout(() => t.remove(), err ? 6000 : 3200);
}
const chip = (txt, cls = "") => `<span class="chip ${cls}">${esc(txt)}</span>`;
const stageChip = (s) => chip(s || "unread", `chip-${s || "unread"}`);
const confChip = (c) => c === "unread" ? chip("unread", "chip-unread") : chip(`conf ${c}`, `chip-${c}`);
const delta = (d) => d == null || d === 0 ? `<span class="delta muted">·</span>` : `<span class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(d)}</span>`;
function opBar(c, total) {
  if (!c) return `<div class="bar"></div>`;
  return `<div class="bar-row"><div class="bar" title="adoption ${c.adoption} · pressure ${c.pressure} · openness ${c.openness}"><span class="adopt" style="width:${c.adoption}%"></span><span class="press" style="width:${c.pressure}%"></span><span class="open" style="width:${c.openness}%"></span></div><span class="num">${fmt(total)}</span></div>`;
}
function fitBar(total, grade) { return `<div class="bar-row"><div class="bar"><span class="fit" style="width:${total || 0}%"></span></div><span class="num">${fmt(total)}</span> ${grade ? chip(grade, `chip-${grade}`) : ""}</div>`; }
function postureBar(c) { if (!c) return "—"; return c.posture_stage === "unread" ? chip("unread", "chip-unread") : `<div class="bar-row"><div class="bar"><span class="posture" style="width:${c.posture}%"></span></div><span class="num">${fmt(c.posture)}</span> ${chip(c.posture_stage)}</div>`; }

// ---------------------------------------------------------------- routing
const routes = { week: renderWeek, operators: renderOperators, sponsors: renderSponsors, join: renderJoin, model: renderModel };
async function route() {
  const hash = location.hash.replace(/^#\/?/, "").split("?")[0] || "week";
  const [name, arg] = hash.split("/");
  // Deep links: #/operator/12 or #/sponsor/7 open the account over its map.
  if ((name === "operator" || name === "sponsor") && arg) {
    const list = name === "operator" ? "operators" : "sponsors";
    $$("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === list));
    if (!view.dataset.rendered || view.dataset.rendered !== list) { view.innerHTML = `<div class="empty"><p>Loading…</p></div>`; await routes[list](); view.dataset.rendered = list; }
    return openDrawer(name, Number(arg));
  }
  $$("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === name));
  view.innerHTML = `<div class="empty"><p>Loading…</p></div>`;
  view.dataset.rendered = name;
  try { await (routes[name] || renderWeek)(arg); } catch (e) { view.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
}
window.addEventListener("hashchange", route);

async function boot() {
  [TAX, STATUS] = await Promise.all([api("/taxonomy"), api("/status")]);
  const pill = $("#agent-pill");
  pill.textContent = STATUS.agent ? `agent on · ${STATUS.model}` : "agent off · no API key";
  pill.className = "pill " + (STATUS.agent ? "pill-on" : "pill-off");
  pill.title = STATUS.agent ? "The reader can scan operators and sponsors." : "Set ANTHROPIC_API_KEY in the server environment to enable scans.";
  setupSearch();
  route();
}

// ---------------------------------------------------------------- This week
async function renderWeek() {
  const days = Number(new URLSearchParams(location.hash.split("?")[1]).get("days") || 7);
  const [w, unreviewed, briefs] = await Promise.all([api(`/week?days=${days}`), api("/signals?review_status=unreviewed&limit=50"), api("/briefs")]);
  const c = w.counts;
  view.innerHTML = `
    <div class="page-head">
      <div><div class="eyebrow">Week of ${esc(w.since)} · ${days}-day window</div><h1>What moved <em>this week?</em></h1>
      <p class="lede">The pipeline question is no longer "who is next on the list". It is which operators crossed a threshold, which sponsor changed posture, and which subsector is starting to tip. Every insight below ends in a named action for a named account.</p></div>
      <div style="display:flex;gap:.5rem;align-items:center"><select id="days" class="btn"><option value="7" ${days === 7 ? "selected" : ""}>7 days</option><option value="14" ${days === 14 ? "selected" : ""}>14 days</option><option value="30" ${days === 30 ? "selected" : ""}>30 days</option></select>
      <button class="btn" id="regen">Regenerate actions</button><button class="btn btn-primary" id="brief" ${STATUS.agent ? "" : "disabled title='Set ANTHROPIC_API_KEY to write briefs'"}>Write the brief</button></div>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-n">${c.operators_read}<small class="muted" style="font-size:1rem">/${c.operators}</small></div><div class="stat-l">operators read</div><div class="stat-sub">placed on the front</div></div>
      <div class="stat"><div class="stat-n">${c.sponsors}</div><div class="stat-l">sponsors mapped</div><div class="stat-sub">${c.ownership_links} ownership links</div></div>
      <div class="stat"><div class="stat-n">${c.signals_window}</div><div class="stat-l">new signals</div><div class="stat-sub">${c.signals_total} total on file</div></div>
      <div class="stat"><div class="stat-n">${c.unreviewed}</div><div class="stat-l">awaiting review</div><div class="stat-sub">agent-found, human decides</div></div>
      <div class="stat"><div class="stat-n">${c.open_actions}</div><div class="stat-l">open actions</div><div class="stat-sub">${c.scans} agent reads run</div></div>
    </div>
    ${briefs[0]?.narrative ? `<div class="card" style="margin-bottom:1.2rem"><h3>Latest brief · ${esc(briefs[0].created_at.slice(0, 10))}</h3><p style="font-family:var(--serif);font-size:1.05rem;line-height:1.55">${esc(briefs[0].narrative)}</p></div>` : ""}
    <div class="grid grid-2">
      <div>
        <h3>Action queue · top ${Math.min(25, w.actions.length)} of ${c.open_actions}</h3>
        <div id="actions">${w.actions.length ? w.actions.map(actionCard).join("") : empty("No open actions. Add a signal or run a read.")}</div>
        <p class="small muted" style="margin-top:.4rem"><a href="#/operators">All operators →</a> · <a href="#/sponsors">All sponsors →</a></p>
      </div>
      <div>
        <div class="card"><h3>Movers</h3>
          ${w.movers.length ? w.movers.slice(0, 20).map((m) => `<div class="mover" data-open="${m.entity_type}:${m.entity_id}"><span class="k">${m.entity_type === "operator" ? "OP" : "PE"}</span><span><b>${esc(m.name)}</b><br><span class="small muted">${m.stage_from && m.stage_from !== m.stage_to ? esc(m.stage_from) + " → " : ""}${esc(m.stage_to)} · +${m.new_signals} signal${m.new_signals === 1 ? "" : "s"}</span></span><span class="num">${m.from ?? "—"} → ${m.to}</span>${delta(m.delta)}</div>`).join("")
            : empty("Nothing moved in this window. The map is a baseline until signals arrive — add one, or run a read.")}
        </div>
        <div class="card"><h3>Awaiting review · ${unreviewed.length}</h3>
          ${unreviewed.length ? unreviewed.slice(0, 12).map((s) => signalRow(s, { showEntity: true })).join("") : `<p class="small muted">Signals the reader finds land here until you accept or dismiss them. Dismissed signals stop counting.</p>`}
        </div>
        <div class="card"><h3>The front by subsector</h3>
          ${w.front.filter((f) => f.n >= 2).slice(0, 18).map((f) => `<div class="front-row"><div class="nm">${esc(f.subsector || "(unclassified)")}<span>${esc(f.sector)} · ${f.n} operators</span></div>${stack(f)}<span class="num small" title="avg adoption of read operators">${f.avg_adoption ?? "—"}</span><span class="num small" title="avg moment (pressure + openness)">${f.avg_moment ?? "—"}</span></div>`).join("")}
          <div class="legend"><span><i style="background:#cbc4b6"></i>untouched</span><span><i style="background:var(--gold)"></i>experimenting</span><span><i style="background:var(--clay)"></i>deploying</span><span><i style="background:var(--indigo)"></i>compounding</span><span><i class="s-unread" style="background:#e6e1d6"></i>unread</span></div>
        </div>
      </div>
    </div>`;
  $("#days").onchange = (e) => { location.hash = `#/week?days=${e.target.value}`; };
  $("#regen").onclick = async () => { const r = await api("/actions/regenerate", { method: "POST" }); toast(`Actions: ${r.created} new, ${r.updated} refreshed, ${r.retired} retired`); route(); };
  $("#brief").onclick = async (e) => { busy(e.target, true); try { const r = await api("/brief", { method: "POST" }); if (r.error) toast(r.error, true); else toast("Brief written"); route(); } catch (err) { toast(err.message, true); } finally { busy(e.target, false); } };
  bindCommon(view);
}
function stack(f) {
  const parts = ["unread", "untouched", "experimenting", "deploying", "compounding"].map((k) => `<span class="s-${k}" style="width:${(f[k] / f.n) * 100}%" title="${k}: ${f[k]}"></span>`).join("");
  return `<div class="stack">${parts}</div>`;
}
function empty(msg) { return `<div class="empty"><p>${esc(msg)}</p></div>`; }
function busy(btn, on) { if (!btn) return; btn.disabled = on; if (on) { btn.dataset.label = btn.innerHTML; btn.innerHTML = `<span class="spinner"></span>working…`; } else btn.innerHTML = btn.dataset.label || btn.innerHTML; }

function actionCard(a) {
  return `<div class="action kind-${esc(a.kind)}" data-action="${a.id}">
    <div class="action-head"><span class="prio" title="priority">${a.priority}</span><span class="headline" data-open="${a.entity_type}:${a.entity_id}">${esc(a.headline)}</span>${a.play ? chip(a.play, "chip-play") : ""}${a.confidence ? confChip(a.confidence) : ""}</div>
    <dl class="action-body">
      ${a.message_angle ? `<dt>Message</dt><dd>${esc(a.message_angle)}</dd>` : ""}
      ${a.trusted_path ? `<dt>Trusted path</dt><dd>${esc(a.trusted_path)}</dd>` : ""}
      ${a.timing ? `<dt>Timing</dt><dd>${esc(a.timing)}</dd>` : ""}
      ${a.reasoning ? `<dt>Why</dt><dd class="muted">${esc(a.reasoning)}${a.evidence?.length ? ` <span class="small">(${a.evidence.length} signal${a.evidence.length === 1 ? "" : "s"})</span>` : ""}</dd>` : ""}
    </dl>
    <div class="action-foot">${a.status === "open" ? `<button class="btn btn-sm" data-act="done">Done</button><button class="btn btn-sm btn-ghost" data-act="dismissed">Dismiss</button>` : `<span class="chip">${esc(a.status)}</span> ${a.status !== "retired" ? `<button class="btn btn-sm btn-ghost" data-act="open">Reopen</button>` : ""}`}<span class="small muted" style="margin-left:auto">${esc(a.kind.replace(/_/g, " "))} · ${esc((a.updated_at || "").slice(0, 10))}</span></div>
  </div>`;
}

function bindCommon(root) {
  root.onclick = async (e) => {
    const open = e.target.closest("[data-open]");
    if (open && !e.target.closest("[data-act]")) { const [t, id] = open.dataset.open.split(":"); return openDrawer(t, Number(id)); }
    const act = e.target.closest("[data-act]");
    if (act) {
      const card = act.closest("[data-action]");
      try { await api(`/actions/${card.dataset.action}`, { method: "PATCH", body: { status: act.dataset.act } }); toast(`Action marked ${act.dataset.act}`); card.style.opacity = .4; setTimeout(() => card.remove(), 400); } catch (err) { toast(err.message, true); }
      return;
    }
    const rev = e.target.closest("[data-review]");
    if (rev) {
      const id = rev.closest("[data-signal]").dataset.signal;
      try { await api(`/signals/${id}`, { method: "PATCH", body: { review_status: rev.dataset.review } }); toast(`Signal ${rev.dataset.review}`); refreshCurrent(); } catch (err) { toast(err.message, true); }
      return;
    }
    const del = e.target.closest("[data-delete-signal]");
    if (del) {
      if (!confirm("Delete this signal permanently? (Dismissing keeps the record.)")) return;
      try { await api(`/signals/${del.dataset.deleteSignal}`, { method: "DELETE" }); toast("Signal deleted"); refreshCurrent(); } catch (err) { toast(err.message, true); }
    }
  };
}
let currentDrawer = null;
function refreshCurrent() { if (currentDrawer) openDrawer(currentDrawer.type, currentDrawer.id, currentDrawer.tab); else route(); }

function signalRow(s, { showEntity = false, showControls = true } = {}) {
  const src = s.source_type === "agent" ? chip("agent", "chip-agent") : s.source_type === "import" ? chip("from sheet", "chip-import") : chip("manual", "chip-manual");
  const pts = s.points != null ? `<span class="pts muted" title="weighted points">${s.points > 0 ? "+" : ""}${s.points}</span>` : "";
  return `<div class="signal" data-signal="${s.id}">
    <div>
      <div class="t">${showEntity ? `<a href="#" data-open="${s.entity_type}:${s.entity_id}" class="muted">${esc(s.entity_name)}</a> · ` : ""}${esc(s.title)}</div>
      ${s.detail ? `<div class="d">${esc(s.detail)}</div>` : ""}
      <div class="m">${chip(s.dimension)}${chip(s.category.replace(/_/g, " "))}${chip(`str ${s.strength}${s.direction < 0 ? " ↓" : ""}`)}${confChip(s.confidence)}${src}${s.review_status !== "accepted" ? chip(s.review_status, `chip-${s.review_status}`) : ""}<span class="small muted">${esc(s.observed_at)}</span>${s.source_url ? `<a href="${esc(s.source_url)}" target="_blank" rel="noopener">source ↗</a>` : ""}${pts}</div>
    </div>
    ${showControls ? `<div class="controls">${s.review_status !== "accepted" ? `<button class="btn btn-sm" data-review="accepted">Accept</button>` : ""}${s.review_status !== "dismissed" ? `<button class="btn btn-sm btn-ghost" data-review="dismissed">Dismiss</button>` : `<button class="btn btn-sm btn-ghost" data-review="accepted">Restore</button>`}${s.source_type === "manual" ? `<button class="btn btn-sm btn-ghost" data-delete-signal="${s.id}" title="delete">×</button>` : ""}</div>` : ""}
  </div>`;
}

// ---------------------------------------------------------------- Operators
let opCache = null;
async function renderOperators() {
  opCache = await api("/operators");
  const sectors = [...new Set(opCache.map((o) => o.sector).filter(Boolean))].sort();
  const regions = [...new Set(opCache.map((o) => o.region).filter(Boolean))].sort();
  view.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Operator map · ${opCache.length} accounts</div><h1>AI Penetration <em>Index</em></h1>
    <p class="lede">Where each operator sits on the adoption arc, how much pressure it is under, and what openness it is emitting. Adoption 0–40, pressure 0–30, openness 0–30. "Unread" means the engine has no signals yet — the sheet's fit score is not a market read.</p></div>
    <button class="btn" id="add-op">+ Add operator</button></div>
    <div class="toolbar">
      <input id="f-q" placeholder="Filter by name, sub-sector, HQ…">
      <select id="f-sector"><option value="">All sectors</option>${sectors.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
      <select id="f-region"><option value="">All regions</option>${regions.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
      <select id="f-tier"><option value="">All tiers</option><option>T1</option><option>T2</option><option>T3</option></select>
      <select id="f-stage"><option value="">All stages</option><option value="read">Read (any stage)</option><option>unread</option><option>untouched</option><option>experimenting</option><option>deploying</option><option>compounding</option></select>
      <label class="small"><input type="checkbox" id="f-pe"> PE-backed</label>
      <span class="count" id="count"></span>
    </div>
    <div class="table-wrap"><table id="op-table"><thead><tr>
      <th data-sort="name">Operator</th><th data-sort="sector">Sector</th><th data-sort="hq">HQ</th><th data-sort="tier">Tier</th><th data-sort="stage">Stage</th><th data-sort="score" class="sorted">Index</th><th data-sort="delta_7d">Δ 7d</th><th data-sort="signal_count">Signals</th><th data-sort="last_signal">Last signal</th><th data-sort="pipeline_status">Pipeline</th><th data-sort="open_actions">Actions</th>
    </tr></thead><tbody></tbody></table></div>
    <div class="legend"><span><i style="background:var(--adopt)"></i>adoption</span><span><i style="background:var(--press)"></i>pressure</span><span><i style="background:var(--open)"></i>openness</span></div>`;
  let sort = { key: "score", dir: -1 };
  const draw = () => {
    const q = $("#f-q").value.toLowerCase(), sec = $("#f-sector").value, reg = $("#f-region").value, tier = $("#f-tier").value, stage = $("#f-stage").value, pe = $("#f-pe").checked;
    let rows = opCache.filter((o) => (!q || `${o.name} ${o.subsector} ${o.hq} ${o.sector}`.toLowerCase().includes(q)) && (!sec || o.sector === sec) && (!reg || o.region === reg) && (!tier || o.tier === tier) && (!stage || (stage === "read" ? o.stage !== "unread" : o.stage === stage)) && (!pe || o.pe_backed));
    rows.sort((a, b) => cmp(a[sort.key], b[sort.key]) * sort.dir);
    $("#count").textContent = `${rows.length} shown`;
    $("#op-table tbody").innerHTML = rows.slice(0, 400).map((o) => `<tr class="row" data-open="operator:${o.id}">
      <td class="name">${esc(o.name)}<span class="sub">${esc(o.subsector || "")}${o.pe_backed ? " · PE-backed" : ""}</span></td><td>${esc(o.sector || "")}</td><td>${esc(o.hq || "")}<span class="sub">${esc(o.region || "")}</span></td><td>${chip(o.tier || "—")}</td>
      <td>${stageChip(o.stage)}</td><td>${opBar(o.components, o.score)}</td><td>${delta(o.delta_7d)}</td><td class="num">${o.signal_count}${o.unreviewed ? ` <span class="chip chip-unreviewed" title="unreviewed">${o.unreviewed}</span>` : ""}</td><td class="small muted">${esc(o.last_signal || "—")}</td><td class="small">${esc(o.pipeline_status || "")}</td><td class="num">${o.open_actions || ""}</td></tr>`).join("");
  };
  $$("th[data-sort]").forEach((th) => th.onclick = () => { const k = th.dataset.sort; sort = { key: k, dir: sort.key === k ? -sort.dir : (k === "name" || k === "sector" || k === "hq" ? 1 : -1) }; $$("th").forEach((t) => t.classList.toggle("sorted", t === th)); draw(); });
  $$(".toolbar input, .toolbar select").forEach((el) => el.oninput = draw);
  $("#add-op").onclick = () => addEntityForm("operator");
  draw(); bindCommon(view);
}
function cmp(a, b) { if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1; return typeof a === "number" ? a - b : String(a).localeCompare(String(b)); }

// ---------------------------------------------------------------- Sponsors
async function renderSponsors() {
  const sps = await api("/sponsors");
  const regions = [...new Set(sps.map((o) => o.region).filter(Boolean))].sort();
  view.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Sponsor map · ${sps.length} firms</div><h1>Exit-Unlock Fit <em>and AI posture</em></h1>
    <p class="lede">The six-component Fit Score from the PE pipeline, now recomputed live from the model tab, plus an AI-posture read built from signals: value-creation language, operating-partner mandates, portfolio deployments, fund pressure. Play tags follow the sheet's rule: Exit-Unlock when the last close is 4+ years old and AUM is under $5B; Growth Client when they raised in the last two years.</p></div>
    <button class="btn" id="add-sp">+ Add sponsor</button></div>
    <div class="toolbar">
      <input id="f-q" placeholder="Filter by name, verticals, city…">
      <select id="f-region"><option value="">All regions</option>${regions.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
      <select id="f-grade"><option value="">All grades</option><option>A</option><option>B</option><option>C</option><option>D</option></select>
      <select id="f-play"><option value="">All plays</option><option>Exit-Unlock</option><option>Growth Client</option><option>Both</option></select>
      <label class="small"><input type="checkbox" id="f-links"> Has known portcos</label>
      <span class="count" id="count"></span></div>
    <div class="table-wrap"><table id="sp-table"><thead><tr>
      <th data-sort="name">Sponsor</th><th data-sort="region">Region</th><th data-sort="score" class="sorted">Fit</th><th data-sort="play">Play</th><th data-sort="posture">AI posture</th><th data-sort="fundraising_signal">Last close</th><th data-sort="aum_band">AUM</th><th data-sort="links">Portcos</th><th data-sort="momentum_band">Engagement</th><th data-sort="data_confidence">Data</th><th data-sort="open_actions">Actions</th>
    </tr></thead><tbody></tbody></table></div>`;
  for (const s of sps) s.posture = s.components?.posture ?? -1;
  let sort = { key: "score", dir: -1 };
  const draw = () => {
    const q = $("#f-q").value.toLowerCase(), reg = $("#f-region").value, grade = $("#f-grade").value, play = $("#f-play").value, links = $("#f-links").checked;
    let rows = sps.filter((s) => (!q || `${s.name} ${s.target_verticals} ${s.city}`.toLowerCase().includes(q)) && (!reg || s.region === reg) && (!grade || s.grade === grade) && (!play || s.play === play) && (!links || s.links > 0));
    rows.sort((a, b) => cmp(a[sort.key], b[sort.key]) * sort.dir);
    $("#count").textContent = `${rows.length} shown`;
    $("#sp-table tbody").innerHTML = rows.map((s) => `<tr class="row" data-open="sponsor:${s.id}">
      <td class="name">${esc(s.name)}<span class="sub">${esc(s.city || "")}${s.state ? ", " + esc(s.state) : ""} · ${esc(s.fund_strategy || "")}${s.sheet_play && s.sheet_play !== s.play ? ` · <span title="the sheet tagged this ${esc(s.sheet_play)}">sheet: ${esc(s.sheet_play)}</span>` : ""}</span></td>
      <td>${esc(s.region || "")}<span class="sub">${esc(s.tier || "")}</span></td><td>${fitBar(s.score, s.grade)}</td><td>${chip(s.play || "—", "chip-play")}</td><td>${postureBar(s.components)}</td>
      <td class="small">${esc(s.fundraising_signal || "")}<span class="sub">${esc(s.latest_fund || "")}</span></td><td class="small">${esc(s.aum_band || "")}</td><td class="num">${s.links || ""}</td><td class="small">${esc(s.momentum_band || "")}</td><td>${confChip(s.data_confidence || "L")}</td><td class="num">${s.open_actions || ""}</td></tr>`).join("");
  };
  $$("th[data-sort]").forEach((th) => th.onclick = () => { const k = th.dataset.sort; sort = { key: k, dir: sort.key === k ? -sort.dir : (["name", "region", "play", "fundraising_signal", "aum_band", "momentum_band"].includes(k) ? 1 : -1) }; $$("th").forEach((t) => t.classList.toggle("sorted", t === th)); draw(); });
  $$(".toolbar input, .toolbar select").forEach((el) => el.oninput = draw);
  $("#add-sp").onclick = () => addEntityForm("sponsor");
  draw(); bindCommon(view);
}

// ---------------------------------------------------------------- The join
async function renderJoin() {
  const j = await api("/ownership");
  view.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">The join · ${j.sponsors.length} sponsors with known portfolio · ${j.unlinked_pe_backed.length} PE-backed operators without a named sponsor</div><h1>Sponsors <em>own</em> operators.</h1>
    <p class="lede">When both maps are visible at once the intersections nobody else can see appear: a high-pressure sponsor sitting on low-penetration portcos, a stuck fund whose longest-held asset has no AI story, a sponsor going AI-forward across a portfolio that has not caught up. Links come from the sheets, from agent reads, or from you.</p></div>
    <button class="btn" id="add-link">+ Link sponsor ↔ operator</button></div>
    <div class="grid grid-2">
      <div>${j.sponsors.length ? j.sponsors.map((s) => `<div class="join-card">
        <div class="join-head"><h2 data-open="sponsor:${s.id}">${esc(s.name)}</h2><div>${s.score ? fitBar(s.score.total, s.score.grade) : ""}</div></div>
        <div class="meta">${chip(s.score?.play || "—", "chip-play")}<span>${esc(s.region || "")}</span><span>AUM <b>${esc(s.aum_band || "?")}</b></span><span>last close <b>${esc(s.fundraising_signal || "?")}</b></span><span>posture <b>${esc(s.score?.components?.posture_stage || "unread")}</b></span></div>
        ${s.intersection ? `<div class="join-intersection">${esc(s.intersection)}</div>` : ""}
        ${s.portcos.map((p) => `<div class="portco" data-open="operator:${p.id}"><span><b>${esc(p.name)}</b> <span class="small muted">${esc(p.sector || "")}${p.hq ? " · " + esc(p.hq) : ""}${p.since ? " · since " + esc(p.since) : ""}</span></span>${opBar(p.score?.components, p.score?.total)}${stageChip(p.score?.stage)}<span class="small muted" title="${esc(p.link_source || "")}">link ${esc(p.link_confidence)}</span></div>`).join("")}
        <div class="small muted" style="margin-top:.5rem">Path: ${esc(s.intro_path || (s.target_poc ? "direct to " + s.target_poc : "not mapped"))}</div>
      </div>`).join("") : empty("No ownership links yet. Run a read on a sponsor to discover its portfolio, or link one by hand.")}</div>
      <div><div class="card"><h3>PE-backed, sponsor not yet named</h3><p class="small muted" style="margin-bottom:.6rem">The sheets flag these as PE-backed but do not say by whom. A read on the operator will usually name the sponsor and create the link.</p>
        ${j.unlinked_pe_backed.map((o) => `<div class="mover" data-open="operator:${o.id}"><span class="k">OP</span><span><b>${esc(o.name)}</b><br><span class="small muted">${esc(o.sector || "")} · ${esc(o.hq || "")}</span></span>${chip(o.tier || "")}<span></span></div>`).join("") || `<p class="small muted">None.</p>`}
      </div></div>
    </div>`;
  $("#add-link").onclick = () => linkForm();
  bindCommon(view);
}

async function linkForm(preset = {}) {
  const [ops, sps] = await Promise.all([opCache ? Promise.resolve(opCache) : api("/operators"), api("/sponsors")]);
  showDrawer(`<div class="drawer-head"><div><div class="eyebrow">The join</div><h2>Link a sponsor to an operator</h2></div><button class="btn btn-ghost" data-close>Close</button></div>
    <form class="inline card" id="link-form">
      <label class="span-2">Sponsor<select name="sponsor_id" required>${sps.sort((a, b) => a.name.localeCompare(b.name)).map((s) => `<option value="${s.id}" ${preset.sponsor_id === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
      <label class="span-2">Operator<select name="operator_id" required>${ops.slice().sort((a, b) => a.name.localeCompare(b.name)).map((o) => `<option value="${o.id}" ${preset.operator_id === o.id ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select></label>
      <label>Confidence<select name="confidence"><option>H</option><option selected>M</option><option>L</option></select></label>
      <label>Since (year)<input name="since" placeholder="2021"></label>
      <label class="span-2">Source<input name="source" placeholder="press release, PitchBook, conversation…"></label>
      <div class="span-all"><button class="btn btn-primary">Create link</button></div>
    </form>`);
  $("#link-form").onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await api("/ownership", { method: "POST", body: f }); toast("Linked"); closeDrawer(); route(); } catch (err) { toast(err.message, true); } };
}

// ---------------------------------------------------------------- Model
async function renderModel() {
  const w = await api("/weights");
  const group = (k) => k.startsWith("aum:") ? "1 · AUM fit" : k.startsWith("sig:") ? "2 · Fundraising / zombie signal" : k.startsWith("vert:") ? "3 · Vertical fit" : k.startsWith("ops:") ? "4 · Operational engagement" : k.startsWith("reg:") ? "5 · Region" : k.startsWith("mom:") ? "6 · Engagement momentum" : k.startsWith("grade_") ? "Grade bands" : k.startsWith("conf_") ? "Signal confidence multipliers" : k.startsWith("decay_") ? "Signal decay by age" : k.startsWith("stage_") ? "Stage thresholds (adoption score)" : k.endsWith("_max") ? "Ceilings" : k.includes("per_point") ? "Points per weighted signal point" : "Other";
  const table = (model, rows) => { let last = null; return rows.map((r) => { const g = group(r.key); const head = g !== last ? `<div class="grp">${esc(g)}</div>` : ""; last = g; return `${head}<span>${esc(r.label || r.key)}<br><span class="small muted num">${esc(r.key)}</span></span><input type="number" step="any" data-model="${model}" data-key="${esc(r.key)}" value="${r.value}"><span class="def">default ${r.default}</span>`; }).join(""); };
  view.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Scoring model · adjustable</div><h1>How the engine <em>scores</em>.</h1>
    <p class="lede">Every number in the maps is a deterministic function of stored signals and these weights. Change a weight and every entity re-scores; the sheet's Exit-Unlock model is reproduced exactly at the defaults. A signal's contribution is <span class="num">direction × strength × confidence multiplier × decay</span>.</p></div>
    <div style="display:flex;gap:.5rem"><button class="btn" id="reset-op">Reset operator model</button><button class="btn" id="reset-sp">Reset sponsor model</button><button class="btn btn-primary" id="save">Save &amp; re-score</button></div></div>
    <div class="grid grid-2">
      <div class="card"><h3>Operators · AI Penetration Index</h3><div class="weights">${table("operator", w.operator)}</div></div>
      <div class="card"><h3>Sponsors · Exit-Unlock Fit + posture</h3><div class="weights">${table("sponsor", w.sponsor)}</div>
        <p class="small muted" style="margin-top:.8rem">Play rule (fixed): Exit-Unlock when last close is 4+ years ago and AUM under $5B. Growth Client when raised within ~2 years. Otherwise Both — qualify on the call.</p></div>
    </div>
    <div class="card" style="margin-top:1.2rem"><h3>Signal taxonomy</h3><p class="small muted" style="margin-bottom:.6rem">The reader and the manual form can only file signals under these categories. Each one is tied to a dimension of a score, so collecting it always moves a decision.</p>
      <div class="grid grid-2">${["operator", "sponsor"].map((t) => `<div><h3>${t}s</h3>${Object.entries(TAX.dimensions[t]).map(([dk, d]) => `<p style="margin:.5rem 0 .2rem"><b>${esc(d.label)}</b> <span class="small muted">${esc(d.help)}</span></p>${Object.entries(d.categories).map(([ck, c]) => `<div class="small" style="padding:.15rem 0 .15rem .8rem">${esc(c.label)} <span class="muted num">${esc(ck)} · ${c.strength}${c.direction < 0 ? " ↓" : ""}</span></div>`).join("")}`).join("")}</div>`).join("")}</div></div>`;
  $("#save").onclick = async (e) => { busy(e.target, true); const updates = $$(".weights input").map((i) => ({ model: i.dataset.model, key: i.dataset.key, value: Number(i.value) })); try { const r = await api("/weights", { method: "PATCH", body: { updates } }); toast(`Saved · ${r.rescored} entities re-scored`); } catch (err) { toast(err.message, true); } finally { busy(e.target, false); } };
  $("#reset-op").onclick = async () => { await api("/weights", { method: "PATCH", body: { reset: "operator" } }); toast("Operator model reset"); route(); };
  $("#reset-sp").onclick = async () => { await api("/weights", { method: "PATCH", body: { reset: "sponsor" } }); toast("Sponsor model reset"); route(); };
}

// ---------------------------------------------------------------- Drawer (entity detail)
function showDrawer(html) { $("#drawer-panel").innerHTML = html; $("#drawer").hidden = false; document.body.style.overflow = "hidden"; }
function closeDrawer() {
  $("#drawer").hidden = true; document.body.style.overflow = ""; currentDrawer = null;
  if (/^#\/(operator|sponsor)\//.test(location.hash)) history.replaceState(null, "", `#/${view.dataset.rendered || "week"}`);
}
$("#drawer").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeDrawer(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

async function openDrawer(type, id, tab = "signals") {
  currentDrawer = { type, id, tab };
  if (location.hash !== `#/${type}/${id}`) history.replaceState(null, "", `#/${type}/${id}`);
  const d = await api(`/${type === "operator" ? "operators" : "sponsors"}/${id}`);
  const e = d.entity, sc = d.live, c = sc.components;
  const openActions = d.actions.filter((a) => a.status === "open");
  const pointsById = Object.fromEntries((c.contributions || []).map((x) => [x.id, x.points]));
  const signals = d.signals.map((s) => ({ ...s, points: pointsById[s.id] }));
  const head = type === "operator"
    ? `<div class="meta"><span>${esc(e.sector || "")}${e.subsector ? " · " + esc(e.subsector) : ""}</span><span>${esc(e.hq || "")}</span><span>${esc(e.region || "")}</span>${e.revenue_est ? `<span>rev <b>${esc(e.revenue_est)}</b></span>` : ""}${e.employees ? `<span>emp <b>${esc(e.employees)}</b></span>` : ""}${chip(e.tier || "—")}${e.pe_backed ? chip("PE-backed") : ""}${e.website ? `<a href="${esc(e.website.startsWith("http") ? e.website : "https://" + e.website)}" target="_blank" rel="noopener" style="color:var(--clay)">site ↗</a>` : ""}</div>`
    : `<div class="meta"><span>${esc(e.city || "")}${e.state ? ", " + esc(e.state) : ""}</span><span>${esc(e.region || "")}</span><span>${esc(e.fund_strategy || "")}</span><span>AUM <b>${esc(e.aum_est || e.aum_band || "?")}</b></span><span>latest fund <b>${esc(e.latest_fund || "?")}</b></span>${chip(e.tier || "—")}${confChip(e.data_confidence || "L")}</div>`;
  const scoreCard = type === "operator"
    ? `<div class="score-card"><div><div class="score-big">${fmt(sc.total)}<small>/100</small></div>${stageChip(sc.stage)} ${confChip(sc.confidence)}</div>
        <div class="comp"><span class="lbl">adoption</span><div class="bar"><span class="adopt" style="width:${(c.adoption / 40) * 100}%"></span></div><span class="num">${c.adoption}/40</span>
        <span class="lbl">pressure</span><div class="bar"><span class="press" style="width:${(c.pressure / 30) * 100}%"></span></div><span class="num">${c.pressure}/30</span>
        <span class="lbl">openness</span><div class="bar"><span class="open" style="width:${(c.openness / 30) * 100}%"></span></div><span class="num">${c.openness}/30</span></div></div>
        <div class="meta" style="margin-top:.7rem"><span>play <b>${esc(sc.play)}</b></span><span>moment <b>${c.moment}/60</b></span><span>${c.signal_count} signals</span>${c.sponsor ? `<span>owned by <b>${esc(c.sponsor)}</b></span>` : ""}<span>pipeline <b>${esc(e.pipeline_status || "—")}</b></span>${e.warm_intro_via ? `<span>warm path <b>${esc(e.warm_intro_via)}</b></span>` : ""}</div>`
    : `<div class="score-card"><div><div class="score-big">${fmt(sc.total)}<small>/100</small></div>${chip(sc.grade, `chip-${sc.grade}`)} ${chip(sc.play, "chip-play")}</div>
        <div class="comp">${Object.entries(c.fit_parts).map(([k, v]) => `<span class="lbl">${k}</span><div class="bar"><span class="fit" style="width:${(v.points / 22) * 100}%"></span></div><span class="num" title="${esc(v.band)}">${v.points}</span>`).join("")}</div></div>
        <div class="meta" style="margin-top:.7rem"><span>AI posture <b>${esc(c.posture_stage)}</b> ${c.posture_stage !== "unread" ? `(${c.posture}/100)` : ""}</span><span>exit pressure signals <b>${c.exit_pressure}</b></span><span>${c.signal_count} signals</span><span>${c.portcos} known portco${c.portcos === 1 ? "" : "s"}</span>${c.sheet_play && c.sheet_play !== c.play ? `<span class="tag-note">sheet tagged ${esc(c.sheet_play)} (${c.sheet_fit})</span>` : ""}${e.intro_path ? `<span>path <b>${esc(e.intro_path)}</b></span>` : ""}${e.target_poc ? `<span>POC <b>${esc(e.target_poc)}</b></span>` : ""}</div>
        ${e.hook ? `<p class="small" style="margin-top:.5rem"><b>Hook:</b> ${esc(e.hook)}</p>` : ""}`;
  const lastScan = d.scans[0];
  showDrawer(`
    <div class="drawer-head"><div><div class="eyebrow">${type}${e.source && e.source !== "import" ? " · added by " + esc(e.source) : ""}</div><h2>${esc(e.name)}</h2>${head}</div>
      <div style="display:flex;gap:.4rem;align-items:flex-start"><button class="btn btn-clay" id="scan-btn" ${STATUS.agent ? "" : `disabled title="Set ANTHROPIC_API_KEY on the server to enable the reader"`}>Run a read</button><button class="btn btn-ghost" data-close>Close</button></div></div>
    <div class="card">${scoreCard}${d.history.length > 1 ? `<div style="margin-top:.8rem"><h3>Score history · ${d.history.length} computations</h3><div class="history">${d.history.slice(-40).map((h) => `<span style="height:${Math.max(4, h.total)}%" title="${esc(h.computed_at)} · ${h.total} · ${esc(h.stage || h.grade || "")}"></span>`).join("")}</div></div>` : ""}</div>
    ${lastScan ? `<div class="notice notice-indigo" style="margin-top:.8rem"><b>Last read</b> · ${esc(lastScan.started_at.slice(0, 16))} · ${esc(lastScan.status)}${lastScan.signals_found ? ` · ${lastScan.signals_found} signals` : ""}${lastScan.error ? ` · <span style="color:var(--red)">${esc(lastScan.error)}</span>` : ""}<br>${esc(lastScan.summary || "")} <a href="#" id="show-scan" class="small" style="color:var(--clay)">memo ↗</a><div id="scan-memo" hidden></div></div>` : ""}
    <div class="tabs">${[["signals", `Signals (${signals.filter((s) => s.review_status !== "dismissed").length})`], ["actions", `Actions (${openActions.length})`], ["add", "+ Add signal"], ["links", type === "operator" ? `Sponsor (${d.links.length})` : `Portfolio (${d.links.length})`], ["contacts", `Contacts (${d.contacts.length})`], ["edit", "Edit"]].map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? "active" : ""}">${l}</button>`).join("")}</div>
    <div id="tab-body"></div>`);
  const body = $("#tab-body");
  const tabs = {
    signals: () => signals.length ? `<div class="card" style="padding:0">${signals.map((s) => signalRow(s)).join("")}</div>` : empty("No signals yet. This entity is unread — the score is a baseline, not a market read. Run a read or add what you know."),
    actions: () => d.actions.length ? d.actions.map(actionCard).join("") : empty("No actions derived for this entity."),
    add: () => addSignalForm(type, id),
    links: () => linksTab(type, id, d),
    contacts: () => d.contacts.length ? `<div class="card">${d.contacts.map((ct) => `<div class="contact"><span class="nm">${esc(ct.name)}</span><span class="muted">${esc(ct.title || "")}</span>${ct.email ? `<a href="mailto:${esc(ct.email)}">${esc(ct.email)}</a>` : ""}${ct.linkedin ? `<a href="${esc(ct.linkedin)}" target="_blank" rel="noopener">LinkedIn ↗</a>` : ""}${ct.status ? `<span class="small muted" style="margin-left:auto">${esc(ct.status)}</span>` : ""}</div>`).join("")}</div>` : empty("No contacts on file."),
    edit: () => editForm(type, e),
  };
  const showTab = (k) => { currentDrawer.tab = k; $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === k)); body.innerHTML = tabs[k](); wireTab(k, type, id, d); };
  $$(".tabs button").forEach((b) => b.onclick = () => showTab(b.dataset.tab));
  showTab(tab);
  bindCommon($("#drawer-panel"));
  $("#scan-btn").onclick = async (ev) => {
    busy(ev.target, true); toast(`Reading ${e.name} — this takes a minute or two…`);
    try { const r = await api("/scan", { method: "POST", body: { entity_type: type, entity_id: id } }); if (r.status === "error") toast(r.error, true); else toast(`Read complete: ${r.signals_found} signals found${r.links?.length ? ", " + r.links.length + " ownership link(s)" : ""}. Review them in Signals.`); openDrawer(type, id, "signals"); }
    catch (err) { toast(err.message, true); busy(ev.target, false); }
  };
  if (lastScan) $("#show-scan").onclick = async (ev) => { ev.preventDefault(); const box = $("#scan-memo"); if (!box.hidden) { box.hidden = true; return; } const s = await api(`/scans/${lastScan.id}`); box.hidden = false; box.innerHTML = `<div class="memo" style="margin-top:.6rem">${esc(s.raw?.memo || s.error || "(no memo)")}</div>${s.raw?.extraction?.open_questions?.length ? `<p class="small" style="margin-top:.5rem"><b>Verify before citing:</b> ${s.raw.extraction.open_questions.map(esc).join(" · ")}</p>` : ""}${s.usage ? `<p class="small muted" style="margin-top:.3rem">tokens — research: ${s.usage.research?.input_tokens ?? "?"} in / ${s.usage.research?.output_tokens ?? "?"} out · extraction: ${s.usage.extraction?.input_tokens ?? "?"} in / ${s.usage.extraction?.output_tokens ?? "?"} out</p>` : ""}`; };
}

function addSignalForm(type, id) {
  const dims = TAX.dimensions[type];
  return `<form class="inline card" id="sig-form">
    <label>Dimension<select name="dimension">${Object.entries(dims).map(([k, d]) => `<option value="${k}">${esc(d.label)}</option>`).join("")}</select></label>
    <label class="span-2">Category<select name="category"></select></label>
    <label>Strength (1–5)<input name="strength" type="number" min="1" max="5" value="3"></label>
    <label>Confidence<select name="confidence"><option value="H">H · primary source</option><option value="M" selected>M · reputable secondary</option><option value="L">L · inference</option></select></label>
    <label>Observed<input name="observed_at" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
    <label class="span-all">Title (specific: who, what, when)<input name="title" required placeholder="Posted Director of Automation, Columbus, Sep 2026"></label>
    <label class="span-all">Detail<textarea name="detail" rows="2" placeholder="What you saw and why it moves this dimension."></textarea></label>
    <label class="span-all">Source URL<input name="source_url" type="url" placeholder="https://"></label>
    <div class="span-all"><button class="btn btn-primary">Add signal</button> <span class="small muted">Manual signals are accepted immediately and re-score the entity.</span></div>
  </form>`;
}
function linksTab(type, id, d) {
  const rows = d.links.map((l) => type === "operator"
    ? `<div class="portco" data-open="sponsor:${l.id}"><span><b>${esc(l.name)}</b> <span class="small muted">${esc(l.source || "")}</span></span>${l.score ? fitBar(l.score.total, l.score.grade) : "—"}${chip(l.score?.play || "—", "chip-play")}<span class="small muted">link ${esc(l.confidence)}</span></div>`
    : `<div class="portco" data-open="operator:${l.id}"><span><b>${esc(l.name)}</b> <span class="small muted">${esc(l.sector || "")}${l.hq ? " · " + esc(l.hq) : ""}${l.since ? " · since " + esc(l.since) : ""}</span></span>${opBar(l.score?.components, l.score?.total)}${stageChip(l.score?.stage)}<span class="small muted" title="${esc(l.source || "")}">link ${esc(l.confidence)}</span></div>`).join("");
  return `<div class="card">${rows || `<p class="small muted">${type === "operator" ? "No sponsor linked. If this operator is PE-backed, a read usually names the owner." : "No portfolio companies linked. A read discovers portcos in our verticals and links them."}</p>`}<div style="margin-top:.8rem"><button class="btn btn-sm" id="link-btn">+ Link ${type === "operator" ? "a sponsor" : "a portfolio company"}</button></div></div>`;
}
function editForm(type, e) {
  const f = type === "operator"
    ? [["tier", "Tier", ["T1", "T2", "T3"]], ["pipeline_status", "Pipeline status", ["Not Started", "Stuck", "Warm Intro Pending", "Discovery Booking/Booked", "Proposal Made", "Sprint Sold", "Moved to Attio", "Not interested"]], ["warm_intro_via", "Warm intro via"], ["sector", "Sector"], ["subsector", "Sub-sector"], ["hq", "HQ"], ["region", "Region"], ["website", "Website"], ["revenue_est", "Revenue est."], ["employees", "Employees"], ["pe_backed", "PE-backed", ["0", "1"]], ["notes", "Notes", null, true]]
    : [["tier", "Tier", ["T1", "T2", "T3", "T4", "T5"]], ["region", "Region", ["Ohio", "Great Lakes", "Broader Midwest", "National"]], ["aum_band", "AUM band", ["<$1B", "$1-3B", "$3-5B", "$5-10B", ">$10B", "Verify"]], ["fundraising_signal", "Last close", ["5+ yrs / pre-2021", "4 yrs / 2021", "3 yrs / 2022", "2 yrs / 2023", "0-1 yr / 2024-25", "Verify"]], ["vertical_fit", "Vertical fit", ["Core", "Strong", "Adjacent"]], ["ops_model", "Ops model", ["Value-Creation / OP", "Some Ops", "Financial"]], ["momentum_band", "Engagement", ["Existing client / Partner", "Meeting set / In dialogue", "Contacted / Emailed", "Intro pending", "Not started / Researching", "Not interested / Declined"]], ["data_confidence", "Data confidence", ["H", "M", "L"]], ["latest_fund", "Latest fund / vintage"], ["aum_est", "AUM (est.)"], ["target_poc", "Target POC"], ["intro_path", "Intro path"], ["engagement_status", "Status note"], ["hook", "Hook / intel", null, true], ["notes", "Notes", null, true]];
  return `<form class="inline card" id="edit-form">${f.map(([k, l, opts, ta]) => `<label class="${ta ? "span-all" : ""}">${l}${opts ? `<select name="${k}">${opts.map((o) => `<option ${String(e[k] ?? "") === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>` : ta ? `<textarea name="${k}" rows="3">${esc(e[k] || "")}</textarea>` : `<input name="${k}" value="${esc(e[k] ?? "")}">`}</label>`).join("")}<div class="span-all"><button class="btn btn-primary">Save</button> <span class="small muted">Saving re-scores and regenerates actions.</span></div></form>`;
}
function wireTab(k, type, id, d) {
  if (k === "add") {
    const form = $("#sig-form"); const dimSel = form.dimension, catSel = form.category;
    const fill = () => { const cats = TAX.dimensions[type][dimSel.value].categories; catSel.innerHTML = Object.entries(cats).map(([ck, c]) => `<option value="${ck}" data-str="${c.strength}">${esc(c.label)}${c.direction < 0 ? " (lowers)" : ""}</option>`).join(""); form.strength.value = cats[catSel.value].strength; };
    dimSel.onchange = fill; catSel.onchange = () => { form.strength.value = catSel.selectedOptions[0].dataset.str; }; fill();
    form.onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(form)); try { const r = await api("/signals", { method: "POST", body: { ...f, entity_type: type, entity_id: id } }); toast(`Signal added · score now ${r.score.total}`); openDrawer(type, id, "signals"); } catch (err) { toast(err.message, true); } };
  }
  if (k === "links") $("#link-btn").onclick = () => linkForm(type === "operator" ? { operator_id: id } : { sponsor_id: id });
  if (k === "edit") $("#edit-form").onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); if ("pe_backed" in f) f.pe_backed = Number(f.pe_backed); try { await api(`/${type === "operator" ? "operators" : "sponsors"}/${id}`, { method: "PATCH", body: f }); toast("Saved"); openDrawer(type, id, "signals"); opCache = null; } catch (err) { toast(err.message, true); } };
}
function addEntityForm(type) {
  showDrawer(`<div class="drawer-head"><div><div class="eyebrow">New ${type}</div><h2>Add ${type === "operator" ? "an operator" : "a sponsor"}</h2></div><button class="btn btn-ghost" data-close>Close</button></div>
    <form class="inline card" id="new-form">
      <label class="span-2">Name<input name="name" required></label>
      ${type === "operator" ? `<label>Sector<select name="sector"><option>Logistics</option><option>Industrial</option><option>Insurance</option><option>Manufacturing</option><option>Construction</option><option>Other</option></select></label><label>Sub-sector<input name="subsector"></label><label>HQ<input name="hq" placeholder="City, ST"></label><label>Region<input name="region" placeholder="Ohio"></label><label>Tier<select name="tier"><option>T1</option><option selected>T2</option><option>T3</option></select></label><label>Website<input name="website"></label>`
        : `<label>City<input name="city"></label><label>State<input name="state"></label><label>Region<select name="region"><option>Ohio</option><option>Great Lakes</option><option>Broader Midwest</option><option selected>National</option></select></label><label>AUM band<select name="aum_band"><option><$1B</option><option>$1-3B</option><option>$3-5B</option><option>$5-10B</option><option>>$10B</option><option selected>Verify</option></select></label><label>Last close<select name="fundraising_signal"><option>5+ yrs / pre-2021</option><option>4 yrs / 2021</option><option>3 yrs / 2022</option><option>2 yrs / 2023</option><option>0-1 yr / 2024-25</option><option selected>Verify</option></select></label><label>Vertical fit<select name="vertical_fit"><option>Core</option><option selected>Strong</option><option>Adjacent</option></select></label><label>Ops model<select name="ops_model"><option>Value-Creation / OP</option><option selected>Some Ops</option><option>Financial</option></select></label>`}
      <label class="span-all">Notes<textarea name="notes" rows="2"></textarea></label>
      <div class="span-all"><button class="btn btn-primary">Create</button></div>
    </form>`);
  $("#new-form").onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { const d = await api(`/${type === "operator" ? "operators" : "sponsors"}`, { method: "POST", body: f }); toast("Created"); opCache = null; openDrawer(type, d.entity.id, "add"); } catch (err) { toast(err.message, true); } };
}

// ---------------------------------------------------------------- Search
let searchIndex = null;
function setupSearch() {
  const input = $("#global-search"), box = $("#search-results");
  input.oninput = async () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { box.hidden = true; return; }
    if (!searchIndex) { const [o, s] = await Promise.all([api("/operators"), api("/sponsors")]); searchIndex = [...o.map((x) => ({ t: "operator", ...x })), ...s.map((x) => ({ t: "sponsor", ...x }))]; }
    const hits = searchIndex.filter((x) => `${x.name} ${x.subsector || ""} ${x.hq || ""} ${x.city || ""} ${x.target_verticals || ""}`.toLowerCase().includes(q)).slice(0, 12);
    box.innerHTML = hits.map((h) => `<button data-open="${h.t}:${h.id}"><span class="k">${h.t === "operator" ? "OP" : "PE"}</span><span><b>${esc(h.name)}</b> <span class="small muted">${esc(h.t === "operator" ? [h.subsector, h.hq].filter(Boolean).join(" · ") : [h.city, h.region].filter(Boolean).join(" · "))}</span></span><span class="num small" style="margin-left:auto">${h.score ?? "—"}</span></button>`).join("") || `<button disabled><span class="muted">No matches</span></button>`;
    box.hidden = false;
  };
  box.onclick = (e) => { const b = e.target.closest("[data-open]"); if (!b) return; const [t, id] = b.dataset.open.split(":"); box.hidden = true; input.value = ""; openDrawer(t, Number(id)); };
  document.addEventListener("click", (e) => { if (!e.target.closest(".topbar-right")) box.hidden = true; });
}

boot();
