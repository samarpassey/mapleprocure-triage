-- Shared by every test file (\ir _harness.sql). Loads the committed statements from
-- database/queries/ into session settings, so tests run the file text itself, never a copy.
-- `make db-test` copies database/ to /tmp/database in the Postgres container first.

\set ON_ERROR_STOP 1
\set VERBOSITY terse
\o /dev/null

\set claim `cat /tmp/database/queries/claim.sql`
\set recover `cat /tmp/database/queries/recover.sql`
\set record `cat /tmp/database/queries/record-classification.sql`
\set review_queue `cat /tmp/database/queries/review-queue.sql`
\set record_review `cat /tmp/database/queries/record-review.sql`
\set metrics `cat /tmp/database/queries/metrics-counts.sql`

SELECT set_config('q.claim', :'claim', false),
       set_config('q.recover', :'recover', false),
       set_config('q.record', :'record', false),
       set_config('q.review_queue', :'review_queue', false),
       set_config('q.record_review', :'record_review', false),
       set_config('q.metrics', :'metrics', false);

CREATE EXTENSION IF NOT EXISTS dblink;

CREATE FUNCTION pg_temp.q(name text) RETURNS text LANGUAGE sql AS
$$ SELECT current_setting('q.' || name) $$;

CREATE FUNCTION pg_temp.expect(ok boolean, name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS NOT TRUE THEN
        RAISE EXCEPTION 'FAIL - %', name;
    END IF;
    RAISE NOTICE 'ok - %', name;
END
$$;

-- Runs a committed statement with real bound parameters. Returns the number of rows it returned.
CREATE FUNCTION pg_temp.run(query text, VARIADIC args text[]) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
    n integer;
BEGIN
    CASE cardinality(args)
        WHEN 1 THEN EXECUTE query USING args[1];
        WHEN 2 THEN EXECUTE query USING args[1], args[2];
        WHEN 3 THEN EXECUTE query USING args[1], args[2], args[3];
        WHEN 4 THEN EXECUTE query USING args[1], args[2], args[3], args[4];
    END CASE;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END
$$;

-- The same statement as a literal counting query, for a second connection, which cannot bind.
CREATE FUNCTION pg_temp.counted(query text, VARIADIC args text[]) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    i integer;
BEGIN
    FOR i IN REVERSE cardinality(args)..1 LOOP
        query := replace(query, '$' || i, quote_nullable(args[i]));
    END LOOP;
    RETURN 'WITH r AS (' || regexp_replace(query, ';\s*$', '') || E'\n) SELECT count(*) FROM r';
END
$$;

-- Starts `query` on a second connection and returns once it is waiting on a lock held here.
-- Proves the second statement really contended, rather than simply running after the first.
CREATE FUNCTION pg_temp.start_blocked(query text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    other_pid integer;
BEGIN
    PERFORM dblink_connect('other',
                           format('dbname=%s user=%s', current_database(), current_user));
    SELECT pid INTO other_pid FROM dblink('other', 'SELECT pg_backend_pid()') AS t(pid integer);
    PERFORM dblink_send_query('other', query);
    FOR i IN 1..200 LOOP
        PERFORM pg_stat_clear_snapshot();
        IF EXISTS (SELECT 1 FROM pg_stat_activity
                   WHERE pid = other_pid AND wait_event_type = 'Lock') THEN
            RETURN;
        END IF;
        PERFORM pg_sleep(0.05);
    END LOOP;
    RAISE EXCEPTION 'FAIL - second connection never blocked';
END
$$;

-- Rows the second connection's statement returned. Call after this session commits.
CREATE FUNCTION pg_temp.blocked_result() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
    n bigint;
BEGIN
    SELECT t.n INTO n FROM dblink_get_result('other') AS t(n bigint);
    PERFORM dblink_disconnect('other');
    RETURN n;
END
$$;

-- Asserts `stmt` is rejected, by the named constraint. Postgres reports only the first violated
-- constraint, in name order, so where one change necessarily breaks two rules both are named.
CREATE FUNCTION pg_temp.rejects(stmt text, VARIADIC expected text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    got text;
BEGIN
    BEGIN
        EXECUTE stmt;
    EXCEPTION WHEN integrity_constraint_violation THEN
        GET STACKED DIAGNOSTICS got = CONSTRAINT_NAME;
        PERFORM pg_temp.expect(got = ANY (expected),
                               format('rejected by %s (got %s)', array_to_string(expected, ' or '), got));
        RETURN;
    END;
    RAISE EXCEPTION 'FAIL - accepted, expected rejection by %', array_to_string(expected, ' or ');
END
$$;

-- A classification as record-classification.sql expects it, with provenance filled in.
CREATE FUNCTION pg_temp.classification(routed text, overrides jsonb DEFAULT '{}') RETURNS text
LANGUAGE sql AS $$
    SELECT (jsonb_build_object(
        'routed_status', routed, 'routing_rule', 'rule-under-test',
        'category', 'enterprise_software', 'relevance', 'match', 'rationale', 'Test rationale.',
        'criteria', '{"software_related": true, "scope_clear": true,
                      "target_market_match": true}'::jsonb,
        'model_confidence', 0.91, 'model_name', 'model-under-test',
        'prompt_version', 'prompt-v0', 'rules_version', 'rules-v0', 'notice_text', 'Title: Test notice',
        'source_file', 'https://canadabuys.canada.ca/opendata/pub/openTenderNotice.csv',
        'source_as_of', '2026-09-14T00:19:57+00:00',
        'source_last_modified', 'Sun, 13 Sep 2026 10:20:16 GMT',
        'source_row_count', 901, 'source_notes', '["A snapshot, not a live feed."]'::jsonb
    ) || overrides)::text
$$;

-- A one-notice claim batch.
CREATE FUNCTION pg_temp.batch(ref text, closing text DEFAULT '2026-10-20T14:00:00') RETURNS text
LANGUAGE sql AS $$
    SELECT jsonb_build_array(jsonb_build_object(
        'tender_reference', ref, 'title', 'Title of ' || ref, 'buyer_name', 'A department',
        'closing_date', closing, 'notice_url', 'https://canadabuys.canada.ca/' || ref,
        'matched_concepts', jsonb_build_array('software')))::text
$$;
