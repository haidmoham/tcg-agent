-- Private local history. Raw source artifacts remain immutable outside SQLite.
CREATE TABLE IF NOT EXISTS history_meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS games (
  game_id TEXT PRIMARY KEY,
  started_utc TEXT, ended_utc TEXT, end_source TEXT,
  mode TEXT NOT NULL CHECK(mode IN ('ai_test','ranked','casual_other','unknown')),
  mode_conflict INTEGER NOT NULL CHECK(mode_conflict IN (0,1)),
  mode_evidence_json TEXT NOT NULL CHECK(json_valid(mode_evidence_json)),
  account_alias TEXT, perspective TEXT NOT NULL CHECK(perspective IN ('local_player','unknown')),
  deck_composition_sha256 TEXT, mechanics_profile_sha256 TEXT,
  candidate TEXT, checkpoint_sha256 TEXT, feature_schema TEXT, helper_sha256 TEXT,
  status TEXT NOT NULL CHECK(status IN ('declared','running','completed','aborted','driver_failed','unknown')),
  outcome TEXT NOT NULL CHECK(outcome IN ('win','loss','draw','unknown')),
  outcome_source TEXT, terminal_reason_json TEXT CHECK(terminal_reason_json IS NULL OR json_valid(terminal_reason_json)),
  driver_quality TEXT NOT NULL CHECK(driver_quality IN ('clean','interrupted','failed','unknown')),
  clean_outcome INTEGER NOT NULL CHECK(clean_outcome IN (0,1)),
  elapsed_seconds REAL CHECK(elapsed_seconds IS NULL OR elapsed_seconds >= 0),
  turn_count INTEGER CHECK(turn_count IS NULL OR turn_count >= 0),
  ordinary_decisions INTEGER CHECK(ordinary_decisions IS NULL OR ordinary_decisions >= 0),
  selection_decisions INTEGER CHECK(selection_decisions IS NULL OR selection_decisions >= 0),
  helper_decisions INTEGER CHECK(helper_decisions IS NULL OR helper_decisions >= 0),
  driver_rejections INTEGER CHECK(driver_rejections IS NULL OR driver_rejections >= 0),
  interruptions INTEGER NOT NULL CHECK(interruptions >= 0),
  launches INTEGER CHECK(launches IS NULL OR launches >= 0),
  recording_coverage TEXT NOT NULL CHECK(recording_coverage IN ('linked','legacy_partial','unknown')),
  uncertainty_json TEXT NOT NULL CHECK(json_valid(uncertainty_json)),
  evidence_at_ms INTEGER NOT NULL, current_import_id TEXT NOT NULL,
  CHECK(clean_outcome = 0 OR (status = 'completed' AND outcome <> 'unknown' AND driver_quality = 'clean' AND mode_conflict = 0))
);
CREATE TABLE IF NOT EXISTS imports (
  import_id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(game_id),
  imported_utc TEXT NOT NULL, importer_version TEXT NOT NULL,
  evidence_at_ms INTEGER NOT NULL, summary_json TEXT NOT NULL CHECK(json_valid(summary_json))
);
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(game_id),
  relative_name TEXT NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  bytes INTEGER NOT NULL CHECK(bytes >= 0), complete_lines INTEGER,
  UNIQUE(game_id, relative_name, sha256)
);
CREATE TABLE IF NOT EXISTS artifact_locations (
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id), local_path TEXT NOT NULL,
  PRIMARY KEY(artifact_id, local_path)
);
CREATE TABLE IF NOT EXISTS import_artifacts (
  import_id TEXT NOT NULL REFERENCES imports(import_id), artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  PRIMARY KEY(import_id, artifact_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  game_id TEXT NOT NULL REFERENCES games(game_id), session_id TEXT NOT NULL,
  pins_json TEXT NOT NULL CHECK(json_valid(pins_json)),
  PRIMARY KEY(game_id, session_id)
);
CREATE TABLE IF NOT EXISTS decisions (
  game_id TEXT NOT NULL REFERENCES games(game_id), decision_id TEXT NOT NULL, session_id TEXT,
  kind TEXT NOT NULL, actor_kind TEXT NOT NULL, attribution_id TEXT,
  at_utc TEXT, pre_observation_id TEXT,
  selected_json TEXT CHECK(selected_json IS NULL OR json_valid(selected_json)),
  execution_status TEXT NOT NULL, semantic_execution_verified INTEGER NOT NULL CHECK(semantic_execution_verified IN (0,1)),
  training_eligible INTEGER NOT NULL DEFAULT 0 CHECK(training_eligible = 0),
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id), source_line INTEGER NOT NULL,
  record_sha256 TEXT NOT NULL,
  PRIMARY KEY(game_id, decision_id)
);
CREATE TABLE IF NOT EXISTS attributions (
  game_id TEXT NOT NULL REFERENCES games(game_id), attribution_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL, decisions INTEGER NOT NULL CHECK(decisions >= 0),
  source TEXT NOT NULL, PRIMARY KEY(game_id, attribution_id, actor_kind)
);
CREATE INDEX IF NOT EXISTS games_checkpoint_mode_clean ON games(checkpoint_sha256, mode, clean_outcome, outcome);
CREATE INDEX IF NOT EXISTS games_mode_status_time ON games(mode, status, started_utc);
CREATE INDEX IF NOT EXISTS decisions_policy ON decisions(attribution_id, kind, game_id);
CREATE INDEX IF NOT EXISTS artifacts_game_role ON artifacts(game_id, relative_name);
CREATE VIEW IF NOT EXISTS clean_policy_results AS
  SELECT game_id, started_utc, mode, candidate, checkpoint_sha256, outcome
  FROM games WHERE clean_outcome = 1 AND mode <> 'unknown';
