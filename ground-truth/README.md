# Intrinsic Ground Truth (IGT) — v1

A working first version of the market-intelligence engine described in the Ground Truth vision:
a living map of AI adoption across lower-middle-market operators and the PE sponsors that own
them, scored continuously, and converted into named next actions for named accounts.

It is deliberately the smallest real version. It runs on your laptop, holds its own data, imports
the two pipeline sheets you already maintain, scores every account with an explainable model, and
puts an AI reader agent to work on one account at a time. Nothing in it sends email or feeds
sequenced outbound. It recommends the play; it never runs the play.

## What is in the box

| Piece | What it does |
|---|---|
| **Operator map** | Every operator from the Client Targets sheet (383), scored on an **AI Penetration Index** (0–100): Adoption 0–40, Pressure 0–30, Openness 0–30. Stage = unread → untouched → experimenting → deploying → compounding. |
| **Sponsor map** | Every firm from the PE Pipeline sheet (109), scored on the **Exit-Unlock Fit** model from the sheet (reproduced exactly at default weights, verified by test) plus an **AI Posture** read (0–100) built from signals. Play tags follow the sheet's rule. |
| **The join** | Ownership links between sponsors and operators. Surfaces the intersections: stuck fund + laggard portco, AI-forward sponsor + laggard portfolio, etc. |
| **Signals** | The atomic unit. A fixed taxonomy (23 operator categories, 17 sponsor categories), each tied to a score dimension. Every signal has strength, confidence (H/M/L), a date, a source URL and a review status. |
| **Scoring** | Deterministic: `direction × strength × confidence multiplier × decay`, summed per dimension, capped. All weights editable in the UI with live re-scoring. Score history is kept so deltas are real. |
| **Actions** | Derived from the maps every time anything changes. Each one names the account, the play, the message angle, the trusted path, the timing, the reasoning and the evidence. Done / dismissed states persist across regeneration. |
| **This week** | "What moved?" — movers, new signals, the front by subsector, the action queue, signals awaiting review. |
| **Reader agent** | Claude (Opus 5, web search) reads one operator or sponsor, writes a cited memo, then extracts structured signals against the taxonomy. Signals land as *unreviewed*; you accept or dismiss. For sponsors it discovers portfolio companies and creates the join; for operators it names the owner. |
| **Brief** | One-click Monday brief: deterministic data plus a short Claude-written narrative. |

## Run it

Requirements: Node 22.13+ (uses the built-in `node:sqlite`; no native builds). An Anthropic API key
is only needed for the reader agent and the brief narrative — everything else works without one.

```bash
cd ground-truth
npm install
npm run setup          # creates data/igt.db, imports both sheets, derives first signals, scores, generates actions
npm start              # http://localhost:4310
```

To turn the agent on:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

or copy `.env.example` to `.env` and `export $(cat .env | xargs)` before starting.

## Day-to-day

**In the UI**

- *This week* is the home page. Work the action queue top-down; mark actions Done or Dismiss.
- Click any row to open the account: score breakdown, signals with their point contributions, actions, contacts, ownership links, edit form.
- *Run a read* on an account (needs the API key). It takes one to three minutes. Findings land in Signals as *unreviewed* with source links; accept what holds up, dismiss what does not. Scores update either way.
- *+ Add signal* when you hear something on a call or read something. Manual signals count immediately.
- *Model* tab: change a weight, save, everything re-scores.

**From the terminal**

```bash
npm run week                                   # what moved, top actions
npm run scan -- "Dayton Freight Lines"         # read one operator
node src/cli.mjs scan --type=sponsor "Huron Capital"
node src/cli.mjs scan --tier=T1 --limit=5      # batch-read the top unread T1 operators
node src/cli.mjs signal --type=operator --name="Kokosing Construction" \
  --dimension=openness --category=tech_job_posting \
  --title="Posted Director of Field Technology, Sep 2026" --url=https://... --confidence=H
node src/cli.mjs brief                         # weekly brief with narrative
npm run import                                 # re-import after refreshing the CSVs in data/source/
npm run rescore
```

## Refreshing from the sheets

Export each Google Sheet's first tab as CSV and overwrite:

- `data/source/client_targets_pipeline_aug2026.csv` — Intrinsic · Client Targets Pipeline (first tab)
- `data/source/pe_pipeline_aug2026.csv` — Intrinsic · PE Pipeline (first tab; must include the hidden band columns `aum, sig, vert, ops, reg, mom, momband`)

Then `npm run import`. Entities upsert by name. Import-derived signals are replaced; manual and agent
signals, ownership links, actions and score history are kept.

## How the scores work

**Operators.** Signals in three dimensions. Each signal contributes
`direction × strength(1–5) × confidence(H 1.0 / M 0.75 / L 0.5) × decay(≤90d 1.0, ≤180d 0.75, ≤365d 0.5, older 0.25)`.
Adoption points × 4 (cap 40), Pressure × 3 (cap 30), Openness × 3 (cap 30). Stage comes from the adoption
score alone: <8 untouched, 8–19 experimenting, 20–31 deploying, ≥32 compounding. An operator with no
signals is **unread**, not untouched — the difference matters and the UI keeps it visible.
*Moment* = pressure + openness: the pre-buyer window.

**Sponsors.** Exit-Unlock Fit = AUM fit (22) + fundraising/zombie signal (22) + vertical fit (18) +
operational engagement (13) + region (13) + engagement momentum (12), exactly as in the sheet.
Grades A ≥74, B ≥60, C ≥46. Play: Exit-Unlock when last close ≥4 years ago and AUM <$5B; Growth Client
when raised in the last ~2 years; otherwise Both. AI Posture is a separate 0–100 read from posture,
mandate and activity signals; exit pressure from vintage signals.

**Import-derived signals.** On setup the engine reads the sheets' own research notes and contact
titles and files low-confidence signals from them (e.g. "Chief Digital Officer seat exists" → openness;
"legacy systems" → pressure; "AI language in thesis" → sponsor posture). They are tagged *from sheet*,
never count as movement, and are replaced on re-import. They give the map a first read; the agent and
you give it ground truth.

## Layout

```
ground-truth/
  src/
    cli.mjs          commands: setup, serve, import, rescore, week, scan, signal, brief
    server.mjs       HTTP server + JSON API (no framework)
    db.mjs           node:sqlite wrapper; schema.sql holds the tables
    importer.mjs     CSV → operators, sponsors, contacts; import-derived signals; seeded ownership
    signals.mjs      taxonomy + validation
    scoring.mjs      both models, weights, score history
    actions.mjs      action derivation and upsert
    week.mjs         "what moved"
    agent/reader.mjs Claude reader (web search → memo → structured signals)
    agent/brief.mjs  narrative brief
  public/            index.html, app.js, styles.css — the UI
  data/source/       the two CSV exports (inputs)
  data/igt.db        the database (created by setup; git-ignored)
  test/              node:test suite (`npm test`)
```

## API (for wiring into anything else)

`GET /api/week?days=7` · `GET /api/operators` · `GET /api/operators/:id` · `PATCH /api/operators/:id` · `POST /api/operators`
(same for `/api/sponsors`) · `GET|POST /api/signals` · `PATCH|DELETE /api/signals/:id` · `GET|POST /api/ownership` ·
`DELETE /api/ownership/:id` · `GET /api/actions?status=open` · `PATCH /api/actions/:id` · `POST /api/actions/regenerate` ·
`GET|PATCH /api/weights` · `GET /api/taxonomy` · `POST /api/scan` · `GET /api/scans[/:id]` · `POST /api/brief` · `GET /api/briefs` · `GET /api/status`

## What v1 does not do yet

- Scheduled, unattended reads across the whole map (the reader runs one entity at a time, on request or via the CLI in a loop).
- Two-way sync with the Google Sheets or Attio — import is one-way from CSV.
- Outcome feedback (did the play land?) feeding back into the weights. The score history and action states are stored so this can be added.
- Multi-user auth. It is a local tool.
