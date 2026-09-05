// Imports the two pipeline sheets (CSV export) into the engine and derives a first, low-confidence
// set of signals from what the sheets already say. Re-running is idempotent: entities upsert by name,
// import-derived signals are replaced, manual and agent signals are left alone.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { csvToObjects } from "./csv.mjs";
import { ROOT, all, one, run, transaction } from "./db.mjs";
import { momentumFromStatus } from "./scoring.mjs";

const STATUS_RANK = ["Moved to Attio", "Sprint Sold", "Proposal Made", "Discovery", "Warm Intro", "Stuck", "Cold", "Not Started"];
function statusRank(s) {
  const i = STATUS_RANK.findIndex((k) => (s || "").toLowerCase().includes(k.toLowerCase()));
  return i === -1 ? STATUS_RANK.length : i;
}
function cleanStatus(s) {
  return (s || "").replace(/^\d+(\.\d+)?\.?\s*/, "").trim() || "Not Started";
}
function stateFromHq(hq, region) {
  const m = /,\s*([A-Z]{2})\b/.exec(hq || "");
  if (m) return m[1];
  const map = { Ohio: "OH", Michigan: "MI", Illinois: "IL", Wisconsin: "WI", Indiana: "IN", Kentucky: "KY", "West Virginia": "WV", Iowa: "IA", Arkansas: "AR" };
  return map[region] ?? null;
}
function splitContact(raw) {
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(raw || "");
  return m ? { name: m[1].trim(), title: m[2].trim() } : { name: (raw || "").trim(), title: null };
}

export function importOperators(db, csvPath = join(ROOT, "data/source/client_targets_pipeline_aug2026.csv"), { asOf } = {}) {
  const rows = csvToObjects(readFileSync(csvPath, "utf8")).filter((r) => r.Company);
  const byCompany = new Map();
  for (const r of rows) {
    if (!byCompany.has(r.Company)) byCompany.set(r.Company, []);
    byCompany.get(r.Company).push(r);
  }
  const upsert = db.prepare(`INSERT INTO operators(name,sector,subsector,hq,region,state,revenue_est,employees,website,tier,fit_score,pipeline_status,status_date,warm_intro_via,context,notes,pe_backed,source)
    VALUES(@name,@sector,@subsector,@hq,@region,@state,@revenue_est,@employees,@website,@tier,@fit_score,@pipeline_status,@status_date,@warm_intro_via,@context,@notes,@pe_backed,'import')
    ON CONFLICT(name) DO UPDATE SET sector=excluded.sector, subsector=excluded.subsector, hq=excluded.hq, region=excluded.region, state=excluded.state,
      revenue_est=excluded.revenue_est, employees=excluded.employees, website=excluded.website, tier=excluded.tier, fit_score=excluded.fit_score,
      pipeline_status=excluded.pipeline_status, status_date=excluded.status_date, warm_intro_via=excluded.warm_intro_via, context=excluded.context,
      notes=excluded.notes, pe_backed=excluded.pe_backed, updated_at=datetime('now')`);
  const upsertContact = db.prepare(`INSERT INTO contacts(entity_type,entity_id,name,title,email,linkedin,status,status_date,context)
    VALUES('operator',?,?,?,?,?,?,?,?) ON CONFLICT(entity_type,entity_id,name,title) DO UPDATE SET email=excluded.email, linkedin=excluded.linkedin, status=excluded.status, status_date=excluded.status_date, context=excluded.context`);
  let n = 0, c = 0;
  transaction(db, () => {
    for (const [name, rs] of byCompany) {
      const pick = (k) => rs.map((r) => r[k]).find((v) => v && v.trim()) ?? null;
      const best = rs.slice().sort((a, b) => statusRank(a.Status) - statusRank(b.Status))[0];
      const notes = uniqJoin(rs.map((r) => (r.Notes || "").replace(/\s*Additional Apollo verified contact added as row\.?/gi, "").trim()));
      const context = uniqJoin(rs.map((r) => r.Context));
      const hq = pick("HQ");
      const region = pick("Region");
      upsert.run({
        name, sector: pick("Sector"), subsector: pick("Sub-Sector"), hq, region, state: stateFromHq(hq, region),
        revenue_est: pick("Rev Est ($M)"), employees: pick("Employees"), website: pick("Website"), tier: pick("Tier"),
        fit_score: pick("Fit Score") ? Number(pick("Fit Score")) : null, pipeline_status: cleanStatus(best.Status),
        status_date: pick("Status Date"), warm_intro_via: uniqJoin(rs.map((r) => r["Warm Intro Via"]), ", "), context, notes,
        pe_backed: /PE-backed|private[- ]equity|-backed|OMERS|portfolio company|portco/i.test(notes + " " + context) ? 1 : 0,
      });
      const id = one(db, "SELECT id FROM operators WHERE name=?", name).id;
      n++;
      for (const r of rs) {
        const { name: cname, title } = splitContact(r["CEO / Contact"]);
        if (!cname) continue;
        upsertContact.run(id, cname, title, r["Contact Email"] || null, r["Contact LinkedIn"] || null, cleanStatus(r.Status), r["Status Date"] || null, r.Context || null);
        c++;
      }
    }
  });
  return { operators: n, contacts: c };
}

export function importSponsors(db, csvPath = join(ROOT, "data/source/pe_pipeline_aug2026.csv")) {
  const rows = csvToObjects(readFileSync(csvPath, "utf8")).filter((r) => r["Firm Name"]);
  const upsert = db.prepare(`INSERT INTO sponsors(name,city,state,region,tier,fund_strategy,aum_est,aum_band,latest_fund,fundraising_signal,target_verticals,vertical_fit,entry_seat,ops_model,engagement_status,momentum_band,hook,notes,data_confidence,target_poc,poc_email,intro_path,sheet_rank,sheet_fit,sheet_play,source)
    VALUES(@name,@city,@state,@region,@tier,@fund_strategy,@aum_est,@aum_band,@latest_fund,@fundraising_signal,@target_verticals,@vertical_fit,@entry_seat,@ops_model,@engagement_status,@momentum_band,@hook,@notes,@data_confidence,@target_poc,@poc_email,@intro_path,@sheet_rank,@sheet_fit,@sheet_play,'import')
    ON CONFLICT(name) DO UPDATE SET city=excluded.city,state=excluded.state,region=excluded.region,tier=excluded.tier,fund_strategy=excluded.fund_strategy,aum_est=excluded.aum_est,aum_band=excluded.aum_band,
      latest_fund=excluded.latest_fund,fundraising_signal=excluded.fundraising_signal,target_verticals=excluded.target_verticals,vertical_fit=excluded.vertical_fit,entry_seat=excluded.entry_seat,ops_model=excluded.ops_model,
      engagement_status=excluded.engagement_status,momentum_band=excluded.momentum_band,hook=excluded.hook,notes=excluded.notes,data_confidence=excluded.data_confidence,target_poc=excluded.target_poc,poc_email=excluded.poc_email,
      intro_path=excluded.intro_path,sheet_rank=excluded.sheet_rank,sheet_fit=excluded.sheet_fit,sheet_play=excluded.sheet_play,updated_at=datetime('now')`);
  const upsertContact = db.prepare(`INSERT INTO contacts(entity_type,entity_id,name,title,email,linkedin,status) VALUES('sponsor',?,?,?,?,?,?)
    ON CONFLICT(entity_type,entity_id,name,title) DO UPDATE SET email=excluded.email, linkedin=excluded.linkedin, status=excluded.status`);
  let n = 0;
  transaction(db, () => {
    for (const r of rows) {
      upsert.run({
        name: r["Firm Name"], city: r.City || null, state: r.State || null, region: r.Region || null, tier: r.Tier || null,
        fund_strategy: r["Fund Strategy"] || null, aum_est: r["AUM (est.)"] || null, aum_band: r["AUM Band"] || "Verify",
        latest_fund: r["Latest Fund / Vintage"] || null, fundraising_signal: r["Fundraising Signal"] || "Verify",
        target_verticals: r["Target Verticals"] || null, vertical_fit: r["Vertical Fit"] || null, entry_seat: r["Entry Seat"] || null,
        ops_model: r["Ops Model"] || null, engagement_status: r.Status || "Not started", momentum_band: r.momband || momentumFromStatus(r.Status),
        hook: r["Exit-Unlock Hook / Intel"] || null, notes: r.Notes || null, data_confidence: (r["Data Conf."] || "L").toUpperCase(),
        target_poc: r["Target POC"] || null, poc_email: r.Email || null, intro_path: r["Intro Path / Connection"] || null,
        sheet_rank: r.Rank ? Number(r.Rank) : null, sheet_fit: r["Fit Score"] ? Number(r["Fit Score"]) : null, sheet_play: r.Play || null,
      });
      const id = one(db, "SELECT id FROM sponsors WHERE name=?", r["Firm Name"]).id;
      n++;
      if (r["Target POC"]) upsertContact.run(id, r["Target POC"], r["Entry Seat"] || null, r.Email || null, r.LinkedIn && r.LinkedIn.startsWith("http") ? r.LinkedIn : null, r.Status || null);
    }
  });
  return { sponsors: n };
}

// Signals we can honestly derive from the sheets' own research notes. All low confidence, all
// flagged as 'import' so they are visibly distinct from anything observed in the market.
const OPERATOR_RULES = [
  { re: /legacy (systems|ops)|manual workflow|paper-heavy|WMS gaps|spreadsheet|owner-operated culture/i, dimension: "pressure", category: "manual_workflow", title: "Legacy / manual workflows noted in pipeline research", strength: 2 },
  { re: /modernizing tech|digital transformation|tech modernization|technology modernization|tech-forward/i, dimension: "adoption", category: "modernization", title: "Modernization effort noted in pipeline research", strength: 2 },
  { re: /PE-backed|acquisition pace|consolidator|roll-up|acquired agencies|portfolio company/i, dimension: "pressure", category: "pe_standardization", title: "PE-backed or acquisition-driven standardization need", strength: 3 },
  { re: /compliance|documentation|regulatory|DOT work|BWC/i, dimension: "pressure", category: "regulatory_load", title: "Compliance / documentation burden noted", strength: 2 },
  { re: /high[- ]volume|transaction volume|exception workflow|1M\+ sq ft|complex .*workflow/i, dimension: "pressure", category: "volume_spike", title: "Volume / workflow complexity noted", strength: 2 },
  { re: /family-owned|3rd-gen|founder-led|founder-owned/i, dimension: "pressure", category: "exit_window", title: "Family or founder ownership (succession dynamics possible)", strength: 1 },
  { re: /warm intro via|intro via|meeting (moved|set|booked)|accepted the meeting|proposal sent|discovery/i, dimension: "openness", category: "inbound_or_referral", title: "Trusted path or live conversation exists", strength: 3 },
  { re: /not interested|declined|passed/i, dimension: "openness", category: "declined", title: "Declined / not interested", strength: 3 },
];
const TITLE_RULES = [
  { re: /chief digital|digital (business )?transformation|business transformation|operations technology|innovation|automation|artificial intelligence|\bAI\b|analytics|data/i, category: "transformation_seat", title: (t) => `Transformation / digital seat exists: ${t}`, strength: 2 },
  { re: /chief information|\bCIO\b|\bCTO\b|information technology|operational excellence|lean/i, category: "transformation_seat", title: (t) => `Technology or ops-excellence leadership seat: ${t}`, strength: 1 },
];
const SPONSOR_RULES = [
  { re: /\bAI\b|automation|digital|technology thesis|tech-forward|KPI systems|industrial tech/i, dimension: "posture", category: "ai_value_creation_language", title: "AI / technology language in thesis or value-creation playbook (pipeline research)", strength: 2 },
  { re: /dedicated (ops|value.creation) (staff|team)|value creation team|Operating Principals|operating executives|branded value/i, dimension: "mandate", category: "value_creation_team", title: "Dedicated value-creation team noted", strength: 2 },
  { re: /no (flagship|fund) since|long gap|stale vintage|harvesting|zombie|aging assets|7-yr average|long[- ]hold/i, dimension: "vintage", category: "long_hold", title: "Aging assets / long gap since last fund (pipeline research)", strength: 3 },
  { re: /just raised|fresh (fund|dry powder)|raise likely 202|Fund .* \(20(24|25)\)/i, dimension: "vintage", category: "fund_close", title: "Recent or upcoming fund close noted", strength: 2 },
];

export function deriveImportSignals(db, { asOf = "2026-08-23" } = {}) {
  let n = 0;
  transaction(db, () => {
    run(db, "DELETE FROM signals WHERE source_type='import'");
    const ins = db.prepare(`INSERT INTO signals(entity_type,entity_id,dimension,category,direction,strength,confidence,title,detail,source_type,observed_at,review_status,created_by)
      VALUES(?,?,?,?,?,?,'L',?,?,'import',?,'accepted','import')`);
    for (const op of all(db, "SELECT * FROM operators")) {
      const text = `${op.notes || ""} ${op.context || ""} ${op.warm_intro_via ? "warm intro via " + op.warm_intro_via : ""}`;
      const seen = new Set();
      for (const r of OPERATOR_RULES) {
        if (r.re.test(text) && !seen.has(r.category)) {
          seen.add(r.category);
          ins.run("operator", op.id, r.dimension, r.category, r.category === "declined" ? -1 : 1, r.strength, r.title, excerpt(text, r.re), op.status_date || asOf); n++;
        }
      }
      for (const ct of all(db, "SELECT title FROM contacts WHERE entity_type='operator' AND entity_id=? AND title IS NOT NULL", op.id)) {
        const rule = TITLE_RULES.find((tr) => tr.re.test(ct.title));
        if (rule && !seen.has("seat:" + ct.title)) {
          seen.add("seat:" + ct.title);
          ins.run("operator", op.id, "openness", rule.category, 1, rule.strength, rule.title(ct.title), "From contact research in the pipeline sheet", asOf); n++;
        }
      }
    }
    for (const sp of all(db, "SELECT * FROM sponsors")) {
      const text = `${sp.hook || ""} ${sp.notes || ""} ${sp.latest_fund || ""} ${sp.fund_strategy || ""}`;
      const seen = new Set();
      for (const r of SPONSOR_RULES) {
        if (r.re.test(text) && !seen.has(r.category)) {
          seen.add(r.category);
          ins.run("sponsor", sp.id, r.dimension, r.category, r.category === "fund_close" ? -1 : 1, r.strength, r.title, excerpt(text, r.re), asOf); n++;
        }
      }
    }
  });
  return { signals: n };
}

// Ownership links the sheets already assert.
export function seedOwnership(db) {
  const links = [
    { sponsor: "OMERS Private Equity", operator: "Kenan Advantage Group", confidence: "M", source: "Client Targets sheet note: 'OMERS PE-backed'", sponsorDefaults: { region: "National", aum_band: ">$10B", fundraising_signal: "Verify", vertical_fit: "Adjacent", ops_model: "Some Ops", fund_strategy: "Pension PE (large-cap)", city: "Toronto", state: "ON", data_confidence: "M", notes: "Added as owner of Kenan Advantage Group. Not a channel target on size; tracked for the join." } },
  ];
  let n = 0;
  for (const l of links) {
    const op = one(db, "SELECT id FROM operators WHERE name=?", l.operator);
    if (!op) continue;
    let sp = one(db, "SELECT id FROM sponsors WHERE name=?", l.sponsor);
    if (!sp) {
      const d = l.sponsorDefaults;
      run(db, `INSERT INTO sponsors(name,city,state,region,fund_strategy,aum_band,fundraising_signal,vertical_fit,ops_model,engagement_status,momentum_band,data_confidence,notes,source)
        VALUES(?,?,?,?,?,?,?,?,?,'Not started','Not started / Researching',?,?,'derived')`, l.sponsor, d.city, d.state, d.region, d.fund_strategy, d.aum_band, d.fundraising_signal, d.vertical_fit, d.ops_model, d.data_confidence, d.notes);
      sp = one(db, "SELECT id FROM sponsors WHERE name=?", l.sponsor);
    }
    run(db, "INSERT OR IGNORE INTO ownership(sponsor_id,operator_id,confidence,source) VALUES(?,?,?,?)", sp.id, op.id, l.confidence, l.source);
    n++;
  }
  return { links: n };
}

function uniqJoin(vals, sep = " ") {
  const seen = new Set();
  const out = [];
  for (const v of vals) { const t = (v || "").trim(); if (t && !seen.has(t)) { seen.add(t); out.push(t); } }
  return out.join(sep) || null;
}
function excerpt(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  const i = Math.max(0, m.index - 60);
  return (i > 0 ? "…" : "") + text.slice(i, m.index + m[0].length + 80).trim() + "…";
}
