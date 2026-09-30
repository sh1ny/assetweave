-- Project revision snapshots are retained history, like asset and slot revisions.
CREATE TRIGGER project_revisions_immutable_update BEFORE UPDATE ON project_revisions BEGIN SELECT RAISE(ABORT, 'project history is immutable'); END;
CREATE TRIGGER project_revisions_immutable_delete BEFORE DELETE ON project_revisions BEGIN SELECT RAISE(ABORT, 'project history is immutable'); END;
