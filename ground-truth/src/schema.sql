PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS operators (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sector TEXT,
  subsector TEXT,
  hq TEXT,
  region TEXT,
  state TEXT,
  revenue_est TEXT,
  employees TEXT,
  website TEXT,
  tier TEXT,
  fit_score INTEGER,
  pipeline_status TEXT,
  status_date TEXT,
  warm_intro_via TEXT,
  context TEXT,
  notes TEXT,
  pe_backed INTEGER DEFAULT 0,
  source TEXT DEFAULT 'import',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sponsors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  city TEXT,
  state TEXT,
  region TEXT,
  tier TEXT,
  fund_strategy TEXT,
  aum_est TEXT,
  aum_band TEXT,
  latest_fund TEXT,
  fundraising_signal TEXT,
  target_verticals TEXT,
  vertical_fit TEXT,
  entry_seat TEXT,
  ops_model TEXT,
  engagement_status TEXT,
  momentum_band TEXT,
  hook TEXT,
  notes TEXT,
  data_confidence TEXT,
  target_poc TEXT,
  poc_email TEXT,
  intro_path TEXT,
  sheet_rank INTEGER,
  sheet_fit INTEGER,
  sheet_play TEXT,
  source TEXT DEFAULT 'import',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('operator','sponsor')),
  entity_id INTEGER NOT NULL,
  name TEXT,
  title TEXT,
  email TEXT,
  linkedin TEXT,
  status TEXT,
  status_date TEXT,
  context TEXT,
  UNIQUE (entity_type, entity_id, name, title)
);
CREATE INDEX IF NOT EXISTS contacts_entity ON contacts (entity_type, entity_id);

-- Ownership: the join between the two maps.
CREATE TABLE IF NOT EXISTS ownership (
  id INTEGER PRIMARY KEY,
  sponsor_id INTEGER NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  relationship TEXT DEFAULT 'portfolio',
  since TEXT,
  confidence TEXT DEFAULT 'L',
  source TEXT,
  source_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (sponsor_id, operator_id)
);

-- Signals: the atomic unit the engine collects. Every score is a function of signals.
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('operator','sponsor')),
  entity_id INTEGER NOT NULL,
  dimension TEXT NOT NULL,      -- operator: adoption | pressure | openness ; sponsor: posture | mandate | vintage | activity
  category TEXT NOT NULL,       -- taxonomy key, see signals.mjs
  direction INTEGER NOT NULL DEFAULT 1,  -- +1 raises the dimension, -1 lowers it
  strength INTEGER NOT NULL DEFAULT 2 CHECK (strength BETWEEN 1 AND 5),
  confidence TEXT NOT NULL DEFAULT 'M' CHECK (confidence IN ('H','M','L')),
  title TEXT NOT NULL,
  detail TEXT,
  source_type TEXT NOT NULL DEFAULT 'manual', -- manual | import | agent
  source_url TEXT,
  observed_at TEXT NOT NULL DEFAULT (date('now')),
  review_status TEXT NOT NULL DEFAULT 'accepted', -- accepted | unreviewed | dismissed
  created_by TEXT,
  scan_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS signals_entity ON signals (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS signals_observed ON signals (observed_at);

-- Score history: one row per (entity, computation). Deltas come from here.
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  total REAL NOT NULL,
  stage TEXT,
  play TEXT,
  grade TEXT,
  confidence TEXT,
  components TEXT NOT NULL   -- JSON
);
CREATE INDEX IF NOT EXISTS scores_entity ON scores (entity_type, entity_id, computed_at);

-- Actions: every insight terminates here, as a named next action for a named account.
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,     -- stable key so regeneration upserts instead of duplicating
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  kind TEXT NOT NULL,           -- see actions.mjs
  priority INTEGER NOT NULL DEFAULT 50,
  play TEXT,
  headline TEXT NOT NULL,
  message_angle TEXT,
  trusted_path TEXT,
  timing TEXT,
  reasoning TEXT,
  evidence TEXT,                -- JSON array of signal ids
  confidence TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | done | dismissed
  owner TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS actions_status ON actions (status, priority);

-- Scans: each agent read of an entity.
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running', -- running | done | error
  model TEXT,
  summary TEXT,
  signals_found INTEGER DEFAULT 0,
  error TEXT,
  usage TEXT,                 -- JSON
  raw TEXT                    -- JSON (research notes + extraction)
);

-- Adjustable weights for the scoring models.
CREATE TABLE IF NOT EXISTS weights (
  model TEXT NOT NULL,
  key TEXT NOT NULL,
  value REAL NOT NULL,
  label TEXT,
  PRIMARY KEY (model, key)
);

-- Weekly briefs (what moved).
CREATE TABLE IF NOT EXISTS briefs (
  id INTEGER PRIMARY KEY,
  week_of TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  body TEXT NOT NULL,       -- JSON
  narrative TEXT
);
