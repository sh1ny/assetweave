-- Stable domain identities and effective current records with immutable revisions.
-- Foreign keys (including deferred current-revision pointers) are enabled on the connection.
CREATE TABLE mutation_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  watermark INTEGER NOT NULL DEFAULT 0 CHECK (watermark >= 0)
) STRICT;
INSERT INTO mutation_clock (id, watermark) VALUES (1, 0);

CREATE TABLE authorities (
  id TEXT PRIMARY KEY NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('browser', 'reported')),
  instruction TEXT NOT NULL CHECK (length(trim(instruction)) > 0),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
) STRICT;

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id > 0),
  actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  recorded_at TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  authority_id TEXT REFERENCES authorities(id),
  rationale TEXT
) STRICT;
CREATE INDEX audit_target ON audit_events(target_type, target_id, id DESC);

CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  notes TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX projects_name ON projects(name);
CREATE TABLE project_revisions (
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  name TEXT NOT NULL,
  notes TEXT NOT NULL,
  audit_event_id INTEGER NOT NULL UNIQUE REFERENCES audit_events(id),
  PRIMARY KEY(project_id, revision)
) STRICT;

CREATE TABLE assets (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  notes TEXT NOT NULL DEFAULT '',
  stage TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id, project_id)
) STRICT;
CREATE INDEX assets_project_name ON assets(project_id, name, id);
CREATE INDEX assets_stage ON assets(stage, id);
CREATE TABLE asset_revisions (
  asset_id TEXT NOT NULL REFERENCES assets(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  name TEXT NOT NULL,
  notes TEXT NOT NULL,
  stage TEXT,
  audit_event_id INTEGER NOT NULL UNIQUE REFERENCES audit_events(id),
  PRIMARY KEY(asset_id, revision)
) STRICT;

-- A slot may point only to a candidate in that very slot. Its FK is deferred
-- because candidate rows refer back to their containing slot.
CREATE TABLE slots (
  id TEXT PRIMARY KEY NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  normalized_name TEXT NOT NULL CHECK (length(normalized_name) > 0),
  notes TEXT NOT NULL DEFAULT '',
  selected_candidate_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(asset_id, normalized_name),
  UNIQUE(id, asset_id),
  FOREIGN KEY(selected_candidate_id, id) REFERENCES candidates(id, slot_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE slot_revisions (
  slot_id TEXT NOT NULL REFERENCES slots(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  notes TEXT NOT NULL,
  selected_candidate_id TEXT,
  audit_event_id INTEGER NOT NULL UNIQUE REFERENCES audit_events(id),
  PRIMARY KEY(slot_id, revision),
  FOREIGN KEY(selected_candidate_id, slot_id) REFERENCES candidates(id, slot_id)
) STRICT;

CREATE TABLE requests (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  slot_id TEXT,
  intent TEXT NOT NULL CHECK (length(trim(intent)) > 0),
  notes TEXT NOT NULL DEFAULT '',
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  outcome_revision INTEGER NOT NULL DEFAULT 0 CHECK (outcome_revision >= 0),
  UNIQUE(id, asset_id, project_id),
  FOREIGN KEY(asset_id, project_id) REFERENCES assets(id, project_id),
  FOREIGN KEY(slot_id, asset_id) REFERENCES slots(id, asset_id)
) STRICT;
CREATE INDEX requests_asset_date ON requests(asset_id, recorded_at DESC);
CREATE INDEX requests_slot ON requests(slot_id);
CREATE TABLE request_outcomes (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL REFERENCES requests(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'cancelled')),
  notes TEXT NOT NULL DEFAULT '',
  audit_event_id INTEGER NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(request_id, revision)
) STRICT;

-- No request or slot is required for capture. The operation receipt records
-- an independently recoverable committed operation without deduplicating bytes.
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  request_id TEXT,
  operation_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  content_directory TEXT NOT NULL UNIQUE,
  captured_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  UNIQUE(id, asset_id, project_id),
  UNIQUE(operation_id, id),
  FOREIGN KEY(asset_id, project_id) REFERENCES assets(id, project_id),
  FOREIGN KEY(request_id, asset_id, project_id) REFERENCES requests(id, asset_id, project_id)
) STRICT;
CREATE INDEX artifacts_asset_capture ON artifacts(asset_id, captured_at DESC, id);
CREATE INDEX artifacts_request ON artifacts(request_id);
CREATE INDEX artifacts_kind ON artifacts(kind, captured_at DESC);
CREATE TABLE content_members (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  stored_name TEXT NOT NULL CHECK (length(stored_name) > 0),
  source_name TEXT NOT NULL,
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  media_type TEXT,
  PRIMARY KEY(artifact_id, ordinal),
  UNIQUE(artifact_id, stored_name)
) STRICT;
CREATE TABLE capture_receipts (
  operation_id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL,
  FOREIGN KEY(operation_id, artifact_id) REFERENCES artifacts(operation_id, id)
) STRICT;

-- Proposals and actual inputs refer to exact artifacts, and when known to an
-- exact clip description. Omitting an exact playback revision does not silently
-- refer to the latest revision: use an artifact input plus a playback gap.
CREATE TABLE clips (
  id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  normalized_name TEXT NOT NULL CHECK (length(normalized_name) > 0),
  current_revision_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  UNIQUE(id, artifact_id),
  UNIQUE(artifact_id, normalized_name),
  FOREIGN KEY(id, artifact_id, current_revision_id)
    REFERENCES playback_revisions(clip_id, artifact_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE playback_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  clip_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  geometry_json TEXT NOT NULL CHECK (json_valid(geometry_json)),
  frames_json TEXT NOT NULL CHECK (json_valid(frames_json)),
  timing_json TEXT NOT NULL CHECK (json_valid(timing_json)),
  source_kind TEXT NOT NULL,
  source_detail TEXT,
  audit_event_id INTEGER NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(clip_id, revision),
  UNIQUE(clip_id, artifact_id, id),
  UNIQUE(id, clip_id, artifact_id),
  UNIQUE(id, clip_id),
  FOREIGN KEY(clip_id, artifact_id) REFERENCES clips(id, artifact_id)
) STRICT;

CREATE TABLE proposed_inputs (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL REFERENCES requests(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  clip_id TEXT,
  playback_revision_id TEXT,
  role TEXT,
  UNIQUE(request_id, ordinal),
  CHECK ((clip_id IS NULL AND playback_revision_id IS NULL) OR
         (clip_id IS NOT NULL AND playback_revision_id IS NOT NULL)),
  FOREIGN KEY(playback_revision_id, clip_id, artifact_id)
    REFERENCES playback_revisions(id, clip_id, artifact_id)
) STRICT;
CREATE INDEX proposed_inputs_artifact ON proposed_inputs(artifact_id);

CREATE TABLE provenance_assertions (
  id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  field TEXT NOT NULL CHECK (length(trim(field)) > 0),
  current_revision_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  UNIQUE(id, artifact_id),
  UNIQUE(artifact_id, field),
  FOREIGN KEY(id, artifact_id, current_revision_id)
    REFERENCES provenance_revisions(assertion_id, artifact_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE provenance_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  assertion_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('known', 'unknown', 'absent')),
  value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
  source_kind TEXT NOT NULL CHECK (length(trim(source_kind)) > 0),
  source_detail TEXT,
  audit_event_id INTEGER NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(assertion_id, revision),
  UNIQUE(assertion_id, artifact_id, id),
  CHECK ((state = 'known' AND value_json IS NOT NULL) OR (state != 'known' AND value_json IS NULL)),
  FOREIGN KEY(assertion_id, artifact_id) REFERENCES provenance_assertions(id, artifact_id)
) STRICT;
CREATE INDEX provenance_field ON provenance_assertions(field, artifact_id);

CREATE TABLE input_edges (
  id TEXT PRIMARY KEY NOT NULL,
  output_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  current_revision_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  UNIQUE(id, output_artifact_id),
  FOREIGN KEY(id, output_artifact_id, current_revision_id)
    REFERENCES input_edge_revisions(edge_id, output_artifact_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE input_edge_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  edge_id TEXT NOT NULL,
  output_artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  input_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  clip_id TEXT,
  playback_revision_id TEXT,
  role TEXT,
  is_effective INTEGER NOT NULL CHECK (is_effective IN (0, 1)),
  audit_event_id INTEGER NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(edge_id, revision),
  UNIQUE(edge_id, output_artifact_id, id),
  CHECK (input_artifact_id <> output_artifact_id),
  CHECK ((clip_id IS NULL AND playback_revision_id IS NULL) OR
         (clip_id IS NOT NULL AND playback_revision_id IS NOT NULL)),
  FOREIGN KEY(edge_id, output_artifact_id) REFERENCES input_edges(id, output_artifact_id),
  FOREIGN KEY(playback_revision_id, clip_id, input_artifact_id)
    REFERENCES playback_revisions(id, clip_id, artifact_id)
) STRICT;
CREATE INDEX input_edges_output ON input_edges(output_artifact_id);
CREATE INDEX input_edge_sources ON input_edge_revisions(input_artifact_id);

CREATE TABLE lineage_gaps (
  id TEXT PRIMARY KEY NOT NULL,
  output_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  current_revision_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  UNIQUE(id, output_artifact_id),
  FOREIGN KEY(id, output_artifact_id, current_revision_id)
    REFERENCES lineage_gap_revisions(gap_id, output_artifact_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE lineage_gap_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  gap_id TEXT NOT NULL,
  output_artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  gap_kind TEXT NOT NULL CHECK (gap_kind IN ('upstream', 'playback')),
  input_artifact_id TEXT REFERENCES artifacts(id),
  clip_id TEXT,
  description TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  is_effective INTEGER NOT NULL CHECK (is_effective IN (0, 1)),
  audit_event_id INTEGER NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(gap_id, revision),
  UNIQUE(gap_id, output_artifact_id, id),
  CHECK ((gap_kind = 'upstream' AND clip_id IS NULL) OR
         (gap_kind = 'playback' AND input_artifact_id IS NOT NULL AND clip_id IS NOT NULL)),
  FOREIGN KEY(gap_id, output_artifact_id) REFERENCES lineage_gaps(id, output_artifact_id),
  FOREIGN KEY(clip_id, input_artifact_id) REFERENCES clips(id, artifact_id)
) STRICT;

CREATE TABLE candidates (
  id TEXT PRIMARY KEY NOT NULL,
  slot_id TEXT NOT NULL REFERENCES slots(id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  clip_id TEXT,
  review_state TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (review_state IN ('unreviewed', 'reviewed-undecided', 'approved', 'rejected')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  placed_at TEXT NOT NULL,
  UNIQUE(id, slot_id),
  UNIQUE(id, artifact_id),
  UNIQUE(id, clip_id, artifact_id),
  FOREIGN KEY(clip_id, artifact_id) REFERENCES clips(id, artifact_id)
) STRICT;
CREATE UNIQUE INDEX candidate_artifact_once ON candidates(slot_id, artifact_id) WHERE clip_id IS NULL;
CREATE UNIQUE INDEX candidate_clip_once ON candidates(slot_id, clip_id) WHERE clip_id IS NOT NULL;
CREATE INDEX candidates_artifact ON candidates(artifact_id, slot_id);
CREATE INDEX candidates_review ON candidates(review_state, slot_id);
CREATE TABLE candidate_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  candidate_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  clip_id TEXT,
  playback_revision_id TEXT,
  revision INTEGER NOT NULL CHECK (revision > 1),
  previous_state TEXT NOT NULL,
  next_state TEXT NOT NULL,
  authority_id TEXT NOT NULL REFERENCES authorities(id),
  audit_event_id INTEGER NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(candidate_id, revision),
  CHECK ((clip_id IS NULL AND playback_revision_id IS NULL) OR
         (clip_id IS NOT NULL AND playback_revision_id IS NOT NULL)),
  FOREIGN KEY(candidate_id, artifact_id) REFERENCES candidates(id, artifact_id),
  FOREIGN KEY(candidate_id, clip_id, artifact_id) REFERENCES candidates(id, clip_id, artifact_id),
  FOREIGN KEY(playback_revision_id, clip_id, artifact_id)
    REFERENCES playback_revisions(id, clip_id, artifact_id)
) STRICT;
CREATE TABLE slot_selections (
  id TEXT PRIMARY KEY NOT NULL,
  slot_id TEXT NOT NULL REFERENCES slots(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  previous_candidate_id TEXT,
  previous_clip_id TEXT,
  previous_playback_revision_id TEXT,
  next_candidate_id TEXT,
  next_clip_id TEXT,
  next_playback_revision_id TEXT,
  authority_id TEXT NOT NULL REFERENCES authorities(id),
  audit_event_id INTEGER NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(slot_id, revision),
  CHECK ((previous_clip_id IS NULL AND previous_playback_revision_id IS NULL) OR
         (previous_candidate_id IS NOT NULL AND previous_clip_id IS NOT NULL AND previous_playback_revision_id IS NOT NULL)),
  CHECK ((next_clip_id IS NULL AND next_playback_revision_id IS NULL) OR
         (next_candidate_id IS NOT NULL AND next_clip_id IS NOT NULL AND next_playback_revision_id IS NOT NULL)),
  FOREIGN KEY(previous_candidate_id, slot_id) REFERENCES candidates(id, slot_id),
  FOREIGN KEY(next_candidate_id, slot_id) REFERENCES candidates(id, slot_id),
  FOREIGN KEY(previous_candidate_id, previous_clip_id) REFERENCES candidates(id, clip_id),
  FOREIGN KEY(next_candidate_id, next_clip_id) REFERENCES candidates(id, clip_id),
  FOREIGN KEY(previous_playback_revision_id, previous_clip_id)
    REFERENCES playback_revisions(id, clip_id),
  FOREIGN KEY(next_playback_revision_id, next_clip_id)
    REFERENCES playback_revisions(id, clip_id)
) STRICT;
CREATE TABLE asset_stage_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  previous_stage TEXT,
  next_stage TEXT,
  authority_id TEXT NOT NULL REFERENCES authorities(id),
  audit_event_id INTEGER NOT NULL UNIQUE REFERENCES audit_events(id),
  UNIQUE(asset_id, revision)
) STRICT;

-- Immutable bytes and production snapshots cannot be edited or deleted in
-- place; corrections use the separate current+revision records above.
CREATE TRIGGER artifacts_immutable_update BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT, 'artifact identity is immutable'); END;
CREATE TRIGGER artifacts_immutable_delete BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT, 'artifact identity is immutable'); END;
CREATE TRIGGER members_immutable_update BEFORE UPDATE ON content_members BEGIN SELECT RAISE(ABORT, 'captured bytes are immutable'); END;
CREATE TRIGGER members_immutable_delete BEFORE DELETE ON content_members BEGIN SELECT RAISE(ABORT, 'captured bytes are immutable'); END;
CREATE TRIGGER requests_intent_immutable BEFORE UPDATE OF id, project_id, asset_id, slot_id, intent, notes, recorded_by, recorded_at ON requests BEGIN SELECT RAISE(ABORT, 'request intent is immutable'); END;
CREATE TRIGGER proposed_inputs_immutable_update BEFORE UPDATE ON proposed_inputs BEGIN SELECT RAISE(ABORT, 'proposed inputs are immutable'); END;
CREATE TRIGGER proposed_inputs_immutable_delete BEFORE DELETE ON proposed_inputs BEGIN SELECT RAISE(ABORT, 'proposed inputs are immutable'); END;
CREATE TRIGGER audit_immutable_update BEFORE UPDATE ON audit_events WHEN OLD.before_json <> 'null' OR OLD.after_json <> 'null' BEGIN SELECT RAISE(ABORT, 'audit history is immutable'); END;
CREATE TRIGGER audit_immutable_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit history is immutable'); END;
CREATE TRIGGER authorities_immutable_update BEFORE UPDATE ON authorities BEGIN SELECT RAISE(ABORT, 'authority is immutable'); END;
CREATE TRIGGER authorities_immutable_delete BEFORE DELETE ON authorities BEGIN SELECT RAISE(ABORT, 'authority is immutable'); END;
