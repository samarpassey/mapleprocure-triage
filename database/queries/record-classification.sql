-- Record a routed classification — or a failed one — against a claimed row.
--
-- Only the execution holding the claim can write, and only once: the row must still be PENDING
-- and still carry this execution's id. An execution whose claim was taken over by recover.sql
-- gets no row back, which means "discard this result", not "retry".
--
-- $1 text   tender reference
-- $2 text   n8n execution id that claimed it
-- $3 jsonb  one object with the keys named in the column list below. routed_status comes from
--           workflows/code/route.js, or is CLASSIFICATION_FAILED with validation_errors from
--           workflows/code/validate-classification.js. source_* are copied from the envelope of
--           the MapleProcure detail response the model read; source_last_modified is the HTTP
--           date exactly as MapleProcure sends it.
UPDATE triage_results AS t
SET status               = c.routed_status,
    routed_status        = c.routed_status,
    routing_rule         = c.routing_rule,
    category             = c.category,
    relevance            = c.relevance,
    rationale            = c.rationale,
    criteria             = c.criteria,
    model_confidence     = c.model_confidence,
    validation_errors    = c.validation_errors,
    model_output_raw     = c.model_output_raw,
    model_name           = c.model_name,
    prompt_version       = c.prompt_version,
    rules_version        = c.rules_version,
    input_sha256         = c.input_sha256,
    source_file          = c.source_file,
    source_as_of         = c.source_as_of,
    source_last_modified = c.source_last_modified,
    source_row_count     = c.source_row_count,
    source_notes         = c.source_notes,
    classified_at        = now()
FROM jsonb_to_record($3::jsonb) AS c(
    routed_status text, routing_rule text, category text, relevance text, rationale text,
    criteria jsonb, model_confidence numeric, validation_errors jsonb, model_output_raw text,
    model_name text, prompt_version text, rules_version text, input_sha256 text,
    source_file text, source_as_of timestamptz, source_last_modified timestamptz,
    source_row_count integer, source_notes jsonb
)
WHERE t.tender_reference = $1::text
  AND t.execution_id = $2::text
  AND t.status = 'PENDING'
RETURNING t.tender_reference, t.status, t.routing_rule, t.title, t.buyer_name, t.closing_date,
          t.notice_url, t.category, t.rationale, t.source_file, t.source_as_of;
