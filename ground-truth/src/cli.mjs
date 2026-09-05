#!/usr/bin/env node
import { openDb, closeDb, all, one, run, setMeta, getMeta, getEntity } from "./db.mjs";
import { importOperators, importSponsors, deriveImportSignals, seedOwnership } from "./importer.mjs";
import { rescoreAll, ensureWeights, latestScore } from "./scoring.mjs";
import { syncActions } from "./actions.mjs";
import { whatMoved } from "./week.mjs";
import { validateSignal } from "./signals.mjs";
import { startServer } from "./server.mjs";
import { readEntity, findEntityByName } from "./agent/reader.mjs";
import { writeBriefNarrative } from "./agent/brief.mjs";

const [cmd = "help", ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(rest.filter((a) => a.startsWith("--")).map((a) => { const [k, v = "true"] = a.slice(2).split("="); return [k, v]; }));
const args = rest.filter((a) => !a.startsWith("--"));

const HELP = `Intrinsic Ground Truth — v1

  npm run setup            create the database, import both pipeline sheets, derive first signals, score, generate actions
  npm start                serve the UI + API on http://localhost:${process.env.IGT_PORT || 4310}
  npm run import           re-import data/source/*.csv (idempotent; keeps manual and agent signals)
  npm run rescore          recompute every score and regenerate actions
  npm run week             print "what moved" for the last 7 days (--days=14 to widen)
  npm run scan -- "<name>" run the agent reader on one operator or sponsor (needs ANTHROPIC_API_KEY)
  node src/cli.mjs scan --tier=T1 --limit=5 --type=operator      batch-read the unread T1 operators
  node src/cli.mjs signal --type=operator --name="Dayton Freight Lines" --dimension=openness --category=tech_job_posting --title="Posted Director of Automation" [--url=...] [--confidence=H] [--strength=3] [--observed=2026-09-01]
  node src/cli.mjs brief   write the weekly brief (adds a Claude narrative when a key is present)
`;

async function main() {
  const db = openDb();
  switch (cmd) {
    case "setup": {
      ensureWeights(db);
      const a = importOperators(db);
      const b = importSponsors(db);
      const c = deriveImportSignals(db);
      const d = seedOwnership(db);
      const e = rescoreAll(db, { force: true });
      const f = syncActions(db);
      setMeta(db, "last_import", new Date().toISOString());
      console.log(`Imported ${a.operators} operators (${a.contacts} contacts), ${b.sponsors} sponsors, ${d.links} ownership link(s).`);
      console.log(`Derived ${c.signals} low-confidence import signals. Scored ${e.changed} entities. Actions: ${f.created} created, ${f.open} open.`);
      console.log(`\nRun: npm start`);
      break;
    }
    case "import": {
      const a = importOperators(db); const b = importSponsors(db); const c = deriveImportSignals(db); const d = seedOwnership(db);
      const e = rescoreAll(db); const f = syncActions(db);
      setMeta(db, "last_import", new Date().toISOString());
      console.log(JSON.stringify({ ...a, ...b, ...c, ...d, scores_changed: e.changed, actions: f }, null, 2));
      break;
    }
    case "rescore": {
      const e = rescoreAll(db, { force: flags.force === "true" }); const f = syncActions(db);
      console.log(JSON.stringify({ scores_changed: e.changed, actions: f }, null, 2));
      break;
    }
    case "week": {
      const w = whatMoved(db, { windowDays: Number(flags.days || 7) });
      if (flags.json === "true") { console.log(JSON.stringify(w, null, 2)); break; }
      console.log(`WHAT MOVED — last ${w.window_days} days (since ${w.since})`);
      console.log(`${w.counts.operators} operators (${w.counts.operators_read} read) · ${w.counts.sponsors} sponsors · ${w.counts.signals_window} new signals · ${w.counts.open_actions} open actions\n`);
      if (!w.movers.length) console.log("No movement. Add a signal or run a scan.");
      for (const m of w.movers.slice(0, 15)) console.log(`  ${m.entity_type === "operator" ? "OP" : "PE"}  ${m.name.padEnd(38)} ${m.from ?? "—"} → ${m.to}  ${m.stage_from && m.stage_from !== m.stage_to ? m.stage_from + " → " + m.stage_to : m.stage_to}  (+${m.new_signals} signals)`);
      console.log("\nTOP ACTIONS");
      for (const a of w.actions.slice(0, 10)) console.log(`  [${String(a.priority).padStart(3)}] ${a.headline}\n        play: ${a.play} · path: ${a.trusted_path || "—"} · timing: ${a.timing || "—"}`);
      break;
    }
    case "signal": {
      const type = flags.type || "operator";
      const ent = findEntityByName(db, type, flags.name || args[0]);
      if (!ent) throw new Error(`no ${type} matching '${flags.name || args[0]}'`);
      const s = validateSignal(type, { dimension: flags.dimension, category: flags.category, title: flags.title, detail: flags.detail, strength: flags.strength, confidence: flags.confidence, direction: flags.direction, source_url: flags.url, observed_at: flags.observed || new Date().toISOString().slice(0, 10) });
      run(db, `INSERT INTO signals(entity_type,entity_id,dimension,category,direction,strength,confidence,title,detail,source_type,source_url,observed_at,review_status,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,'manual',?,?,'accepted',?)`, type, ent.id, s.dimension, s.category, s.direction, s.strength, s.confidence, s.title, s.detail || null, s.source_url || null, s.observed_at, process.env.USER || "cli");
      rescoreAll(db); syncActions(db);
      console.log(`Added signal to ${ent.name}. New score:`, latestScore(db, type, ent.id).total);
      break;
    }
    case "scan": {
      const type = flags.type || "operator";
      let targets = [];
      if (args[0] || flags.name) {
        const ent = findEntityByName(db, type, flags.name || args[0]);
        if (!ent) throw new Error(`no ${type} matching '${flags.name || args[0]}'`);
        targets = [ent];
      } else {
        const table = type === "operator" ? "operators" : "sponsors";
        const tier = flags.tier ? `AND tier='${flags.tier.replace(/'/g, "")}'` : "";
        targets = all(db, `SELECT e.* FROM ${table} e WHERE 1=1 ${tier} AND NOT EXISTS (SELECT 1 FROM scans sc WHERE sc.entity_type=? AND sc.entity_id=e.id AND sc.status='done') ORDER BY COALESCE(fit_score, sheet_fit, 0) DESC LIMIT ?`, type, Number(flags.limit || 5));
      }
      for (const t of targets) {
        console.log(`\n→ reading ${type} ${t.name} …`);
        const r = await readEntity(db, type, t.id, { log: (m) => console.log("   " + m) });
        console.log(`   ${r.status}: ${r.signals_found} signals, score ${latestScore(db, type, t.id)?.total}. ${r.summary?.slice(0, 200) || r.error || ""}`);
      }
      syncActions(db);
      break;
    }
    case "brief": {
      const w = whatMoved(db, { windowDays: Number(flags.days || 7) });
      const narrative = await writeBriefNarrative(w).catch((e) => `(narrative skipped: ${e.message})`);
      run(db, "INSERT INTO briefs(week_of, body, narrative) VALUES(?,?,?)", w.since, JSON.stringify(w), narrative);
      console.log(narrative);
      break;
    }
    case "serve": {
      ensureWeights(db);
      if (!one(db, "SELECT 1 FROM operators LIMIT 1")) console.log("Database is empty — run `npm run setup` first.");
      await startServer(db, { port: Number(process.env.IGT_PORT || flags.port || 4310) });
      return; // keep process alive
    }
    default:
      console.log(HELP);
  }
  closeDb();
}

main().catch((e) => { console.error("error:", e.message); if (process.env.IGT_DEBUG) console.error(e); process.exit(1); });
