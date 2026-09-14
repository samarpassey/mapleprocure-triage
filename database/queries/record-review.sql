-- Record a person's decision on a review-queue row.
--
-- The first decision stands: a row already decided, or never in the queue, returns nothing.
-- routed_status is left as it was, so the metrics still know how the row reached review.
--
-- $1 text  tender reference
-- $2 text  HUMAN_APPROVED or HUMAN_REJECTED — anything else updates nothing
-- $3 text  reviewer
-- $4 text  note, or null
UPDATE triage_results
SET status      = $2::text,
    reviewed_by = $3::text,
    reviewed_at = now(),
    review_note = $4::text
WHERE tender_reference = $1::text
  AND status IN ('NEEDS_REVIEW', 'NEEDS_REVIEW_CONTRADICTION', 'CLASSIFICATION_FAILED')
  AND $2::text IN ('HUMAN_APPROVED', 'HUMAN_REJECTED')
RETURNING tender_reference, status, routed_status, title, buyer_name, closing_date, notice_url,
          category, rationale, source_file, source_as_of, reviewed_by, reviewed_at;
