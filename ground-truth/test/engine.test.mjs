import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, run, one, all } from "../src/db.mjs";
import { importOperators, importSponsors, deriveImportSignals, seedOwnership } from "../src/importer.mjs";
import { ensureWeights, rescoreAll, latestScore, scoreSponsor, scoreOperator, loadWeights, setWeight } from "../src/scoring.mjs";
import { syncActions } from "../src/actions.mjs";
import { whatMoved } from "../src/week.mjs";
import { validateSignal, taxonomyList } from "../src/signals.mjs";
import { parseCsv } from "../src/csv.mjs";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(ROOT, "src/schema.sql"), "utf8"));
  ensureWeights(db);
  return db;
}

test("csv parser handles quotes, commas and newlines", () => {
  const rows = parseCsv('a,b,c\n"x, y","he said ""hi""","line1\nline2"\n');
  assert.deepEqual(rows[1], ["x, y", 'he said "hi"', "line1\nline2"]);
});

test("import reproduces the sheets and the sheet's Exit-Unlock fit scores", () => {
  const db = freshDb();
  const a = importOperators(db); const b = importSponsors(db);
  assert.equal(a.operators, 383); assert.equal(b.sponsors, 109);
  deriveImportSignals(db); seedOwnership(db); rescoreAll(db, { force: true });
  // Every sponsor with a sheet fit score must re-score to exactly that number at default weights.
  const mism = all(db, "SELECT name, sheet_fit FROM sponsors WHERE sheet_fit IS NOT NULL").filter((s) => {
    const sc = latestScore(db, "sponsor", one(db, "SELECT id FROM sponsors WHERE name=?", s.name).id);
    return sc.total !== s.sheet_fit;
  });
  assert.deepEqual(mism.map((m) => m.name), [], `fit mismatches: ${JSON.stringify(mism)}`);
  // Play tags follow the sheet's rule.
  const pf = one(db, "SELECT * FROM sponsors WHERE name='Pfingsten Partners'");
  assert.equal(scoreSponsor(db, pf).play, "Exit-Unlock");
  const core = one(db, "SELECT * FROM sponsors WHERE name='CORE Industrial Partners'");
  assert.equal(scoreSponsor(db, core).play, "Growth Client");
  // Operators with no signals are 'unread', not 'untouched'.
  const unread = one(db, "SELECT COUNT(*) AS n FROM scores s WHERE entity_type='operator' AND stage='unread' AND id=(SELECT id FROM scores WHERE entity_type='operator' AND entity_id=s.entity_id ORDER BY computed_at DESC, id DESC LIMIT 1)").n;
  assert.ok(unread > 300);
  // The seeded join exists.
  assert.equal(one(db, "SELECT COUNT(*) AS n FROM ownership").n, 1);
});

test("signals move the index, stage, actions and the weekly view", () => {
  const db = freshDb();
  importOperators(db); importSponsors(db); rescoreAll(db, { force: true });
  const op = one(db, "SELECT * FROM operators WHERE name='Dayton Freight Lines'");
  assert.equal(latestScore(db, "operator", op.id).stage, "unread");
  const add = (dimension, category, title, conf = "H", strength = 4, when = new Date().toISOString().slice(0, 10)) => {
    const s = validateSignal("operator", { dimension, category, title, confidence: conf, strength });
    run(db, "INSERT INTO signals(entity_type,entity_id,dimension,category,direction,strength,confidence,title,source_type,observed_at) VALUES('operator',?,?,?,?,?,?,?,'manual',?)", op.id, s.dimension, s.category, s.direction, s.strength, s.confidence, s.title, when);
  };
  add("openness", "tech_job_posting", "Posted Director of Automation");
  add("pressure", "labor_gap", "Driver shortage cited in earnings call");
  add("adoption", "ai_pilot", "Piloting AI dispatch", "M", 2);
  rescoreAll(db);
  const sc = latestScore(db, "operator", op.id);
  assert.equal(sc.stage, "untouched"); // adoption 2*0.75*4 = 6 < 8
  assert.equal(sc.components.openness, 12); assert.equal(sc.components.pressure, 12);
  assert.equal(sc.total, 30);
  const acts = syncActions(db);
  assert.ok(acts.open > 0);
  const pre = one(db, "SELECT * FROM actions WHERE key=?", `prebuyer:${op.id}`);
  assert.ok(pre, "pre-buyer window action should exist");
  assert.match(pre.message_angle, /driver shortage/i);
  // Dismissing a signal removes its contribution.
  run(db, "UPDATE signals SET review_status='dismissed' WHERE title='Posted Director of Automation'");
  rescoreAll(db);
  assert.equal(latestScore(db, "operator", op.id).components.openness, 0);
  // Weekly view sees the new signals; import signals never count as movement.
  deriveImportSignals(db); rescoreAll(db);
  const w = whatMoved(db);
  const m = w.movers.find((x) => x.name === "Dayton Freight Lines");
  assert.ok(m && m.new_signals === 2);
  assert.ok(w.signals.every((s) => s.source_type !== "import"));
});

test("weights are live and the taxonomy validates", () => {
  const db = freshDb();
  importSponsors(db); rescoreAll(db, { force: true });
  const sp = one(db, "SELECT * FROM sponsors WHERE name='Huron Capital'");
  const before = scoreSponsor(db, sp).total;
  setWeight(db, "sponsor", "reg:Great Lakes", 0);
  assert.equal(scoreSponsor(db, sp).total, before - 10);
  assert.throws(() => validateSignal("operator", { dimension: "posture", category: "x", title: "t" }));
  assert.ok(taxonomyList("sponsor").some((t) => t.category === "ai_op_partner"));
  assert.throws(() => setWeight(db, "sponsor", "nope", 1));
});
