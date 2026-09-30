-- Persistent per-profile cursor signature: continuation survives a service restart.
CREATE TABLE query_cursor_secrets (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  secret BLOB NOT NULL CHECK (length(secret) = 32)
) STRICT;
INSERT INTO query_cursor_secrets(id, secret) VALUES (1, randomblob(32));

-- All text comes from recorded records. A revision is never replaced; only its
-- effective flag changes. This migration backfills old private stores atomically.
CREATE TABLE search_documents (
  id INTEGER PRIMARY KEY,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'asset', 'slot', 'request', 'artifact')),
  scope_id TEXT NOT NULL,
  body TEXT NOT NULL,
  current INTEGER NOT NULL CHECK (current IN (0, 1)),
  UNIQUE(record_type, revision_id)
) STRICT;
CREATE INDEX search_scope ON search_documents(scope, scope_id, current);
CREATE INDEX search_record ON search_documents(record_type, record_id, current);
CREATE VIRTUAL TABLE search_fts USING fts5(body, content='search_documents', content_rowid='id', tokenize='unicode61');
CREATE TRIGGER search_index_insert AFTER INSERT ON search_documents BEGIN
  INSERT INTO search_fts(rowid, body) VALUES (new.id, new.body);
END;

-- Filtering audit_event_id through this UNION selects only records written in
-- that mutation. json_tree walks all nested textual producer metadata leaves.
CREATE VIEW search_sources AS
SELECT 'project' AS record_type, p.id AS record_id, p.id || ':' || r.revision AS revision_id,
  r.revision, 'project' AS scope, p.id AS scope_id, r.name || ' ' || r.notes AS body,
  (p.revision = r.revision) AS current, r.audit_event_id
  FROM project_revisions r JOIN projects p ON p.id = r.project_id
UNION ALL
SELECT 'asset', a.id, a.id || ':' || r.revision, r.revision, 'asset', a.id,
  r.name || ' ' || r.notes || ' ' || COALESCE(r.stage, ''), (a.revision = r.revision), r.audit_event_id
  FROM asset_revisions r JOIN assets a ON a.id = r.asset_id
UNION ALL
SELECT 'slot', s.id, s.id || ':' || r.revision, r.revision, 'slot', s.id,
  r.name || ' ' || r.notes, (s.revision = r.revision), r.audit_event_id
  FROM slot_revisions r JOIN slots s ON s.id = r.slot_id
UNION ALL
SELECT 'artifact', a.id, a.id, 1, 'artifact', a.id,
  a.name || ' ' || a.notes || ' ' || COALESCE((SELECT group_concat(source_name, ' ') FROM content_members WHERE artifact_id = a.id), ''),
  1, e.id FROM artifacts a JOIN audit_events e ON e.target_id = a.id AND e.target_type IN ('capture', 'artifact')
UNION ALL
SELECT 'request', r.id, r.id, 1, 'request', r.id,
  r.intent || ' ' || r.notes || ' ' || COALESCE((SELECT group_concat(role, ' ') FROM proposed_inputs WHERE request_id = r.id), ''),
  1, e.id FROM requests r JOIN audit_events e ON e.target_id = r.id AND e.target_type = 'request'
UNION ALL
SELECT 'outcome', o.request_id, o.id, o.revision, 'request', o.request_id,
  o.status || ' ' || o.notes, (r.outcome_revision = o.revision), o.audit_event_id
  FROM request_outcomes o JOIN requests r ON r.id = o.request_id
UNION ALL
SELECT 'claim', p.id, r.id, r.revision, 'artifact', p.artifact_id,
  p.field || ' ' || r.source_kind || ' ' || COALESCE(r.source_detail, '') || ' ' ||
  COALESCE((SELECT group_concat(COALESCE(j.fullkey, '') || ' ' || CAST(j.atom AS TEXT), ' ')
    FROM json_tree(r.value_json) j WHERE j.atom IS NOT NULL AND j.type IN ('text', 'integer', 'real')), ''),
  (p.current_revision_id = r.id), r.audit_event_id
  FROM provenance_revisions r JOIN provenance_assertions p ON p.id = r.assertion_id
UNION ALL
SELECT 'clip', c.id, r.id, r.revision, 'artifact', c.artifact_id,
  c.name || ' ' || r.source_kind || ' ' || COALESCE(r.source_detail, ''),
  (c.current_revision_id = r.id), r.audit_event_id
  FROM playback_revisions r JOIN clips c ON c.id = r.clip_id
UNION ALL
SELECT 'input', e.id, r.id, r.revision, 'artifact', e.output_artifact_id,
  COALESCE(r.role, ''), (e.current_revision_id = r.id AND r.is_effective = 1), r.audit_event_id
  FROM input_edge_revisions r JOIN input_edges e ON e.id = r.edge_id
UNION ALL
SELECT 'gap', g.id, r.id, r.revision, 'artifact', g.output_artifact_id,
  r.description || ' ' || r.source_kind,
  (g.current_revision_id = r.id AND r.is_effective = 1), r.audit_event_id
  FROM lineage_gap_revisions r JOIN lineage_gaps g ON g.id = r.gap_id
UNION ALL
SELECT 'review', r.candidate_id, r.id, r.revision, 'artifact', r.artifact_id,
  r.next_state || ' ' || h.instruction || ' ' || COALESCE(e.rationale, ''),
  (c.revision = r.revision), r.audit_event_id
  FROM candidate_reviews r JOIN candidates c ON c.id = r.candidate_id
  JOIN audit_events e ON e.id = r.audit_event_id JOIN authorities h ON h.id = r.authority_id
UNION ALL
SELECT 'selection', r.slot_id, r.id, r.revision, 'slot', r.slot_id,
  h.instruction || ' ' || COALESCE(e.rationale, ''),
  (r.revision = (SELECT MAX(revision) FROM slot_selections WHERE slot_id = r.slot_id)), r.audit_event_id
  FROM slot_selections r JOIN audit_events e ON e.id = r.audit_event_id JOIN authorities h ON h.id = r.authority_id
UNION ALL
SELECT 'stage-decision', r.asset_id, r.id, r.revision, 'asset', r.asset_id,
  COALESCE(r.next_stage, '') || ' ' || h.instruction || ' ' || COALESCE(e.rationale, ''),
  (r.revision = (SELECT MAX(revision) FROM asset_stage_decisions WHERE asset_id = r.asset_id)), r.audit_event_id
  FROM asset_stage_decisions r JOIN audit_events e ON e.id = r.audit_event_id JOIN authorities h ON h.id = r.authority_id;

CREATE INDEX search_outcome_event ON request_outcomes(audit_event_id);
CREATE INDEX search_claim_event ON provenance_revisions(audit_event_id);
CREATE INDEX search_clip_event ON playback_revisions(audit_event_id);
CREATE INDEX search_input_event ON input_edge_revisions(audit_event_id);
CREATE INDEX search_gap_event ON lineage_gap_revisions(audit_event_id);
CREATE INDEX search_review_event ON candidate_reviews(audit_event_id);
CREATE INDEX search_selection_event ON slot_selections(audit_event_id);
CREATE INDEX search_stage_event ON asset_stage_decisions(audit_event_id);
INSERT INTO search_documents(record_type, record_id, revision_id, revision, scope, scope_id, body, current)
  SELECT record_type, record_id, revision_id, revision, scope, scope_id, body, current FROM search_sources;
