// Turns the two maps and their scores into named next actions for named accounts.
// Deterministic and explainable: each action carries the play, the message angle,
// the trusted path, the timing, and the signal ids it rests on. Regeneration upserts
// by stable key, so a dismissed action stays dismissed and a done action stays done.

import { all, one, run, transaction } from "./db.mjs";
import { latestScore, scoreAsOf } from "./scoring.mjs";

const daysAgoIso = (d) => new Date(Date.now() - d * 86400000).toISOString().replace("T", " ").slice(0, 19);

export function deriveActions(db, { windowDays = 7 } = {}) {
  const since = daysAgoIso(windowDays);
  const proposals = [];
  const ops = all(db, "SELECT * FROM operators");
  const sps = all(db, "SELECT * FROM sponsors");

  // ---- sponsors -----------------------------------------------------------
  for (const sp of sps) {
    const sc = latestScore(db, "sponsor", sp.id);
    if (!sc) continue;
    const c = sc.components;
    const portcos = all(db, "SELECT o.*, ow.confidence AS link_conf FROM ownership ow JOIN operators o ON o.id=ow.operator_id WHERE ow.sponsor_id=?", sp.id);
    const sigs = recentSignals(db, "sponsor", sp.id, 180);
    const path = sp.intro_path || (sp.target_poc ? `Direct to ${sp.target_poc} (${sp.entry_seat || "operating seat"}) — warm intro still preferred` : "Map an intro path before contact (rule: no cold outreach to PE)");
    const declined = /declined|not interested/i.test(sp.momentum_band || "") || /not interested/i.test(sp.engagement_status || "");

    // The join: sponsor with low-penetration portcos.
    const lowPen = portcos.filter((p) => { const s = latestScore(db, "operator", p.id); return s && ["unread", "untouched", "experimenting"].includes(s.stage); });
    if (portcos.length && lowPen.length && !declined) {
      proposals.push({
        key: `join:${sp.id}`, entity_type: "sponsor", entity_id: sp.id, kind: "portfolio_read",
        priority: 95 - Math.min(20, (100 - sc.total) / 4),
        play: sc.play,
        headline: `${sp.name}: ${lowPen.length} of ${portcos.length} known portco${portcos.length > 1 ? "s" : ""} sit low on the adoption front`,
        message_angle: sc.play === "Exit-Unlock"
          ? `"We ran our read on your portfolio. ${lowPen.map((p) => p.name).join(", ")} ${lowPen.length > 1 ? "have" : "has"} no visible AI story — here is where the EBITDA is hiding and how that changes sellability."`
          : `"We ran our read on your portfolio — ${lowPen.map((p) => p.name).join(", ")} ${lowPen.length > 1 ? "are" : "is"} behind peers on adoption. Here is the value-creation gap in EBITDA terms."`,
        trusted_path: path,
        timing: "Now — offer the portfolio read as the first conversation",
        reasoning: `Sponsor fit ${sc.total} (grade ${sc.grade}), play ${sc.play}. Portcos below 'deploying': ${lowPen.map((p) => `${p.name} (${latestScore(db, "operator", p.id).stage})`).join("; ")}.`,
        evidence: sigs.map((s) => s.id), confidence: sc.confidence,
      });
    }

    // Grade-A sponsor with nothing in motion.
    if (sc.grade === "A" && /Not started/i.test(sp.momentum_band || "") && !declined) {
      proposals.push({
        key: `sponsor-open:${sp.id}`, entity_type: "sponsor", entity_id: sp.id, kind: "open_channel",
        priority: 80 + (sc.total - 74) / 2,
        play: sc.play,
        headline: `${sp.name}: grade-A fit, nothing in motion`,
        message_angle: sc.play === "Exit-Unlock"
          ? `Open with the longest-held-asset question: "What's your longest-held asset — and what's preventing you from selling it?" Then offer the AI exit-readiness audit.`
          : sc.play === "Growth Client"
            ? "Lead with EBITDA and workflow KPIs across the newest platforms; offer a Sprint on one portco as proof."
            : "Qualify live: ask about fund status and the oldest asset, then choose exit-unlock vs value-creation framing.",
        trusted_path: path,
        timing: sp.region === "Ohio" || sp.region === "Great Lakes" ? "This week (Heartland tier)" : "This month",
        reasoning: `Exit-Unlock Fit ${sc.total}: ${Object.entries(c.fit_parts).map(([k, v]) => `${k} ${v.points} (${v.band})`).join(", ")}. ${sp.hook || ""}`.trim(),
        evidence: sigs.map((s) => s.id), confidence: sp.data_confidence || "L",
      });
    }

    // Posture moved: mandate or posture signal in the window.
    const moved = sigs.filter((s) => s.created_at >= since && s.source_type !== "import" && ["mandate", "posture", "vintage"].includes(s.dimension));
    if (moved.length && !declined) {
      const top = moved[0];
      proposals.push({
        key: `sponsor-moved:${sp.id}:${top.id}`, entity_type: "sponsor", entity_id: sp.id, kind: "moved",
        priority: 85,
        play: sc.play,
        headline: `${sp.name} moved: ${top.title}`,
        message_angle: top.dimension === "mandate"
          ? "Congratulate the hire, then offer the portfolio read as their first 90-day instrument."
          : top.dimension === "vintage"
            ? "Reference the fund situation obliquely; lead with making the longest-held asset sellable."
            : "Cite their own AI language back to them; propose a portco Sprint that proves it in EBITDA.",
        trusted_path: path,
        timing: "Within 2 weeks of the signal",
        reasoning: `${moved.length} sponsor signal${moved.length > 1 ? "s" : ""} in the last ${windowDays} days. Posture now '${c.posture_stage}' (${c.posture}/100).`,
        evidence: moved.map((s) => s.id), confidence: top.confidence,
      });
    }

    // Verify before citing: low-confidence zombie signal on an exit-unlock play.
    if (sc.play === "Exit-Unlock" && (sp.data_confidence || "L") === "L" && !declined) {
      proposals.push({
        key: `verify:${sp.id}`, entity_type: "sponsor", entity_id: sp.id, kind: "verify",
        priority: 55, play: sc.play,
        headline: `Verify ${sp.name}'s fund vintage before citing "no fund since"`,
        message_angle: null,
        trusted_path: null,
        timing: "Before first contact",
        reasoning: `Exit-Unlock play rests on '${sp.fundraising_signal}' with data confidence L. Run a read or confirm via PitchBook before the zombie framing goes in an email.`,
        evidence: [], confidence: "L",
      });
    }
  }

  // ---- operators -----------------------------------------------------------
  for (const op of ops) {
    const sc = latestScore(db, "operator", op.id);
    if (!sc) continue;
    const c = sc.components;
    const prev = scoreAsOf(db, "operator", op.id, since);
    const sigs = recentSignals(db, "operator", op.id, 365);
    const declined = sigs.some((s) => s.category === "declined" && s.review_status !== "dismissed");
    const path = op.warm_intro_via ? `Warm intro via ${op.warm_intro_via}` : op.pe_backed && c.sponsor ? `Through sponsor ${c.sponsor}` : "No trusted path yet — map advisors (bank, insurance broker, law firm) before direct outreach";
    const contact = one(db, "SELECT name, title FROM contacts WHERE entity_type='operator' AND entity_id=? ORDER BY CASE WHEN title LIKE '%COO%' OR title LIKE '%Operations%' THEN 0 WHEN title LIKE '%CEO%' OR title LIKE '%President%' THEN 1 ELSE 2 END LIMIT 1", op.id);
    const who = contact ? `${contact.name}${contact.title ? " (" + contact.title + ")" : ""}` : "operations leader (identify)";

    // Threshold crossing / movement in the window.
    const newSigs = sigs.filter((s) => s.created_at >= since && s.source_type !== "import");
    if (prev && newSigs.length && (sc.total - prev.total >= 10 || (prev.stage !== sc.stage && sc.stage !== "unread"))) {
      proposals.push({
        key: `op-moved:${op.id}:${sc.id}`, entity_type: "operator", entity_id: op.id, kind: "moved",
        priority: 90,
        play: sc.play,
        headline: `${op.name} moved ${prev.stage} → ${sc.stage} (${prev.total} → ${sc.total})`,
        message_angle: sc.stage === "untouched" || sc.stage === "experimenting"
          ? `Lead with the problem behind the signal (${newSigs[0]?.title || "recent change"}), not with AI. Offer what adoption looks like among ${op.subsector || op.sector} peers of their size.`
          : "They are already moving. Position as the firm that makes the deployment compound — cite the specific workflow.",
        trusted_path: path,
        timing: "This week — signals decay",
        reasoning: `Index moved ${prev.total} → ${sc.total} in ${windowDays} days on ${newSigs.length} new signal${newSigs.length === 1 ? "" : "s"}.`,
        evidence: newSigs.map((s) => s.id), confidence: sc.confidence,
      });
    }

    // Pre-buyer window: high openness/pressure, low adoption.
    if (!declined && c.moment >= 12 && c.adoption < 20 && sc.stage !== "unread") {
      proposals.push({
        key: `prebuyer:${op.id}`, entity_type: "operator", entity_id: op.id, kind: "pre_buyer_window",
        priority: 60 + Math.min(25, c.moment) + (op.tier === "T1" ? 5 : 0),
        play: sc.play,
        headline: `${op.name}: pressure and openness up, adoption still ${sc.stage}`,
        message_angle: `To ${who}: name the pressure we see (${topTitles(sigs, "pressure", 2)}), then what firms of their size in ${op.subsector || op.sector} are doing about it. No AI in the subject line.`,
        trusted_path: path,
        timing: op.tier === "T1" ? "This week" : "Next 30 days",
        reasoning: `Moment ${c.moment}/60 (pressure ${c.pressure}, openness ${c.openness}); adoption ${c.adoption}/40. ${op.pipeline_status ? "Pipeline status: " + op.pipeline_status + "." : ""}`,
        evidence: sigs.filter((s) => s.dimension !== "adoption").slice(0, 6).map((s) => s.id), confidence: sc.confidence,
      });
    }

    // Stuck in pipeline with a trusted path available.
    if (/stuck/i.test(op.pipeline_status || "") && op.warm_intro_via && !declined) {
      proposals.push({
        key: `reroute:${op.id}`, entity_type: "operator", entity_id: op.id, kind: "reroute",
        priority: 70,
        play: sc.play,
        headline: `${op.name} is stuck on cold — route through ${op.warm_intro_via}`,
        message_angle: `Ask ${op.warm_intro_via} for a three-line intro that names the problem, not the technology.`,
        trusted_path: path, timing: "This week",
        reasoning: `Cold outreach exhausted (${op.context || "no response"}), but a trusted path exists.`,
        evidence: [], confidence: "H",
      });
    }

    // Unread T1 account: the engine has never read it.
    if (sc.stage === "unread" && op.tier === "T1" && !declined) {
      proposals.push({
        key: `read:${op.id}`, entity_type: "operator", entity_id: op.id, kind: "run_read",
        priority: 40 + (op.fit_score || 0),
        play: sc.play,
        headline: `Run a read on ${op.name} (T1, never read)`,
        message_angle: null, trusted_path: path, timing: "Before next touch",
        reasoning: "A tier-1 account with no market signals. One agent read places it on the front and tells us which pitch fits.",
        evidence: [], confidence: "unread",
      });
    }
  }

  return proposals.map((p) => ({ ...p, priority: Math.round(Math.min(100, Math.max(1, p.priority))) }));
}

export function syncActions(db, opts) {
  const proposals = deriveActions(db, opts);
  const up = db.prepare(`INSERT INTO actions(key,entity_type,entity_id,kind,priority,play,headline,message_angle,trusted_path,timing,reasoning,evidence,confidence)
    VALUES(@key,@entity_type,@entity_id,@kind,@priority,@play,@headline,@message_angle,@trusted_path,@timing,@reasoning,@evidence,@confidence)
    ON CONFLICT(key) DO UPDATE SET priority=excluded.priority, play=excluded.play, headline=excluded.headline, message_angle=excluded.message_angle,
      trusted_path=excluded.trusted_path, timing=excluded.timing, reasoning=excluded.reasoning, evidence=excluded.evidence, confidence=excluded.confidence, updated_at=datetime('now')
      WHERE actions.status = 'open'`);
  let created = 0, updated = 0, retired = 0;
  transaction(db, () => {
    const keys = new Set(proposals.map((p) => p.key));
    for (const p of proposals) {
      const existed = one(db, "SELECT id FROM actions WHERE key=?", p.key);
      up.run({ ...p, evidence: JSON.stringify(p.evidence || []) });
      existed ? updated++ : created++;
    }
    // Open actions whose condition no longer holds are retired (not deleted) so the record survives.
    for (const a of all(db, "SELECT id, key FROM actions WHERE status='open'")) {
      if (!keys.has(a.key)) { run(db, "UPDATE actions SET status='retired', resolved_at=datetime('now'), resolution_note='Condition no longer holds' WHERE id=?", a.id); retired++; }
    }
  });
  return { created, updated, retired, open: one(db, "SELECT COUNT(*) AS n FROM actions WHERE status='open'").n };
}

function recentSignals(db, entityType, id, days) {
  return all(db, "SELECT * FROM signals WHERE entity_type=? AND entity_id=? AND review_status<>'dismissed' AND observed_at >= date('now', ?) ORDER BY observed_at DESC, id DESC", entityType, id, `-${days} days`);
}
function topTitles(sigs, dimension, n) {
  const t = sigs.filter((s) => s.dimension === dimension).slice(0, n).map((s) => s.title.replace(/\s*\(pipeline research\)/i, "").toLowerCase());
  return t.length ? t.join("; ") : "operational strain";
}
