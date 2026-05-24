export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  timestamp     INTEGER NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('session','commit')),
  source        TEXT NOT NULL CHECK (source IN ('claude_code','git')),
  project_hash  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  session_id    TEXT,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  cache_creation_tokens INTEGER,
  cache_read_tokens     INTEGER,
  cost_usd      REAL,
  pricing_version TEXT,
  pricing_fallback INTEGER,
  model_id      TEXT,
  session_end_ms INTEGER,
  commit_hash       TEXT,
  lines_added       INTEGER,
  lines_removed     INTEGER,
  files_changed     INTEGER,
  primary_language  TEXT,
  branch            TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_project_ts ON events(project_hash, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_session ON events(session_id) WHERE type='session';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_commit ON events(commit_hash) WHERE type='commit';

CREATE TABLE IF NOT EXISTS attributions (
  session_id   TEXT NOT NULL,
  commit_hash  TEXT NOT NULL,
  tier         TEXT NOT NULL CHECK (tier IN ('direct','high','inferred')),
  confidence   REAL NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, commit_hash)
);

CREATE INDEX IF NOT EXISTS idx_attr_commit ON attributions(commit_hash);

CREATE TABLE IF NOT EXISTS commit_survival (
  commit_hash      TEXT NOT NULL,
  project_hash     TEXT NOT NULL,
  evaluated_at     INTEGER NOT NULL,
  lines_added      INTEGER NOT NULL,
  lines_surviving  INTEGER NOT NULL,
  files_touched    INTEGER NOT NULL,
  files_revisited  INTEGER NOT NULL,
  window_days      INTEGER NOT NULL,
  PRIMARY KEY (commit_hash, window_days)
);

CREATE INDEX IF NOT EXISTS idx_survival_proj ON commit_survival(project_hash, evaluated_at);

CREATE TABLE IF NOT EXISTS session_tags (
  session_id  TEXT PRIMARY KEY,
  tag         TEXT NOT NULL CHECK (tag IN ('shipped','exploring','debugging','dead-end')),
  tagged_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_hits (
  id          TEXT PRIMARY KEY,
  timestamp   INTEGER NOT NULL,
  session_id  TEXT,
  window      TEXT,
  raw_message TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rl_ts ON rate_limit_hits(timestamp);

CREATE TABLE IF NOT EXISTS calibration (
  version    TEXT PRIMARY KEY,
  mu         REAL NOT NULL,
  sigma      REAL NOT NULL,
  n_prior    INTEGER NOT NULL,
  anchor     TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  active     INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_calibration
  ON calibration(active) WHERE active = 1;

CREATE TABLE IF NOT EXISTS projects (
  project_hash TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  path         TEXT NOT NULL,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_last_seen ON projects(last_seen);

CREATE TABLE IF NOT EXISTS snapshots (
  date                       TEXT NOT NULL,
  project_hash               TEXT NOT NULL,
  total_tokens_in            INTEGER NOT NULL DEFAULT 0,
  total_tokens_out           INTEGER NOT NULL DEFAULT 0,
  total_cost_usd             REAL NOT NULL DEFAULT 0,
  session_count              INTEGER NOT NULL DEFAULT 0,
  commit_count               INTEGER NOT NULL DEFAULT 0,
  attributed_commit_count    INTEGER NOT NULL DEFAULT 0,
  direct_attribution_count   INTEGER NOT NULL DEFAULT 0,
  inferred_attribution_count INTEGER NOT NULL DEFAULT 0,
  ypt_score                  REAL,
  cost_per_ship_tokens       REAL,
  cost_per_ship_usd          REAL,
  provenance                 TEXT,
  computed_at                INTEGER NOT NULL,
  PRIMARY KEY (date, project_hash)
);
`;
