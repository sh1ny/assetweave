-- Decision records are append-only: current pointers may change, but historical
-- authority, transitions, and the snapshot revisions they referenced cannot.
CREATE TRIGGER candidate_reviews_immutable_update BEFORE UPDATE ON candidate_reviews BEGIN SELECT RAISE(ABORT, 'candidate review history is immutable'); END;
CREATE TRIGGER candidate_reviews_immutable_delete BEFORE DELETE ON candidate_reviews BEGIN SELECT RAISE(ABORT, 'candidate review history is immutable'); END;
CREATE TRIGGER slot_selections_immutable_update BEFORE UPDATE ON slot_selections BEGIN SELECT RAISE(ABORT, 'slot selection history is immutable'); END;
CREATE TRIGGER slot_selections_immutable_delete BEFORE DELETE ON slot_selections BEGIN SELECT RAISE(ABORT, 'slot selection history is immutable'); END;
CREATE TRIGGER asset_stage_decisions_immutable_update BEFORE UPDATE ON asset_stage_decisions BEGIN SELECT RAISE(ABORT, 'asset stage history is immutable'); END;
CREATE TRIGGER asset_stage_decisions_immutable_delete BEFORE DELETE ON asset_stage_decisions BEGIN SELECT RAISE(ABORT, 'asset stage history is immutable'); END;
CREATE TRIGGER asset_revisions_immutable_update BEFORE UPDATE ON asset_revisions BEGIN SELECT RAISE(ABORT, 'asset history is immutable'); END;
CREATE TRIGGER asset_revisions_immutable_delete BEFORE DELETE ON asset_revisions BEGIN SELECT RAISE(ABORT, 'asset history is immutable'); END;
CREATE TRIGGER slot_revisions_immutable_update BEFORE UPDATE ON slot_revisions BEGIN SELECT RAISE(ABORT, 'slot history is immutable'); END;
CREATE TRIGGER slot_revisions_immutable_delete BEFORE DELETE ON slot_revisions BEGIN SELECT RAISE(ABORT, 'slot history is immutable'); END;
