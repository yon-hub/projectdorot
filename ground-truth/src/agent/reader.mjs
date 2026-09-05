// The reader agent: one entity in, a set of cited, structured signals out.
// Step 1 - research with server-side web search (Claude Opus 5, adaptive thinking).
// Step 2 - extract signals against the taxonomy with a structured output schema.
// Signals land as 'unreviewed' so a human accepts or dismisses them; they count toward the
// score immediately but are visibly flagged, and the UI shows them for review.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { all, one, run, getEntity } from "../db.mjs";
import { taxonomyList, validateSignal } from "../signals.mjs";
import { rescoreAll } from "../scoring.mjs";

export const MODEL = process.env.IGT_MODEL || "claude-opus-5";
let _client;
function client() {
  if (!_client) _client = new Anthropic();
  return _client;
}
export function hasCredentials() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function findEntityByName(db, type, name) {
  if (!name) return null;
  const table = type === "operator" ? "operators" : "sponsors";
  return one(db, `SELECT * FROM ${table} WHERE name = ? COLLATE NOCASE`, name)
    ?? one(db, `SELECT * FROM ${table} WHERE name LIKE ? COLLATE NOCASE ORDER BY length(name) LIMIT 1`, `%${name}%`);
}

const SignalSchema = z.object({
  dimension: z.string().describe("Exactly one of the dimension keys given in the taxonomy"),
  category: z.string().describe("Exactly one of the category keys given in the taxonomy, belonging to that dimension"),
  title: z.string().describe("One line, specific, names the fact (who / what / when). Max 120 characters."),
  detail: z.string().describe("Two to three sentences: the evidence and why it moves this dimension."),
  strength: z.number().int().min(1).max(5).describe("1 weak hint, 3 clear fact, 5 decisive"),
  confidence: z.enum(["H", "M", "L"]).describe("H: primary source (company site, filing, press release). M: reputable secondary. L: inference or single weak source."),
  source_url: z.string().describe("The URL that supports the signal. Empty string if none."),
  observed_at: z.string().describe("Date the fact occurred or was published, YYYY-MM-DD. Use today if unknown."),
});
const ExtractionSchema = z.object({
  summary: z.string().describe("Four to six sentences a partner could read cold: where this entity sits on the AI adoption front, what pressure it is under, what openness it is showing, and what we still do not know."),
  stage_guess: z.string().describe("For operators: untouched | experimenting | deploying | compounding. For sponsors: passive | forming | active | AI-forward."),
  signals: z.array(SignalSchema),
  portfolio_companies: z.array(z.object({
    name: z.string(), sector: z.string(), hq: z.string().describe("City, ST or empty"), since: z.string().describe("Year acquired or empty"), source_url: z.string(),
  })).describe("Sponsors only: portfolio companies in logistics, construction, industrial, insurance, manufacturing or adjacent. Empty for operators."),
  owner: z.object({ name: z.string(), source_url: z.string() }).describe("Operators only: the PE sponsor that owns this operator, if any. Empty strings if independent or unknown."),
  open_questions: z.array(z.string()).describe("What a human should verify before citing any of this to the account."),
});

function researchPrompt(type, e, contacts) {
  const verticals = "logistics, construction, industrial services, insurance (carriers, brokers, TPAs), manufacturing, distribution, waste/environmental";
  if (type === "operator") {
    return `Research the company below and report where it sits on the AI adoption front. We sell AI deployment services to lower-middle-market operators in ${verticals}. We need ground truth, not marketing.

COMPANY
Name: ${e.name}
Sector / sub-sector: ${e.sector || "?"} / ${e.subsector || "?"}
HQ: ${e.hq || "?"}   Website: ${e.website || "?"}
Revenue (est): ${e.revenue_est || "?"}   Employees: ${e.employees || "?"}
Known leadership: ${contacts.slice(0, 8).map((c) => `${c.name}${c.title ? " (" + c.title + ")" : ""}`).join("; ") || "none on file"}
Our notes: ${e.notes || ""}

FIND (search the web; prefer the company's own site, press releases, job boards, trade press, LinkedIn company pages, filings, local business journals):
1. ADOPTION - any AI, automation, analytics or systems-modernization pilots, deployments, vendors, hires, or leadership statements. Also evidence of a legacy / manual stack.
2. PRESSURE - labor gaps, driver/tech shortages, margin or pricing pressure, competitors deploying AI, compliance load, volume growth, PE-driven standardization, owner succession or sale process.
3. OPENNESS - technology / data / automation job postings, new CEO/COO/CIO or transformation leaders, new facilities or fleet, acquisitions, recap or new sponsor, public statements on efficiency.
4. OWNERSHIP - is it PE-backed? By whom, since when?

Write a factual research memo with a dated, URL-cited bullet for every fact you found. Separate what you found from what you inferred. If you find nothing on a dimension, say so plainly. Do not speculate about internal plans.`;
  }
  return `Research the private-equity firm below and report its AI posture and exit pressure. We sell AI deployment into portfolio companies in ${verticals}; the door is the operating / value-creation partner. We need ground truth, not marketing.

FIRM
Name: ${e.name}   HQ: ${e.city || "?"}, ${e.state || "?"}
Strategy: ${e.fund_strategy || "?"}   AUM (est): ${e.aum_est || "?"}   Latest fund on file: ${e.latest_fund || "?"}
Target verticals: ${e.target_verticals || "?"}
Known contacts: ${contacts.slice(0, 6).map((c) => `${c.name}${c.title ? " (" + c.title + ")" : ""}`).join("; ") || "none on file"}
Our notes: ${[e.hook, e.notes].filter(Boolean).join(" ")}

FIND (search the web; prefer the firm's own site, press releases, fund filings/Form D, PitchBook/Preqin summaries, trade press, LinkedIn):
1. AI POSTURE - value-creation or 100-day-plan language about AI / digital / automation; portfolio companies that announced AI deployments; partners speaking on AI; any portfolio-wide vendor program.
2. OPERATING MANDATE - operating partners and value-creation hires, especially any with an explicit AI / digital / data mandate; a dedicated value-creation team.
3. FUND / EXIT PRESSURE - most recent fund close and size (with date), any stalled or extended fundraise, continuation vehicles or secondaries, assets held 5+ years, failed or pulled sale processes, recent exits.
4. DEAL ACTIVITY - new platforms and add-ons in our verticals in the last 24 months.
5. PORTFOLIO - list current portfolio companies in our verticals with HQ and year acquired where available.

Write a factual research memo with a dated, URL-cited bullet for every fact you found. Separate what you found from what you inferred. If you find nothing on a dimension, say so plainly.`;
}

function extractionPrompt(type, e, memo) {
  const tax = taxonomyList(type).map((t) => `  ${t.dimension}.${t.category}  — ${t.label} (default strength ${t.default_strength}${t.direction < 0 ? ", lowers the dimension" : ""})`).join("\n");
  return `Convert the research memo into structured signals for our market-intelligence engine.

ENTITY: ${type} "${e.name}"

TAXONOMY (dimension.category — use these keys exactly; one signal per distinct fact; skip anything that would not change who we contact, what we say, or when):
${tax}

RULES
- Every signal must rest on something in the memo, with its URL. No signal without evidence.
- Confidence H only for primary sources. Inference from absence (e.g. "no AI mentioned anywhere") is allowed as one L-confidence 'legacy_stack' or 'no_ai_story' signal at most.
- Dates: YYYY-MM-DD. Today is ${new Date().toISOString().slice(0, 10)}.
- Titles are specific: "Posted Director of Automation, Columbus, Aug 2026", not "hiring".
- ${type === "operator" ? "Fill 'owner' if the memo names a PE sponsor; otherwise empty strings." : "Fill 'portfolio_companies' from the memo; leave empty if none found."}

MEMO
${memo}`;
}

export async function readEntity(db, type, id, { log = () => {} } = {}) {
  const e = getEntity(db, type, id);
  if (!e) throw new Error(`${type} ${id} not found`);
  if (!hasCredentials()) throw new Error("ANTHROPIC_API_KEY is not set — the agent reader needs an Anthropic API key (see .env.example)");
  const contacts = all(db, "SELECT name, title FROM contacts WHERE entity_type=? AND entity_id=?", type, id);
  const scanId = run(db, "INSERT INTO scans(entity_type, entity_id, model) VALUES(?,?,?)", type, id, MODEL).lastInsertRowid;
  const usage = { research: null, extraction: null };
  try {
    log(`researching with ${MODEL} + web search…`);
    // Step 1: research with web search. Beta path so the refusal fallback can rescue a declined turn.
    const research = await client().beta.messages.stream({
      model: MODEL,
      max_tokens: 24000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: "You are a market-intelligence researcher for Intrinsic Labs, an AI deployment firm serving lower-middle-market industrial businesses in the US Heartland. You are precise, you cite every fact with a URL and date, and you say 'not found' rather than guess. Prefer primary sources. Search efficiently: a handful of well-chosen queries beats many broad ones.",
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 10 }],
      messages: [{ role: "user", content: researchPrompt(type, e, contacts) }],
    }).finalMessage();
    usage.research = research.usage;
    if (research.stop_reason === "refusal") throw new Error(`research step refused (${research.stop_details?.category ?? "unspecified"})`);
    const memo = research.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!memo) throw new Error("research step returned no text");
    log(`memo: ${memo.length} chars, ${research.content.filter((b) => b.type === "server_tool_use").length} searches`);

    // Step 2: structured extraction.
    log("extracting signals…");
    const extraction = await client().messages.parse({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: zodOutputFormat(ExtractionSchema) },
      messages: [{ role: "user", content: extractionPrompt(type, e, memo) }],
    });
    usage.extraction = extraction.usage;
    const out = extraction.parsed_output;
    if (!out) throw new Error("extraction returned no parsable output");

    // Persist.
    let inserted = 0;
    const ins = db.prepare(`INSERT INTO signals(entity_type,entity_id,dimension,category,direction,strength,confidence,title,detail,source_type,source_url,observed_at,review_status,created_by,scan_id)
      VALUES(?,?,?,?,?,?,?,?,?,'agent',?,?,'unreviewed',?,?)`);
    const rejected = [];
    for (const s of out.signals) {
      try {
        const v = validateSignal(type, { ...s, observed_at: /^\d{4}-\d{2}-\d{2}$/.test(s.observed_at) ? s.observed_at : new Date().toISOString().slice(0, 10) });
        // de-dupe against an identical open signal from a previous scan
        if (one(db, "SELECT 1 FROM signals WHERE entity_type=? AND entity_id=? AND category=? AND title=? AND review_status<>'dismissed'", type, id, v.category, v.title)) continue;
        ins.run(type, id, v.dimension, v.category, v.direction, v.strength, v.confidence, v.title.slice(0, 160), v.detail || null, v.source_url || null, v.observed_at, MODEL, scanId);
        inserted++;
      } catch (err) { rejected.push({ signal: s, reason: err.message }); }
    }
    // The join: ownership discovered by the reader.
    const links = [];
    if (type === "operator" && out.owner?.name) {
      const sp = ensureSponsorStub(db, out.owner.name);
      run(db, "INSERT OR IGNORE INTO ownership(sponsor_id,operator_id,confidence,source,source_url) VALUES(?,?,?,?,?)", sp.id, id, "M", `agent read ${new Date().toISOString().slice(0, 10)}`, out.owner.source_url || null);
      run(db, "UPDATE operators SET pe_backed=1 WHERE id=?", id);
      links.push(out.owner.name);
    }
    if (type === "sponsor") {
      for (const pc of out.portfolio_companies || []) {
        if (!pc.name) continue;
        const op = ensureOperatorStub(db, pc);
        run(db, "INSERT OR IGNORE INTO ownership(sponsor_id,operator_id,since,confidence,source,source_url) VALUES(?,?,?,?,?,?)", id, op.id, pc.since || null, "M", `agent read ${new Date().toISOString().slice(0, 10)}`, pc.source_url || null);
        links.push(pc.name);
      }
    }
    run(db, "UPDATE scans SET finished_at=datetime('now'), status='done', summary=?, signals_found=?, usage=?, raw=? WHERE id=?",
      out.summary, inserted, JSON.stringify(usage), JSON.stringify({ memo, extraction: out, rejected, links }), scanId);
    rescoreAll(db);
    log(`stored ${inserted} signals${links.length ? `, linked ${links.length}: ${links.join(", ")}` : ""}${rejected.length ? `, rejected ${rejected.length}` : ""}`);
    return { scan_id: scanId, status: "done", summary: out.summary, stage_guess: out.stage_guess, signals_found: inserted, links, rejected, open_questions: out.open_questions, usage };
  } catch (err) {
    const msg = describeError(err);
    run(db, "UPDATE scans SET finished_at=datetime('now'), status='error', error=?, usage=? WHERE id=?", msg, JSON.stringify(usage), scanId);
    return { scan_id: scanId, status: "error", error: msg, signals_found: 0 };
  }
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic authentication failed — check ANTHROPIC_API_KEY";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API — retry in a minute";
  if (err instanceof Anthropic.BadRequestError) return `Bad request to the Anthropic API: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  return err.message || String(err);
}

function ensureSponsorStub(db, name) {
  let sp = one(db, "SELECT id FROM sponsors WHERE name = ? COLLATE NOCASE", name);
  if (sp) return sp;
  run(db, "INSERT INTO sponsors(name, region, aum_band, fundraising_signal, vertical_fit, ops_model, engagement_status, momentum_band, data_confidence, source, notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    name, "National", "Verify", "Verify", "Strong", "Some Ops", "Not started", "Not started / Researching", "L", "agent", "Created by the reader as the owner of a pipeline operator. Verify and fill in fund data.");
  return one(db, "SELECT id FROM sponsors WHERE name = ?", name);
}
function ensureOperatorStub(db, pc) {
  let op = one(db, "SELECT id FROM operators WHERE name = ? COLLATE NOCASE", pc.name);
  if (op) return op;
  run(db, "INSERT INTO operators(name, sector, hq, region, tier, pipeline_status, pe_backed, source, notes) VALUES(?,?,?,?,?,?,1,'agent',?)",
    pc.name, pc.sector || null, pc.hq || null, "Portfolio", "T3", "Not Started", "Discovered by the reader as a portfolio company. Not yet a pipeline account.");
  return one(db, "SELECT id FROM operators WHERE name = ?", pc.name);
}
