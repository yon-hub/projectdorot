// "What moved this week?" - the question the engine exists to answer.
import { all, one } from "./db.mjs";
import { latestScore, scoreAsOf } from "./scoring.mjs";

function firstScore(db, type, id) {
  const r = one(db, "SELECT * FROM scores WHERE entity_type=? AND entity_id=? ORDER BY computed_at ASC, id ASC LIMIT 1", type, id);
  return r ? { ...r, components: JSON.parse(r.components) } : null;
}

export function whatMoved(db, { windowDays = 7 } = {}) {
  const sinceIso = new Date(Date.now() - windowDays * 86400000).toISOString().replace("T", " ").slice(0, 19);
  const sinceDate = sinceIso.slice(0, 10);
  const movers = [];
  for (const type of ["operator", "sponsor"]) {
    const table = type === "operator" ? "operators" : "sponsors";
    for (const e of all(db, `SELECT id, name FROM ${table}`)) {
      const now = latestScore(db, type, e.id);
      if (!now) continue;
      // Compare against the score at the start of the window, or the entity's first score if it is younger than the window.
      const before = scoreAsOf(db, type, e.id, sinceIso) ?? firstScore(db, type, e.id);
      const newSignals = one(db, "SELECT COUNT(*) AS n FROM signals WHERE entity_type=? AND entity_id=? AND created_at >= ? AND review_status<>'dismissed' AND source_type<>'import'", type, e.id, sinceIso).n;
      if (!before || (before.id === now.id && newSignals === 0)) continue; // baseline only: nothing has moved
      const delta = now.total - before.total;
      const stageChanged = before.stage !== now.stage;
      if (Math.abs(delta) >= 5 || stageChanged || newSignals > 0) {
        movers.push({ entity_type: type, entity_id: e.id, name: e.name, from: before?.total ?? null, to: now.total, delta, stage_from: before?.stage ?? null, stage_to: now.stage, new_signals: newSignals, play: now.play, grade: now.grade ?? null });
      }
    }
  }
  movers.sort((a, b) => (Math.abs(b.delta ?? 0) + b.new_signals * 3) - (Math.abs(a.delta ?? 0) + a.new_signals * 3));

  const signals = all(db, `SELECT s.*, CASE s.entity_type WHEN 'operator' THEN (SELECT name FROM operators WHERE id=s.entity_id) ELSE (SELECT name FROM sponsors WHERE id=s.entity_id) END AS entity_name
    FROM signals s WHERE s.created_at >= ? AND s.review_status<>'dismissed' AND s.source_type<>'import' ORDER BY s.created_at DESC LIMIT 200`, sinceIso);

  // Subsector front: average adoption by sector/subsector across read operators.
  const front = all(db, `SELECT o.sector, o.subsector, COUNT(*) AS n,
      SUM(CASE WHEN sc.stage='unread' THEN 1 ELSE 0 END) AS unread,
      SUM(CASE WHEN sc.stage='untouched' THEN 1 ELSE 0 END) AS untouched,
      SUM(CASE WHEN sc.stage='experimenting' THEN 1 ELSE 0 END) AS experimenting,
      SUM(CASE WHEN sc.stage='deploying' THEN 1 ELSE 0 END) AS deploying,
      SUM(CASE WHEN sc.stage='compounding' THEN 1 ELSE 0 END) AS compounding,
      ROUND(AVG(json_extract(sc.components,'$.adoption')),1) AS avg_adoption,
      ROUND(AVG(json_extract(sc.components,'$.moment')),1) AS avg_moment
    FROM operators o JOIN scores sc ON sc.id = (SELECT id FROM scores WHERE entity_type='operator' AND entity_id=o.id ORDER BY computed_at DESC, id DESC LIMIT 1)
    GROUP BY o.sector, o.subsector ORDER BY o.sector, n DESC`);

  const actions = all(db, "SELECT * FROM actions WHERE status='open' ORDER BY priority DESC, updated_at DESC LIMIT 25").map((a) => ({ ...a, evidence: JSON.parse(a.evidence || "[]") }));
  const counts = {
    operators: one(db, "SELECT COUNT(*) AS n FROM operators").n,
    sponsors: one(db, "SELECT COUNT(*) AS n FROM sponsors").n,
    operators_read: one(db, "SELECT COUNT(*) AS n FROM scores s WHERE s.entity_type='operator' AND s.stage<>'unread' AND s.id=(SELECT id FROM scores WHERE entity_type='operator' AND entity_id=s.entity_id ORDER BY computed_at DESC, id DESC LIMIT 1)").n,
    signals_total: one(db, "SELECT COUNT(*) AS n FROM signals WHERE review_status<>'dismissed'").n,
    signals_window: signals.length,
    unreviewed: one(db, "SELECT COUNT(*) AS n FROM signals WHERE review_status='unreviewed'").n,
    open_actions: one(db, "SELECT COUNT(*) AS n FROM actions WHERE status='open'").n,
    ownership_links: one(db, "SELECT COUNT(*) AS n FROM ownership").n,
    scans: one(db, "SELECT COUNT(*) AS n FROM scans WHERE status='done'").n,
  };
  return { window_days: windowDays, since: sinceDate, generated_at: new Date().toISOString(), counts, movers: movers.slice(0, 40), signals, front, actions };
}
