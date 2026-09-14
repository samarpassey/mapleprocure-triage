-- Each of the three queries the workflow runs can use its index as written.
--
-- Sequential scans are disabled so the planner takes an index whenever the query allows one.
-- What fails here is a query whose WHERE clause has drifted from its partial index's predicate,
-- which Postgres would otherwise answer, correctly and silently, by scanning the whole table.
\ir _harness.sql

INSERT INTO triage_results (tender_reference, title, matched_concepts, execution_id, claimed_at)
SELECT 'bulk-' || g, 'Bulk ' || g, ARRAY['software'], 'exec-bulk',
       now() - (g % 180) * interval '1 minute'
FROM generate_series(1, 2000) AS g;
ANALYZE triage_results;
SET enable_seqscan = off;

CREATE FUNCTION pg_temp.plan(query text, VARIADIC args text[]) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    result text;
BEGIN
    CASE cardinality(args)
        WHEN 1 THEN EXECUTE 'EXPLAIN (FORMAT JSON) ' || query INTO result USING args[1];
        WHEN 2 THEN EXECUTE 'EXPLAIN (FORMAT JSON) ' || query INTO result USING args[1], args[2];
    END CASE;
    RETURN result;
END
$$;

SELECT pg_temp.expect(
    pg_temp.plan(pg_temp.q('recover'), 'exec-x') LIKE '%triage_results_pending_idx%',
    'recover.sql uses triage_results_pending_idx');

SELECT pg_temp.expect(
    pg_temp.plan(pg_temp.q('review_queue'), '50') LIKE '%triage_results_review_queue_idx%',
    'review-queue.sql uses triage_results_review_queue_idx');

SELECT pg_temp.expect(
    pg_temp.plan(pg_temp.q('metrics'), (now() - interval '7 days')::text, now()::text)
        LIKE '%triage_results_metrics_idx%',
    'metrics-counts.sql uses triage_results_metrics_idx');

SELECT pg_temp.expect(
    pg_temp.plan(pg_temp.q('review_queue'), '50') NOT LIKE '%"Sort"%',
    'the review queue is read in index order, without a sort');
