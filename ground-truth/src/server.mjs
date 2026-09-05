// Local HTTP server: static UI + JSON API. No framework, no build step.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { ROOT, all, one, run, getMeta } from "./db.mjs";
import { latestScore, scoreAsOf, rescoreAll, loadWeights, setWeight, resetWeights, DEFAULT_WEIGHTS, scoreOperator, scoreSponsor } from "./scoring.mjs";
import { syncActions } from "./actions.mjs";
import { whatMoved } from "./week.mjs";
import { taxonomyList, validateSignal, dimensionsFor } from "./signals.mjs";
import { readEntity, hasCredentials, MODEL } from "./agent/reader.mjs";
import { writeBriefNarrative } from "./agent/brief.mjs";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const PUBLIC = join(ROOT, "public");

export function startServer(db, { port = 4310 } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith("/api/")) return await api(db, req, res, url);
      return await serveStatic(url.pathname, res);
    } catch (err) {
      const status = err.status || 500;
      send(res, status, { error: err.message });
      if (status >= 500) console.error(err);
    }
  });
  return new Promise((resolve) => server.listen(port, () => {
    console.log(`Intrinsic Ground Truth → http://localhost:${port}`);
    console.log(hasCredentials() ? `Agent reader: on (${MODEL})` : "Agent reader: off (set ANTHROPIC_API_KEY to enable scans)");
    resolve(server);
  }));
}

async function serveStatic(pathname, res) {
  let p = pathname === "/" ? "/index.html" : pathname;
  p = normalize(p).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: "forbidden" });
  try {
    await stat(file);
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch {
    // SPA fallback
    const body = await readFile(join(PUBLIC, "index.html"));
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(body);
  }
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
function bad(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

const running = new Map(); // scan concurrency guard: `${type}:${id}` -> promise

async function api(db, req, res, url) {
  const parts = url.pathname.slice(5).split("/").filter(Boolean);
  const [head, a, b, c] = parts;
  const q = url.searchParams;

  // --- overview -------------------------------------------------------------
  if (head === "week" && req.method === "GET") return send(res, 200, whatMoved(db, { windowDays: Number(q.get("days") || 7) }));
  if (head === "status" && req.method === "GET") {
    return send(res, 200, { agent: hasCredentials(), model: MODEL, last_import: getMeta(db, "last_import"), running: [...running.keys()], version: "0.1.0" });
  }

  // --- entities -------------------------------------------------------------
  if ((head === "operators" || head === "sponsors") && !a && req.method === "GET") return send(res, 200, listEntities(db, head === "operators" ? "operator" : "sponsor"));
  if ((head === "operators" || head === "sponsors") && a && !b && req.method === "GET") return send(res, 200, entityDetail(db, head === "operators" ? "operator" : "sponsor", Number(a)));
  if ((head === "operators" || head === "sponsors") && a && !b && req.method === "PATCH") {
    const type = head === "operators" ? "operator" : "sponsor";
    const body = await readJson(req);
    const allowed = type === "operator"
      ? ["tier", "pipeline_status", "warm_intro_via", "notes", "pe_backed", "sector", "subsector", "hq", "region", "website", "revenue_est", "employees"]
      : ["tier", "engagement_status", "momentum_band", "intro_path", "notes", "hook", "aum_band", "fundraising_signal", "vertical_fit", "ops_model", "region", "latest_fund", "aum_est", "target_poc", "data_confidence"];
    const sets = Object.entries(body).filter(([k]) => allowed.includes(k));
    if (!sets.length) throw bad("no editable fields supplied");
    run(db, `UPDATE ${type === "operator" ? "operators" : "sponsors"} SET ${sets.map(([k]) => `${k}=?`).join(", ")}, updated_at=datetime('now') WHERE id=?`, ...sets.map(([, v]) => v), Number(a));
    rescoreAll(db); syncActions(db);
    return send(res, 200, entityDetail(db, type, Number(a)));
  }
  if ((head === "operators" || head === "sponsors") && !a && req.method === "POST") {
    const type = head === "operators" ? "operator" : "sponsor";
    const body = await readJson(req);
    if (!body.name) throw bad("name is required");
    if (type === "operator") run(db, "INSERT INTO operators(name,sector,subsector,hq,region,tier,pipeline_status,website,notes,source) VALUES(?,?,?,?,?,?,?,?,?,'manual')", body.name, body.sector || null, body.subsector || null, body.hq || null, body.region || null, body.tier || "T2", body.pipeline_status || "Not Started", body.website || null, body.notes || null);
    else run(db, "INSERT INTO sponsors(name,city,state,region,aum_band,fundraising_signal,vertical_fit,ops_model,engagement_status,momentum_band,data_confidence,notes,source) VALUES(?,?,?,?,?,?,?,?,'Not started','Not started / Researching','L',?,'manual')", body.name, body.city || null, body.state || null, body.region || "National", body.aum_band || "Verify", body.fundraising_signal || "Verify", body.vertical_fit || "Strong", body.ops_model || "Some Ops", body.notes || null);
    rescoreAll(db); syncActions(db);
    const id = one(db, `SELECT id FROM ${type === "operator" ? "operators" : "sponsors"} WHERE name=?`, body.name).id;
    return send(res, 201, entityDetail(db, type, id));
  }

  // --- signals --------------------------------------------------------------
  if (head === "taxonomy" && req.method === "GET") return send(res, 200, { operator: taxonomyList("operator"), sponsor: taxonomyList("sponsor"), dimensions: { operator: dimensionsFor("operator"), sponsor: dimensionsFor("sponsor") } });
  if (head === "signals" && !a && req.method === "GET") {
    const where = []; const params = [];
    if (q.get("review_status")) { where.push("s.review_status=?"); params.push(q.get("review_status")); }
    if (q.get("source_type")) { where.push("s.source_type=?"); params.push(q.get("source_type")); }
    const rows = all(db, `SELECT s.*, CASE s.entity_type WHEN 'operator' THEN (SELECT name FROM operators WHERE id=s.entity_id) ELSE (SELECT name FROM sponsors WHERE id=s.entity_id) END AS entity_name
      FROM signals s ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY s.created_at DESC LIMIT ?`, ...params, Number(q.get("limit") || 200));
    return send(res, 200, rows);
  }
  if (head === "signals" && !a && req.method === "POST") {
    const body = await readJson(req);
    const type = body.entity_type; const id = Number(body.entity_id);
    if (!["operator", "sponsor"].includes(type) || !id) throw bad("entity_type and entity_id required");
    const s = validateSignal(type, { ...body, observed_at: body.observed_at || new Date().toISOString().slice(0, 10) });
    const r = run(db, `INSERT INTO signals(entity_type,entity_id,dimension,category,direction,strength,confidence,title,detail,source_type,source_url,observed_at,review_status,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,'manual',?,?,'accepted',?)`, type, id, s.dimension, s.category, s.direction, s.strength, s.confidence, s.title, s.detail || null, s.source_url || null, s.observed_at, body.created_by || "ui");
    rescoreAll(db); syncActions(db);
    return send(res, 201, { id: Number(r.lastInsertRowid), score: latestScore(db, type, id) });
  }
  if (head === "signals" && a && req.method === "PATCH") {
    const body = await readJson(req);
    const sig = one(db, "SELECT * FROM signals WHERE id=?", Number(a));
    if (!sig) throw bad("signal not found", 404);
    if (body.review_status && !["accepted", "unreviewed", "dismissed"].includes(body.review_status)) throw bad("bad review_status");
    const fields = ["review_status", "strength", "confidence", "title", "detail", "source_url", "observed_at", "direction"].filter((k) => k in body);
    if (!fields.length) throw bad("nothing to update");
    run(db, `UPDATE signals SET ${fields.map((k) => `${k}=?`).join(", ")} WHERE id=?`, ...fields.map((k) => body[k]), sig.id);
    rescoreAll(db); syncActions(db);
    return send(res, 200, { ok: true, score: latestScore(db, sig.entity_type, sig.entity_id) });
  }
  if (head === "signals" && a && req.method === "DELETE") {
    const sig = one(db, "SELECT * FROM signals WHERE id=?", Number(a));
    if (!sig) throw bad("signal not found", 404);
    run(db, "DELETE FROM signals WHERE id=?", sig.id);
    rescoreAll(db); syncActions(db);
    return send(res, 200, { ok: true });
  }

  // --- ownership (the join) ---------------------------------------------------
  if (head === "ownership" && req.method === "GET") return send(res, 200, joinView(db));
  if (head === "ownership" && req.method === "POST") {
    const body = await readJson(req);
    if (!body.sponsor_id || !body.operator_id) throw bad("sponsor_id and operator_id required");
    run(db, "INSERT OR IGNORE INTO ownership(sponsor_id,operator_id,confidence,source,since) VALUES(?,?,?,?,?)", Number(body.sponsor_id), Number(body.operator_id), body.confidence || "M", body.source || "manual", body.since || null);
    run(db, "UPDATE operators SET pe_backed=1 WHERE id=?", Number(body.operator_id));
    rescoreAll(db); syncActions(db);
    return send(res, 201, { ok: true });
  }
  if (head === "ownership" && a && req.method === "DELETE") { run(db, "DELETE FROM ownership WHERE id=?", Number(a)); rescoreAll(db); syncActions(db); return send(res, 200, { ok: true }); }

  // --- actions --------------------------------------------------------------
  if (head === "actions" && !a && req.method === "GET") {
    const status = q.get("status") || "open";
    const rows = all(db, `SELECT a.*, CASE a.entity_type WHEN 'operator' THEN (SELECT name FROM operators WHERE id=a.entity_id) ELSE (SELECT name FROM sponsors WHERE id=a.entity_id) END AS entity_name
      FROM actions a WHERE a.status=? ORDER BY a.priority DESC, a.updated_at DESC LIMIT ?`, status, Number(q.get("limit") || 200));
    return send(res, 200, rows.map((r) => ({ ...r, evidence: JSON.parse(r.evidence || "[]") })));
  }
  if (head === "actions" && a && req.method === "PATCH") {
    const body = await readJson(req);
    if (!["open", "done", "dismissed"].includes(body.status)) throw bad("status must be open, done or dismissed");
    run(db, "UPDATE actions SET status=?, resolution_note=?, owner=COALESCE(?, owner), resolved_at=CASE WHEN ?='open' THEN NULL ELSE datetime('now') END, updated_at=datetime('now') WHERE id=?", body.status, body.note || null, body.owner || null, body.status, Number(a));
    return send(res, 200, { ok: true });
  }
  if (head === "actions" && a === "regenerate" && req.method === "POST") return send(res, 200, syncActions(db));

  // --- scoring model --------------------------------------------------------
  if (head === "weights" && req.method === "GET") {
    const out = {};
    for (const model of Object.keys(DEFAULT_WEIGHTS)) out[model] = all(db, "SELECT key, value, label FROM weights WHERE model=? ORDER BY rowid", model).map((w) => ({ ...w, default: DEFAULT_WEIGHTS[model][w.key]?.[0] }));
    return send(res, 200, out);
  }
  if (head === "weights" && req.method === "PATCH") {
    const body = await readJson(req);
    for (const { model, key, value } of body.updates || []) setWeight(db, model, key, value);
    if (body.reset) resetWeights(db, body.reset);
    const r = rescoreAll(db, { force: true }); syncActions(db);
    return send(res, 200, { ok: true, rescored: r.changed });
  }

  // --- agent ------------------------------------------------------------------
  if (head === "scan" && req.method === "POST") {
    const body = await readJson(req);
    const type = body.entity_type; const id = Number(body.entity_id);
    if (!["operator", "sponsor"].includes(type) || !id) throw bad("entity_type and entity_id required");
    if (!hasCredentials()) throw bad("Agent reader is off: set ANTHROPIC_API_KEY in the server environment and restart.", 503);
    const key = `${type}:${id}`;
    if (running.has(key)) throw bad("A read of this entity is already running", 409);
    const log = [];
    const p = readEntity(db, type, id, { log: (m) => log.push(m) }).then((r) => { syncActions(db); return { ...r, log }; }).finally(() => running.delete(key));
    running.set(key, p);
    if (body.wait === false) return send(res, 202, { started: true });
    return send(res, 200, await p);
  }
  if (head === "scans" && req.method === "GET") {
    const rows = all(db, `SELECT s.id, s.entity_type, s.entity_id, s.started_at, s.finished_at, s.status, s.model, s.summary, s.signals_found, s.error, s.usage,
      CASE s.entity_type WHEN 'operator' THEN (SELECT name FROM operators WHERE id=s.entity_id) ELSE (SELECT name FROM sponsors WHERE id=s.entity_id) END AS entity_name
      FROM scans s ORDER BY s.started_at DESC LIMIT 100`);
    return send(res, 200, rows);
  }
  if (head === "scans" && a && req.method === "GET") {
    const r = one(db, "SELECT * FROM scans WHERE id=?", Number(a));
    if (!r) throw bad("scan not found", 404);
    return send(res, 200, { ...r, raw: r.raw ? JSON.parse(r.raw) : null, usage: r.usage ? JSON.parse(r.usage) : null });
  }
  if (head === "brief" && req.method === "POST") {
    const w = whatMoved(db, { windowDays: Number(q.get("days") || 7) });
    let narrative = null, error = null;
    try { narrative = await writeBriefNarrative(w); } catch (e) { error = e.message; }
    run(db, "INSERT INTO briefs(week_of, body, narrative) VALUES(?,?,?)", w.since, JSON.stringify(w), narrative);
    return send(res, 200, { narrative, error });
  }
  if (head === "briefs" && req.method === "GET") return send(res, 200, all(db, "SELECT id, week_of, created_at, narrative FROM briefs ORDER BY created_at DESC LIMIT 20"));

  throw bad("not found", 404);
}

function listEntities(db, type) {
  const table = type === "operator" ? "operators" : "sponsors";
  const rows = all(db, `SELECT e.*, sc.total AS score, sc.stage, sc.play, sc.grade, sc.confidence AS score_confidence, sc.components, sc.computed_at,
      (SELECT COUNT(*) FROM signals s WHERE s.entity_type=? AND s.entity_id=e.id AND s.review_status<>'dismissed') AS signal_count,
      (SELECT COUNT(*) FROM signals s WHERE s.entity_type=? AND s.entity_id=e.id AND s.review_status='unreviewed') AS unreviewed,
      (SELECT MAX(observed_at) FROM signals s WHERE s.entity_type=? AND s.entity_id=e.id AND s.review_status<>'dismissed') AS last_signal,
      (SELECT COUNT(*) FROM actions a WHERE a.entity_type=? AND a.entity_id=e.id AND a.status='open') AS open_actions,
      (SELECT COUNT(*) FROM ownership o WHERE ${type === "operator" ? "o.operator_id" : "o.sponsor_id"}=e.id) AS links
    FROM ${table} e LEFT JOIN scores sc ON sc.id = (SELECT id FROM scores WHERE entity_type=? AND entity_id=e.id ORDER BY computed_at DESC, id DESC LIMIT 1)
    ORDER BY sc.total DESC, e.name`, type, type, type, type, type);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().replace("T", " ").slice(0, 19);
  return rows.map((r) => {
    const comp = r.components ? JSON.parse(r.components) : null;
    const before = scoreAsOf(db, type, r.id, weekAgo);
    return { ...r, components: comp, delta_7d: before && r.score != null ? Math.round((r.score - before.total) * 10) / 10 : null };
  });
}

function entityDetail(db, type, id) {
  const table = type === "operator" ? "operators" : "sponsors";
  const e = one(db, `SELECT * FROM ${table} WHERE id=?`, id);
  if (!e) throw bad(`${type} not found`, 404);
  const score = latestScore(db, type, id);
  const live = type === "operator" ? scoreOperator(db, e) : scoreSponsor(db, e);
  const signals = all(db, "SELECT * FROM signals WHERE entity_type=? AND entity_id=? ORDER BY observed_at DESC, id DESC", type, id);
  const contacts = all(db, "SELECT * FROM contacts WHERE entity_type=? AND entity_id=? ORDER BY name", type, id);
  const actions = all(db, "SELECT * FROM actions WHERE entity_type=? AND entity_id=? ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, priority DESC", type, id).map((a) => ({ ...a, evidence: JSON.parse(a.evidence || "[]") }));
  const history = all(db, "SELECT computed_at, total, stage, play, grade FROM scores WHERE entity_type=? AND entity_id=? ORDER BY computed_at ASC, id ASC", type, id);
  const scans = all(db, "SELECT id, started_at, finished_at, status, model, summary, signals_found, error FROM scans WHERE entity_type=? AND entity_id=? ORDER BY started_at DESC", type, id);
  const links = type === "operator"
    ? all(db, "SELECT o.id AS link_id, o.confidence, o.source, o.source_url, o.since, s.id, s.name FROM ownership o JOIN sponsors s ON s.id=o.sponsor_id WHERE o.operator_id=?", id).map((l) => ({ ...l, score: latestScore(db, "sponsor", l.id) }))
    : all(db, "SELECT o.id AS link_id, o.confidence, o.source, o.source_url, o.since, p.id, p.name, p.sector, p.hq, p.tier FROM ownership o JOIN operators p ON p.id=o.operator_id WHERE o.sponsor_id=?", id).map((l) => ({ ...l, score: latestScore(db, "operator", l.id) }));
  return { entity_type: type, entity: e, score, live, signals, contacts, actions, history, scans, links };
}

function joinView(db) {
  const sponsors = all(db, "SELECT s.id, s.name, s.region, s.aum_band, s.fundraising_signal, s.intro_path, s.target_poc, s.engagement_status FROM sponsors s WHERE EXISTS (SELECT 1 FROM ownership o WHERE o.sponsor_id=s.id) ORDER BY s.name");
  const out = sponsors.map((s) => {
    const sc = latestScore(db, "sponsor", s.id);
    const portcos = all(db, "SELECT p.id, p.name, p.sector, p.subsector, p.hq, p.tier, p.pipeline_status, o.confidence AS link_confidence, o.source AS link_source, o.since FROM ownership o JOIN operators p ON p.id=o.operator_id WHERE o.sponsor_id=? ORDER BY p.name", s.id)
      .map((p) => ({ ...p, score: latestScore(db, "operator", p.id) }));
    const low = portcos.filter((p) => ["unread", "untouched", "experimenting"].includes(p.score?.stage));
    return { ...s, score: sc, portcos, low_penetration: low.length, intersection: sc ? intersectionLabel(sc, low.length, portcos.length) : null };
  });
  const unlinkedPe = all(db, "SELECT id, name, sector, hq, tier, notes FROM operators WHERE pe_backed=1 AND NOT EXISTS (SELECT 1 FROM ownership o WHERE o.operator_id=operators.id) ORDER BY name");
  return { sponsors: out.sort((a, b) => (b.low_penetration * 10 + (b.score?.total ?? 0)) - (a.low_penetration * 10 + (a.score?.total ?? 0))), unlinked_pe_backed: unlinkedPe };
}
function intersectionLabel(sc, low, total) {
  if (!total) return null;
  if (sc.play === "Exit-Unlock" && low) return "Stuck fund, no AI story on the asset — exit-unlock conversation waiting for a first email";
  if (sc.components?.posture >= 30 && low) return "AI-forward sponsor with laggard portcos — preferred-vendor conversation with a deadline";
  if (low) return "Sponsor sitting on low-penetration portcos — highest-probability meeting in our market";
  return "Portfolio already moving — position as the firm that makes it compound";
}
