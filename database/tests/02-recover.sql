-- recover.sql: stale claims are reclaimed once, and abandoned after the third attempt.
\ir _harness.sql

SELECT pg_temp.run(pg_temp.q('claim'), pg_temp.batch(ref), 'exec-dead', 'wf-1')
FROM unnest(ARRAY['fresh', 'stale', 'third', 'done']) AS ref;

UPDATE triage_results SET claimed_at = now() - interval '61 minutes'
WHERE tender_reference IN ('stale', 'third', 'done');
UPDATE triage_results SET attempts = 3 WHERE tender_reference = 'third';
SELECT pg_temp.expect(
    pg_temp.run(pg_temp.q('record'), 'done', 'exec-dead', pg_temp.classification('AUTO_MATCH')) = 1,
    'setup: one old claim was classified before its execution died');

SELECT pg_temp.expect(pg_temp.run(pg_temp.q('recover'), 'exec-new') = 2,
    'recovery returns the stale PENDING row and the one it abandons, nothing else');

SELECT pg_temp.expect(
    (SELECT status = 'PENDING' AND attempts = 2 AND execution_id = 'exec-new'
            AND claimed_at > now() - interval '1 minute'
     FROM triage_results WHERE tender_reference = 'stale'),
    'a stale claim moves to the recovering execution, with its attempt counted');

SELECT pg_temp.expect(
    (SELECT status = 'PROCESSING_FAILED' AND attempts = 3
     FROM triage_results WHERE tender_reference = 'third'),
    'a row stale on its third attempt is abandoned as PROCESSING_FAILED, not reclaimed');

SELECT pg_temp.expect(
    (SELECT status = 'PENDING' AND execution_id = 'exec-dead'
     FROM triage_results WHERE tender_reference = 'fresh'),
    'a claim younger than an hour is left alone');

SELECT pg_temp.expect(
    (SELECT status = 'AUTO_MATCH' FROM triage_results WHERE tender_reference = 'done'),
    'an old row that was classified is never recovered');

SELECT pg_temp.expect(pg_temp.run(pg_temp.q('recover'), 'exec-next') = 0,
    'running recovery again straight away reclaims nothing');

-- The execution that "died" was only slow: its late result must not land.
SELECT pg_temp.expect(
    pg_temp.run(pg_temp.q('record'), 'stale', 'exec-dead', pg_temp.classification('AUTO_MATCH')) = 0,
    'the fenced-out execution cannot record a result on a reclaimed row');
SELECT pg_temp.expect(
    pg_temp.run(pg_temp.q('record'), 'stale', 'exec-new', pg_temp.classification('NOT_RELEVANT',
        '{"relevance": "not_relevant"}')) = 1,
    'the execution holding the claim can');

-- Two executions recovering the same stale row at the same time.
SELECT pg_temp.run(pg_temp.q('claim'), pg_temp.batch('race'), 'exec-dead', 'wf-1');
UPDATE triage_results SET claimed_at = now() - interval '2 hours' WHERE tender_reference = 'race';
BEGIN;
SELECT pg_temp.expect(pg_temp.run(pg_temp.q('recover'), 'exec-a') = 1,
    'execution a reclaims the stale row, uncommitted');
SELECT pg_temp.start_blocked(pg_temp.counted(pg_temp.q('recover'), 'exec-b'));
COMMIT;
SELECT pg_temp.expect(pg_temp.blocked_result() = 0,
    'execution b blocked on the row lock and reclaimed nothing once a committed');
SELECT pg_temp.expect(
    (SELECT execution_id = 'exec-a' AND attempts = 2
     FROM triage_results WHERE tender_reference = 'race'),
    'the row is held by a, with one attempt counted, not two');
