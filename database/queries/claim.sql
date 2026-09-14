-- Claim notices for classification. The insert is the dedup check.
--
-- Rows returned are exactly the references this execution claimed. A reference already in the
-- table — claimed, classified or decided, by this execution or any other — is skipped by
-- ON CONFLICT DO NOTHING and not returned. Concurrent executions claiming the same reference
-- serialise on the unique index: the second blocks until the first commits, then skips it.
-- Re-running the same batch claims nothing. A duplicate inside one batch is skipped, not an error.
--
-- Never replace this with a SELECT for known references followed by an INSERT: two executions
-- can both pass the SELECT.
--
-- $1 jsonb  array produced by workflows/code/merge-results.js:
--           [{tender_reference, title, buyer_name, closing_date, notice_url, matched_concepts}]
-- $2 text   n8n execution id
-- $3 text   workflow version
INSERT INTO triage_results (
    tender_reference, title, buyer_name, closing_date, notice_url, matched_concepts,
    execution_id, workflow_version
)
SELECT n.tender_reference, n.title, n.buyer_name, n.closing_date, n.notice_url,
       n.matched_concepts, $2::text, $3::text
FROM jsonb_to_recordset($1::jsonb) AS n(
    tender_reference text, title text, buyer_name text, closing_date timestamp,
    notice_url text, matched_concepts text[]
)
ON CONFLICT (tender_reference) DO NOTHING
RETURNING tender_reference, title, buyer_name, closing_date, notice_url, matched_concepts,
          attempts;
