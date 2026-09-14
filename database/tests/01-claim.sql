-- claim.sql: the insert is the dedup check.
\ir _harness.sql

SELECT pg_temp.expect(pg_temp.run(pg_temp.q('claim'), '[
    {"tender_reference": "cb-1", "title": "Cloud platform", "buyer_name": "SSC",
     "closing_date": "2026-10-20T14:00:00", "notice_url": null,
     "matched_concepts": ["cloud", "platform"]},
    {"tender_reference": "cb-2", "title": "Licences", "buyer_name": null,
     "closing_date": null, "notice_url": "https://canadabuys.canada.ca/cb-2",
     "matched_concepts": ["licence"]},
    {"tender_reference": "cb-1", "title": "Duplicate inside the batch", "buyer_name": "SSC",
     "closing_date": null, "notice_url": null, "matched_concepts": ["software"]}
]', 'exec-a', 'wf-1') = 2, 'a batch claims each new reference once, duplicates inside it skipped');

SELECT pg_temp.expect(
    (SELECT title = 'Cloud platform' AND matched_concepts = ARRAY['cloud', 'platform']
            AND notice_url IS NULL AND closing_date = '2026-10-20 14:00'
            AND status = 'PENDING' AND attempts = 1 AND execution_id = 'exec-a'
     FROM triage_results WHERE tender_reference = 'cb-1'),
    'the first occurrence is stored as sent: concepts, null URL and local closing time intact');

SELECT pg_temp.expect(
    pg_temp.run(pg_temp.q('claim'), pg_temp.batch('cb-1'), 'exec-b', 'wf-1') = 0,
    're-claiming a claimed reference returns nothing');

SELECT pg_temp.expect(
    (SELECT execution_id = 'exec-a' FROM triage_results WHERE tender_reference = 'cb-1'),
    'and leaves the existing claim untouched');

SELECT pg_temp.expect(pg_temp.run(pg_temp.q('claim'), '[
    {"tender_reference": "cb-2", "title": "Licences", "matched_concepts": ["licence"]},
    {"tender_reference": "cb-3", "title": "New", "matched_concepts": ["software"]}
]', 'exec-b', 'wf-1') = 1, 'an overlapping batch claims only the reference not seen before');

UPDATE triage_results SET status = 'PROCESSING_FAILED' WHERE tender_reference = 'cb-3';
SELECT pg_temp.expect(
    pg_temp.run(pg_temp.q('claim'), pg_temp.batch('cb-3'), 'exec-c', 'wf-1') = 0,
    'a reference that failed processing is not silently re-claimed');

-- Two executions claiming the same new reference at the same time.
BEGIN;
SELECT pg_temp.expect(
    pg_temp.run(pg_temp.q('claim'), pg_temp.batch('cb-race'), 'exec-a', 'wf-1') = 1,
    'execution a claims cb-race, uncommitted');
SELECT pg_temp.start_blocked(
    pg_temp.counted(pg_temp.q('claim'), pg_temp.batch('cb-race'), 'exec-b', 'wf-1'));
COMMIT;
SELECT pg_temp.expect(pg_temp.blocked_result() = 0,
    'execution b blocked on the same reference and claimed nothing once a committed');
SELECT pg_temp.expect(
    (SELECT count(*) = 1 AND min(execution_id) = 'exec-a'
     FROM triage_results WHERE tender_reference = 'cb-race'),
    'exactly one row, held by a');
