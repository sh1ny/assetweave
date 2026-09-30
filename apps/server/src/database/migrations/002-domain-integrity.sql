-- One capture event can establish multiple independent facts and input edges.
-- Rebuild only revision tables whose audit_event_id was mistakenly unique in 001.
-- Keep all old rows and validate every existing and new FK on transaction commit.
PRAGMA defer_foreign_keys = ON;

-- Composite clip selection FKs require an exact unique parent, even if no clip
-- selection exists in the original database yet.
CREATE UNIQUE INDEX candidate_identity_clip ON candidates(id, clip_id);

CREATE TABLE provenance_revisions_next (
  id TEXT PRIMARY KEY NOT NULL,
  assertion_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('known', 'unknown', 'absent')),
  value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
  source_kind TEXT NOT NULL CHECK (length(trim(source_kind)) > 0),
  source_detail TEXT,
  audit_event_id INTEGER NOT NULL REFERENCES audit_events(id),
  UNIQUE(assertion_id, revision),
  UNIQUE(assertion_id, artifact_id, id),
  CHECK ((state = 'known' AND value_json IS NOT NULL) OR (state != 'known' AND value_json IS NULL)),
  FOREIGN KEY(assertion_id, artifact_id) REFERENCES provenance_assertions(id, artifact_id)
) STRICT;
-- Insert under the restored parent name: copying into *_next before DROP leaves
-- deferred child-FK violations outstanding even when the final rows match.
CREATE TABLE _m002_provenance_preserved AS SELECT * FROM provenance_revisions;
DROP TABLE provenance_revisions;
ALTER TABLE provenance_revisions_next RENAME TO provenance_revisions;
INSERT INTO provenance_revisions SELECT * FROM _m002_provenance_preserved;
DROP TABLE _m002_provenance_preserved;

CREATE TABLE input_edge_revisions_next (
  id TEXT PRIMARY KEY NOT NULL,
  edge_id TEXT NOT NULL,
  output_artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  input_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  clip_id TEXT,
  playback_revision_id TEXT,
  role TEXT,
  is_effective INTEGER NOT NULL CHECK (is_effective IN (0, 1)),
  audit_event_id INTEGER NOT NULL REFERENCES audit_events(id),
  UNIQUE(edge_id, revision),
  UNIQUE(edge_id, output_artifact_id, id),
  CHECK (input_artifact_id <> output_artifact_id),
  CHECK ((clip_id IS NULL AND playback_revision_id IS NULL) OR
         (clip_id IS NOT NULL AND playback_revision_id IS NOT NULL)),
  FOREIGN KEY(edge_id, output_artifact_id) REFERENCES input_edges(id, output_artifact_id),
  FOREIGN KEY(playback_revision_id, clip_id, input_artifact_id)
    REFERENCES playback_revisions(id, clip_id, artifact_id)
) STRICT;
CREATE TABLE _m002_inputs_preserved AS SELECT * FROM input_edge_revisions;
DROP TABLE input_edge_revisions;
ALTER TABLE input_edge_revisions_next RENAME TO input_edge_revisions;
INSERT INTO input_edge_revisions SELECT * FROM _m002_inputs_preserved;
DROP TABLE _m002_inputs_preserved;
CREATE INDEX input_edge_sources ON input_edge_revisions(input_artifact_id);

CREATE TABLE lineage_gap_revisions_next (
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
  audit_event_id INTEGER NOT NULL REFERENCES audit_events(id),
  UNIQUE(gap_id, revision),
  UNIQUE(gap_id, output_artifact_id, id),
  CHECK ((gap_kind = 'upstream' AND clip_id IS NULL) OR
         (gap_kind = 'playback' AND input_artifact_id IS NOT NULL AND clip_id IS NOT NULL)),
  FOREIGN KEY(gap_id, output_artifact_id) REFERENCES lineage_gaps(id, output_artifact_id),
  FOREIGN KEY(clip_id, input_artifact_id) REFERENCES clips(id, artifact_id)
) STRICT;
CREATE TABLE _m002_gaps_preserved AS SELECT * FROM lineage_gap_revisions;
DROP TABLE lineage_gap_revisions;
ALTER TABLE lineage_gap_revisions_next RENAME TO lineage_gap_revisions;
INSERT INTO lineage_gap_revisions SELECT * FROM _m002_gaps_preserved;
DROP TABLE _m002_gaps_preserved;

-- A single captured sheet may introduce several independently named clips.
CREATE TABLE playback_revisions_next (
  id TEXT PRIMARY KEY NOT NULL,
  clip_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  geometry_json TEXT NOT NULL CHECK (json_valid(geometry_json)),
  frames_json TEXT NOT NULL CHECK (json_valid(frames_json)),
  timing_json TEXT NOT NULL CHECK (json_valid(timing_json)),
  source_kind TEXT NOT NULL,
  source_detail TEXT,
  audit_event_id INTEGER NOT NULL REFERENCES audit_events(id),
  UNIQUE(clip_id, revision),
  UNIQUE(clip_id, artifact_id, id),
  UNIQUE(id, clip_id, artifact_id),
  UNIQUE(id, clip_id),
  FOREIGN KEY(clip_id, artifact_id) REFERENCES clips(id, artifact_id)
) STRICT;
CREATE TABLE _m002_playback_preserved AS SELECT * FROM playback_revisions;
DROP TABLE playback_revisions;
ALTER TABLE playback_revisions_next RENAME TO playback_revisions;
INSERT INTO playback_revisions SELECT * FROM _m002_playback_preserved;
DROP TABLE _m002_playback_preserved;

-- Corrections append revisions; requests and historical reports cannot be revised in place.
CREATE TRIGGER requests_intent_immutable_delete BEFORE DELETE ON requests BEGIN SELECT RAISE(ABORT, 'request intent is immutable'); END;
CREATE TRIGGER provenance_revisions_immutable_update BEFORE UPDATE ON provenance_revisions BEGIN SELECT RAISE(ABORT, 'claim history is immutable'); END;
CREATE TRIGGER provenance_revisions_immutable_delete BEFORE DELETE ON provenance_revisions BEGIN SELECT RAISE(ABORT, 'claim history is immutable'); END;
CREATE TRIGGER input_edge_revisions_immutable_update BEFORE UPDATE ON input_edge_revisions BEGIN SELECT RAISE(ABORT, 'input history is immutable'); END;
CREATE TRIGGER input_edge_revisions_immutable_delete BEFORE DELETE ON input_edge_revisions BEGIN SELECT RAISE(ABORT, 'input history is immutable'); END;
CREATE TRIGGER lineage_gap_revisions_immutable_update BEFORE UPDATE ON lineage_gap_revisions BEGIN SELECT RAISE(ABORT, 'gap history is immutable'); END;
CREATE TRIGGER lineage_gap_revisions_immutable_delete BEFORE DELETE ON lineage_gap_revisions BEGIN SELECT RAISE(ABORT, 'gap history is immutable'); END;
CREATE TRIGGER request_outcomes_immutable_update BEFORE UPDATE ON request_outcomes BEGIN SELECT RAISE(ABORT, 'outcome history is immutable'); END;
CREATE TRIGGER request_outcomes_immutable_delete BEFORE DELETE ON request_outcomes BEGIN SELECT RAISE(ABORT, 'outcome history is immutable'); END;
CREATE TRIGGER playback_revisions_immutable_update BEFORE UPDATE ON playback_revisions BEGIN SELECT RAISE(ABORT, 'playback history is immutable'); END;
CREATE TRIGGER playback_revisions_immutable_delete BEFORE DELETE ON playback_revisions BEGIN SELECT RAISE(ABORT, 'playback history is immutable'); END;
