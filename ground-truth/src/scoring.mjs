// Scoring models.
//   Operators -> AI Penetration Index (0-100) = Adoption (0-40) + Pressure (0-30) + Openness (0-30)
//   Sponsors  -> Exit-Unlock Fit (0-100), ported exactly from the PE pipeline sheet's six-component model,
//                plus an AI Posture read (0-100) computed from signals.
// Every number is a deterministic function of stored signals and the weights table, so a score can
// always be explained by pointing at the signals that produced it.

import { all, one, run } from "./db.mjs";

export const DEFAULT_WEIGHTS = {
  operator: {
    adoption_max: [40, "Adoption ceiling"],
    pressure_max: [30, "Pressure ceiling"],
    openness_max: [30, "Openness ceiling"],
    adoption_per_point: [4, "Index points per weighted adoption signal point"],
    pressure_per_point: [3, "Index points per weighted pressure signal point"],
    openness_per_point: [3, "Index points per weighted openness signal point"],
    stage_experimenting: [8, "Adoption score at which stage becomes 'experimenting'"],
    stage_deploying: [20, "Adoption score at which stage becomes 'deploying'"],
    stage_compounding: [32, "Adoption score at which stage becomes 'compounding'"],
    conf_H: [1.0, "Multiplier for high-confidence signals"],
    conf_M: [0.75, "Multiplier for medium-confidence signals"],
    conf_L: [0.5, "Multiplier for low-confidence signals"],
    decay_90: [1.0, "Weight of signals observed in the last 90 days"],
    decay_180: [0.75, "Weight of signals 90-180 days old"],
    decay_365: [0.5, "Weight of signals 180-365 days old"],
    decay_old: [0.25, "Weight of signals older than a year"],
  },
  sponsor: {
    // 1 AUM fit
    "aum:<$1B": [22, "AUM <$1B"], "aum:$1-3B": [18, "AUM $1-3B"], "aum:$3-5B": [11, "AUM $3-5B"],
    "aum:$5-10B": [5, "AUM $5-10B"], "aum:>$10B": [0, "AUM >$10B"], "aum:Verify": [9, "AUM unverified"],
    // 2 Fundraising / zombie signal
    "sig:5+ yrs / pre-2021": [22, "Last close 5+ yrs ago"], "sig:4 yrs / 2021": [16, "Last close 4 yrs ago"],
    "sig:3 yrs / 2022": [11, "Last close 3 yrs ago"], "sig:2 yrs / 2023": [5, "Last close 2 yrs ago"],
    "sig:0-1 yr / 2024-25": [2, "Raised in last year"], "sig:Verify": [9, "Vintage unverified"],
    // 3 Vertical fit
    "vert:Core": [18, "Core vertical"], "vert:Strong": [13, "Strong vertical"], "vert:Adjacent": [7, "Adjacent vertical"],
    // 4 Operational engagement
    "ops:Value-Creation / OP": [13, "Value-creation / operating-partner model"], "ops:Some Ops": [8, "Some ops involvement"], "ops:Financial": [3, "Financial sponsor only"],
    // 5 Region
    "reg:Ohio": [13, "Ohio"], "reg:Great Lakes": [10, "Great Lakes"], "reg:Broader Midwest": [8, "Broader Midwest"], "reg:National": [5, "National"],
    // 6 Engagement momentum
    "mom:Existing client / Partner": [12, "Existing client / partner"], "mom:Meeting set / In dialogue": [10, "Meeting set / in dialogue"],
    "mom:Contacted / Emailed": [6, "Contacted / emailed"], "mom:Intro pending": [5, "Intro pending"],
    "mom:Not started / Researching": [2, "Not started"], "mom:Not interested / Declined": [0, "Declined"],
    grade_A: [74, "Grade A threshold"], grade_B: [60, "Grade B threshold"], grade_C: [46, "Grade C threshold"],
    posture_per_point: [5, "Posture points per weighted signal point"],
    conf_H: [1.0, "Multiplier for high-confidence signals"], conf_M: [0.75, "Multiplier for medium-confidence signals"], conf_L: [0.5, "Multiplier for low-confidence signals"],
    decay_90: [1.0, "Weight of signals observed in the last 90 days"], decay_180: [0.75, "Weight of signals 90-180 days old"],
    decay_365: [0.5, "Weight of signals 180-365 days old"], decay_old: [0.25, "Weight of signals older than a year"],
  },
};

export function ensureWeights(db) {
  const ins = db.prepare("INSERT OR IGNORE INTO weights(model,key,value,label) VALUES(?,?,?,?)");
  for (const [model, keys] of Object.entries(DEFAULT_WEIGHTS)) {
    for (const [k, [v, label]] of Object.entries(keys)) ins.run(model, k, v, label);
  }
}

export function loadWeights(db, model) {
  const w = {};
  for (const r of all(db, "SELECT key, value, label FROM weights WHERE model = ?", model)) w[r.key] = r.value;
  return w;
}

export function setWeight(db, model, key, value) {
  if (!(model in DEFAULT_WEIGHTS) || !(key in DEFAULT_WEIGHTS[model])) throw new Error(`unknown weight ${model}/${key}`);
  run(db, "UPDATE weights SET value = ? WHERE model = ? AND key = ?", Number(value), model, key);
}

export function resetWeights(db, model) {
  for (const [k, [v]] of Object.entries(DEFAULT_WEIGHTS[model])) run(db, "UPDATE weights SET value=? WHERE model=? AND key=?", v, model, k);
}

// --- shared signal weighting ---------------------------------------------
function ageDays(dateStr, now = new Date()) {
  const d = new Date(dateStr + (dateStr.length === 10 ? "T00:00:00Z" : ""));
  return Math.max(0, (now - d) / 86400000);
}
function decayFor(w, days) {
  if (days <= 90) return w.decay_90;
  if (days <= 180) return w.decay_180;
  if (days <= 365) return w.decay_365;
  return w.decay_old;
}
export function weightedPoints(signal, w, now = new Date()) {
  const conf = w[`conf_${signal.confidence}`] ?? 0.75;
  const decay = decayFor(w, ageDays(signal.observed_at, now));
  return signal.direction * signal.strength * conf * decay;
}

function activeSignals(db, entityType, id) {
  return all(db, "SELECT * FROM signals WHERE entity_type=? AND entity_id=? AND review_status <> 'dismissed' ORDER BY observed_at DESC", entityType, id);
}

function readConfidence(signals) {
  if (!signals.length) return "unread";
  const pts = { H: 3, M: 2, L: 1 };
  const avg = signals.reduce((a, s) => a + pts[s.confidence], 0) / signals.length;
  const recent = signals.filter((s) => ageDays(s.observed_at) <= 180).length;
  if (signals.length >= 4 && avg >= 2.2 && recent >= 2) return "H";
  if (signals.length >= 2 && avg >= 1.6) return "M";
  return "L";
}

// --- Operator: AI Penetration Index ---------------------------------------
export function scoreOperator(db, op, opts = {}) {
  const w = opts.weights ?? loadWeights(db, "operator");
  const signals = opts.signals ?? activeSignals(db, "operator", op.id);
  const raw = { adoption: 0, pressure: 0, openness: 0 };
  const contributions = [];
  for (const s of signals) {
    if (!(s.dimension in raw)) continue;
    const pts = weightedPoints(s, w);
    raw[s.dimension] += pts;
    contributions.push({ id: s.id, dimension: s.dimension, title: s.title, points: round(pts) });
  }
  const adoption = clamp(raw.adoption * w.adoption_per_point, 0, w.adoption_max);
  const pressure = clamp(raw.pressure * w.pressure_per_point, 0, w.pressure_max);
  const openness = clamp(raw.openness * w.openness_per_point, 0, w.openness_max);
  const total = round(adoption + pressure + openness);
  let stage = "unread";
  if (signals.some((s) => s.dimension === "adoption") || signals.length >= 2) {
    stage = adoption >= w.stage_compounding ? "compounding"
      : adoption >= w.stage_deploying ? "deploying"
      : adoption >= w.stage_experimenting ? "experimenting" : "untouched";
  }
  const moment = round(pressure + openness);
  const confidence = readConfidence(signals);
  const sponsor = one(db, "SELECT s.id, s.name FROM ownership o JOIN sponsors s ON s.id=o.sponsor_id WHERE o.operator_id=? ORDER BY o.confidence LIMIT 1", op.id);
  let play = "Growth Client";
  if (sponsor) {
    const sp = latestScore(db, "sponsor", sponsor.id);
    play = sp?.play === "Exit-Unlock" ? "Exit-Unlock (via sponsor)" : sp?.play === "Both" ? "Both (qualify via sponsor)" : "Growth Client (sponsor channel)";
  } else if (op.pe_backed) play = "Both (sponsor unverified)";
  return {
    total, stage, play, confidence,
    components: {
      adoption: round(adoption), pressure: round(pressure), openness: round(openness), moment,
      raw: { adoption: round(raw.adoption), pressure: round(raw.pressure), openness: round(raw.openness) },
      signal_count: signals.length, contributions, sponsor: sponsor?.name ?? null,
    },
  };
}

// --- Sponsor: Exit-Unlock Fit + AI Posture --------------------------------
export function normalizeBand(prefix, value, w) {
  const v = (value || "").trim();
  if (`${prefix}:${v}` in w) return v;
  // tolerant matching for hand-typed sheet values
  const lower = v.toLowerCase();
  const keys = Object.keys(w).filter((k) => k.startsWith(prefix + ":")).map((k) => k.slice(prefix.length + 1));
  const hit = keys.find((k) => k.toLowerCase() === lower) ?? keys.find((k) => lower && k.toLowerCase().startsWith(lower.split(" ")[0]));
  return hit ?? "Verify";
}

export function scoreSponsor(db, sp, opts = {}) {
  const w = opts.weights ?? loadWeights(db, "sponsor");
  const aum = normalizeBand("aum", sp.aum_band, w);
  const sig = normalizeBand("sig", sp.fundraising_signal, w);
  const vert = normalizeBand("vert", sp.vertical_fit, w) === "Verify" ? "Strong" : normalizeBand("vert", sp.vertical_fit, w);
  const ops = normalizeBand("ops", sp.ops_model, w) === "Verify" ? "Some Ops" : normalizeBand("ops", sp.ops_model, w);
  const reg = normalizeBand("reg", sp.region, w) === "Verify" ? "National" : normalizeBand("reg", sp.region, w);
  const mom = normalizeBand("mom", sp.momentum_band || momentumFromStatus(sp.engagement_status), w) === "Verify" ? "Not started / Researching" : normalizeBand("mom", sp.momentum_band || momentumFromStatus(sp.engagement_status), w);
  const parts = {
    aum: { band: aum, points: w[`aum:${aum}`] ?? 0 },
    signal: { band: sig, points: w[`sig:${sig}`] ?? 0 },
    vertical: { band: vert, points: w[`vert:${vert}`] ?? 0 },
    ops: { band: ops, points: w[`ops:${ops}`] ?? 0 },
    region: { band: reg, points: w[`reg:${reg}`] ?? 0 },
    momentum: { band: mom, points: w[`mom:${mom}`] ?? 0 },
  };
  const fit = Object.values(parts).reduce((a, p) => a + p.points, 0);
  const grade = fit >= w.grade_A ? "A" : fit >= w.grade_B ? "B" : fit >= w.grade_C ? "C" : "D";
  const zombie = ["5+ yrs / pre-2021", "4 yrs / 2021"].includes(sig);
  const fresh = ["0-1 yr / 2024-25", "2 yrs / 2023"].includes(sig);
  const subFive = ["<$1B", "$1-3B", "$3-5B"].includes(aum);
  const play = zombie && subFive ? "Exit-Unlock" : fresh ? "Growth Client" : "Both";

  // AI posture from signals
  const signals = opts.signals ?? activeSignals(db, "sponsor", sp.id);
  const raw = { posture: 0, mandate: 0, vintage: 0, activity: 0 };
  const contributions = [];
  for (const s of signals) {
    if (!(s.dimension in raw)) continue;
    const pts = weightedPoints(s, w);
    raw[s.dimension] += pts;
    contributions.push({ id: s.id, dimension: s.dimension, title: s.title, points: round(pts) });
  }
  const postureScore = clamp((raw.posture + raw.mandate + raw.activity * 0.5) * w.posture_per_point, 0, 100);
  const pressureScore = clamp(raw.vintage * w.posture_per_point, 0, 100);
  const hasRead = signals.length > 0;
  const posture = !hasRead ? "unread" : postureScore >= 60 ? "AI-forward" : postureScore >= 30 ? "active" : postureScore >= 10 ? "forming" : "passive";
  const portcos = one(db, "SELECT COUNT(*) AS n FROM ownership WHERE sponsor_id=?", sp.id)?.n ?? 0;
  return {
    total: fit, grade, play, stage: posture, confidence: hasRead ? readConfidence(signals) : (sp.data_confidence || "L"),
    components: {
      fit_parts: parts, fit, grade, play, sheet_play: sp.sheet_play || null, sheet_fit: sp.sheet_fit ?? null,
      posture: round(postureScore), exit_pressure: round(pressureScore), posture_stage: posture,
      raw: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, round(v)])),
      signal_count: signals.length, contributions, portcos,
    },
  };
}

export function momentumFromStatus(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("existing client") || s.includes("partner")) return "Existing client / Partner";
  if (s.includes("meeting") || s.includes("dialogue") || s.includes("discovery")) return "Meeting set / In dialogue";
  if (s.includes("not interested") || s.includes("declined") || s.includes("not taking")) return "Not interested / Declined";
  if (s.includes("intro")) return "Intro pending";
  if (s.includes("email") || s.includes("contacted") || s.includes("no response")) return "Contacted / Emailed";
  return "Not started / Researching";
}

// --- persistence ------------------------------------------------------------
export function latestScore(db, entityType, id) {
  const r = one(db, "SELECT * FROM scores WHERE entity_type=? AND entity_id=? ORDER BY computed_at DESC, id DESC LIMIT 1", entityType, id);
  return r ? { ...r, components: JSON.parse(r.components) } : null;
}

export function scoreAsOf(db, entityType, id, isoDate) {
  const r = one(db, "SELECT * FROM scores WHERE entity_type=? AND entity_id=? AND computed_at <= ? ORDER BY computed_at DESC, id DESC LIMIT 1", entityType, id, isoDate);
  return r ? { ...r, components: JSON.parse(r.components) } : null;
}

// Recompute and persist. Writes a new score row only when something changed (or force).
export function rescoreAll(db, { force = false } = {}) {
  ensureWeights(db);
  const wOp = loadWeights(db, "operator");
  const wSp = loadWeights(db, "sponsor");
  const ins = db.prepare("INSERT INTO scores(entity_type,entity_id,total,stage,play,grade,confidence,components) VALUES(?,?,?,?,?,?,?,?)");
  let changed = 0;
  // sponsors first: operator play depends on sponsor play
  for (const sp of all(db, "SELECT * FROM sponsors")) {
    const s = scoreSponsor(db, sp, { weights: wSp });
    if (force || differs(latestScore(db, "sponsor", sp.id), s)) { ins.run("sponsor", sp.id, s.total, s.stage, s.play, s.grade, s.confidence, JSON.stringify(s.components)); changed++; }
  }
  for (const op of all(db, "SELECT * FROM operators")) {
    const s = scoreOperator(db, op, { weights: wOp });
    if (force || differs(latestScore(db, "operator", op.id), s)) { ins.run("operator", op.id, s.total, s.stage, s.play, null, s.confidence, JSON.stringify(s.components)); changed++; }
  }
  return { changed };
}

function differs(prev, next) {
  if (!prev) return true;
  return prev.total !== next.total || prev.stage !== next.stage || prev.play !== next.play || prev.confidence !== next.confidence
    || (prev.grade ?? null) !== (next.grade ?? null)
    || (prev.components.signal_count ?? 0) !== (next.components.signal_count ?? 0)
    || (prev.components.posture ?? null) !== (next.components.posture ?? null)
    || (prev.components.portcos ?? null) !== (next.components.portcos ?? null);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round(v) { return Math.round(v * 10) / 10; }
