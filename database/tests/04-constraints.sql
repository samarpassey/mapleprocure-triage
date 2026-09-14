-- Constraints reject incoherent rows, each by the constraint that names the rule broken.
-- Each statement below breaks exactly one rule.
\ir _harness.sql

SELECT pg_temp.run(pg_temp.q('claim'), pg_temp.batch(ref), 'exec-a', 'wf-1')
FROM unnest(ARRAY['pending', 'matched', 'dismissed', 'unsure']) AS ref;
SELECT pg_temp.run(pg_temp.q('record'), 'matched', 'exec-a', pg_temp.classification('AUTO_MATCH'));
SELECT pg_temp.run(pg_temp.q('record'), 'dismissed', 'exec-a',
                   pg_temp.classification('NOT_RELEVANT', '{"relevance": "not_relevant"}'));
SELECT pg_temp.run(pg_temp.q('record'), 'unsure', 'exec-a',
                   pg_temp.classification('NEEDS_REVIEW', '{"relevance": "uncertain"}'));

SELECT pg_temp.rejects($$INSERT INTO triage_results (tender_reference, title, matched_concepts,
    execution_id) VALUES ('pending', 'Again', '{}', 'exec-b')$$,
    'triage_results_reference_key');

-- An unknown status cannot satisfy routed_once_classified either, which sorts first.
SELECT pg_temp.rejects($$UPDATE triage_results SET status = 'MAYBE'
    WHERE tender_reference = 'pending'$$, 'status_known', 'routed_once_classified');

SELECT pg_temp.rejects($$UPDATE triage_results SET relevance = 'probably'
    WHERE tender_reference = 'matched'$$, 'relevance_known');

SELECT pg_temp.rejects($$UPDATE triage_results SET model_confidence = 1.2
    WHERE tender_reference = 'matched'$$, 'confidence_in_range');

SELECT pg_temp.rejects($$UPDATE triage_results SET status = 'NEEDS_REVIEW'
    WHERE tender_reference = 'pending'$$, 'routed_once_classified');

SELECT pg_temp.rejects($$UPDATE triage_results SET status = 'NOT_RELEVANT'
    WHERE tender_reference = 'matched'$$, 'status_follows_routing');

SELECT pg_temp.rejects($$UPDATE triage_results SET status = 'HUMAN_REJECTED',
    reviewed_by = 'reviewer', reviewed_at = now()
    WHERE tender_reference = 'matched'$$, 'status_follows_routing');

SELECT pg_temp.rejects($$UPDATE triage_results SET status = 'HUMAN_APPROVED'
    WHERE tender_reference = 'unsure'$$, 'reviewed_exactly_when_decided');

SELECT pg_temp.rejects($$UPDATE triage_results SET reviewed_by = 'reviewer', reviewed_at = now()
    WHERE tender_reference = 'unsure'$$, 'reviewed_exactly_when_decided');

SELECT pg_temp.rejects($$UPDATE triage_results SET source_as_of = NULL
    WHERE tender_reference = 'matched'$$, 'routed_rows_have_provenance');

SELECT pg_temp.rejects($$UPDATE triage_results SET input_sha256 = NULL
    WHERE tender_reference = 'dismissed'$$, 'routed_rows_have_provenance');

SELECT pg_temp.rejects($$UPDATE triage_results SET rationale = NULL
    WHERE tender_reference = 'unsure'$$, 'routed_rows_have_classification');

SELECT pg_temp.rejects($$UPDATE triage_results SET routing_rule = NULL
    WHERE tender_reference = 'matched'$$, 'routed_rows_have_classification');

SELECT pg_temp.rejects($$UPDATE triage_results SET validation_errors = '["x"]'
    WHERE tender_reference = 'matched'$$, 'errors_exactly_when_failed');

SELECT pg_temp.rejects($$UPDATE triage_results SET validation_errors = '["x"]'
    WHERE tender_reference = 'pending'$$, 'errors_exactly_when_failed');

SELECT pg_temp.rejects($$UPDATE triage_results SET notification_sent_at = now()
    WHERE tender_reference = 'dismissed'$$, 'notified_only_when_relevant');

SELECT pg_temp.rejects($$UPDATE triage_results SET attempts = 0
    WHERE tender_reference = 'pending'$$, 'attempts_positive');

SELECT pg_temp.rejects(format('SELECT pg_temp.run(%L, %L, %L, %L)', pg_temp.q('record'),
    'pending', 'exec-a', pg_temp.classification('AUTO_MATCH', '{"source_file": null}')),
    'routed_rows_have_provenance');

SELECT pg_temp.expect(
    (SELECT notification_sent_at IS NULL AND updated_at >= created_at
     FROM triage_results WHERE tender_reference = 'matched'),
    'rejected updates left the row as it was');

UPDATE triage_results SET notification_sent_at = now() WHERE tender_reference = 'matched';
SELECT pg_temp.expect(
    (SELECT notification_sent_at IS NOT NULL AND updated_at > created_at
     FROM triage_results WHERE tender_reference = 'matched'),
    'an auto-match can be marked notified, and updated_at moves on every update');
