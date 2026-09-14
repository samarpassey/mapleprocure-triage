-- The human review queue: uncertain, contradictory and failed classifications, soonest-closing
-- first, undated last. Failed classifications are included by decision — a failure must not be
-- able to sit unseen. Uses triage_results_review_queue_idx; keep the WHERE clause identical to
-- that index's predicate.
--
-- $1 integer  maximum rows
SELECT tender_reference, status, title, buyer_name, closing_date, notice_url, matched_concepts,
       category, relevance, rationale, criteria, model_confidence, routing_rule,
       validation_errors, model_output_raw, model_name, source_file, source_as_of,
       source_last_modified, classified_at
FROM triage_results
WHERE status IN ('NEEDS_REVIEW', 'NEEDS_REVIEW_CONTRADICTION', 'CLASSIFICATION_FAILED')
ORDER BY closing_date ASC NULLS LAST, classified_at
LIMIT $1::integer;
