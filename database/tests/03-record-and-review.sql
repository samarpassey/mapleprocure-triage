-- record-classification.sql, record-review.sql, review-queue.sql, metrics-counts.sql.
\ir _harness.sql

SELECT pg_temp.run(pg_temp.q('claim'), pg_temp.batch(ref, closing), 'exec-a', 'wf-1')
FROM (VALUES ('match', '2026-10-01T14:00:00'), ('unsure', '2026-11-01T14:00:00'),
             ('contra', '2026-10-15T14:00:00'), ('failed', NULL),
             ('dismissed', '2026-09-20T14:00:00')) AS v(ref, closing);

SELECT pg_temp.expect(
    pg_temp.run(pg_temp.q('record'), 'match', 'exec-a', pg_temp.classification('AUTO_MATCH')) = 1,
    'the claim holder records a routed classification');
SELECT pg_temp.expect(
    (SELECT status = 'AUTO_MATCH' AND routed_status = 'AUTO_MATCH'
            AND source_last_modified = '2026-09-13 10:20:16+00' AND source_row_count = 901
            AND model_confidence = 0.910 AND classified_at IS NOT NULL
     FROM triage_results WHERE tender_reference = 'match'),
    'status, routing and provenance land, the HTTP date parsed to a timestamp');
SELECT pg_temp.expect(
    pg_temp.run(pg_temp.q('record'), 'match', 'exec-a',
                pg_temp.classification('NOT_RELEVANT', '{"relevance": "not_relevant"}')) = 0,
    'a second result for an already-classified row is refused');

SELECT pg_temp.run(pg_temp.q('record'), 'unsure', 'exec-a',
                   pg_temp.classification('NEEDS_REVIEW', '{"relevance": "uncertain"}'));
SELECT pg_temp.run(pg_temp.q('record'), 'contra', 'exec-a',
                   pg_temp.classification('NEEDS_REVIEW_CONTRADICTION', '{"relevance": "not_relevant"}'));
SELECT pg_temp.run(pg_temp.q('record'), 'dismissed', 'exec-a',
                   pg_temp.classification('NOT_RELEVANT', '{"relevance": "not_relevant"}'));
SELECT pg_temp.expect(
    pg_temp.run(pg_temp.q('record'), 'failed', 'exec-a', pg_temp.classification(
        'CLASSIFICATION_FAILED', '{"routing_rule": null, "category": null, "relevance": null,
          "rationale": null, "criteria": null, "model_confidence": null,
          "validation_errors": ["relevance: expected one of match, uncertain, not_relevant"],
          "model_output_raw": "{\"relevance\": \"maybe\"}"}')) = 1,
    'a failed classification is recorded with its errors and the raw output');

-- Review queue.
CREATE TEMP TABLE queue AS SELECT tender_reference FROM triage_results WHERE false;
DO $$
DECLARE r record;
BEGIN
    FOR r IN EXECUTE pg_temp.q('review_queue') USING '10' LOOP
        INSERT INTO queue VALUES (r.tender_reference);
    END LOOP;
END $$;
SELECT pg_temp.expect(
    (SELECT array_agg(tender_reference) FROM queue) = ARRAY['contra', 'unsure', 'failed'],
    'the queue holds uncertain, contradictory and failed rows, soonest-closing first, undated last');

-- Review.
SELECT pg_temp.expect(
    pg_temp.run(pg_temp.q('record_review'), 'contra', 'HUMAN_APPROVED', 'reviewer', 'Real fit.') = 1,
    'a person approves a contradiction');
SELECT pg_temp.expect(
    (SELECT status = 'HUMAN_APPROVED' AND routed_status = 'NEEDS_REVIEW_CONTRADICTION'
            AND reviewed_by = 'reviewer' AND reviewed_at IS NOT NULL
     FROM triage_results WHERE tender_reference = 'contra'),
    'the decision is the status, and routed_status still says how the row reached review');
SELECT pg_temp.expect(
    pg_temp.run(pg_temp.q('record_review'), 'contra', 'HUMAN_REJECTED', 'someone else', NULL) = 0,
    'the first decision stands');
SELECT pg_temp.expect(
    pg_temp.run(pg_temp.q('record_review'), 'failed', 'HUMAN_REJECTED', 'reviewer', NULL) = 1,
    'a failed classification can be decided by a person');
SELECT pg_temp.expect(
    pg_temp.run(pg_temp.q('record_review'), 'match', 'HUMAN_REJECTED', 'reviewer', NULL) = 0,
    'an automatic decision cannot be reviewed through the queue statement');
SELECT pg_temp.expect(
    pg_temp.run(pg_temp.q('record_review'), 'unsure', 'AUTO_MATCH', 'reviewer', NULL) = 0,
    'a decision other than approve or reject updates nothing');

-- Metrics counts.
CREATE TEMP TABLE counts (routed_status text, status text, n integer);
DO $$
DECLARE r record;
BEGIN
    FOR r IN EXECUTE pg_temp.q('metrics')
             USING (now() - interval '1 day')::text, (now() + interval '1 day')::text LOOP
        INSERT INTO counts VALUES (r.routed_status, r.status, r.n);
    END LOOP;
END $$;
SELECT pg_temp.expect(
    (SELECT array_agg(routed_status || '/' || status || '=' || n ORDER BY routed_status, status)
     FROM counts) = ARRAY['AUTO_MATCH/AUTO_MATCH=1', 'CLASSIFICATION_FAILED/HUMAN_REJECTED=1',
                          'NEEDS_REVIEW/NEEDS_REVIEW=1', 'NEEDS_REVIEW_CONTRADICTION/HUMAN_APPROVED=1',
                          'NOT_RELEVANT/NOT_RELEVANT=1'],
    'counts group by how a row was routed and where it is now');
SELECT pg_temp.expect(
    pg_temp.run(pg_temp.q('metrics'), (now() + interval '1 day')::text,
                (now() + interval '2 days')::text) = 0,
    'rows outside the window are not counted');
