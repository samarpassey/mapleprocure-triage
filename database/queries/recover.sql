-- Reclaim rows stuck in PENDING for over an hour: an execution died between claiming and
-- classifying them.
--
-- This is a conditional UPDATE, not a SELECT followed by work. Under READ COMMITTED a concurrent
-- execution running the same statement blocks on the row lock, re-evaluates the WHERE clause
-- against the row as updated, finds claimed_at fresh, and skips it — so each stale row is
-- reclaimed by exactly one execution. Reclaiming also moves execution_id, which fences out the
-- execution that died: if it was only slow, record-classification.sql refuses its late result.
--
-- A row on its third attempt is not reclaimed again. It becomes PROCESSING_FAILED, so a notice
-- that kills the run every time cannot kill every run. Rows are returned either way: the workflow
-- classifies those still PENDING and alerts on those that became PROCESSING_FAILED.
--
-- The one-hour threshold assumes an execution classifies its whole batch well inside an hour.
--
-- $1 text  n8n execution id taking over the claim
UPDATE triage_results
SET execution_id = $1::text,
    claimed_at   = now(),
    attempts     = attempts + CASE WHEN attempts < 3 THEN 1 ELSE 0 END,
    status       = CASE WHEN attempts < 3 THEN 'PENDING' ELSE 'PROCESSING_FAILED' END
WHERE status = 'PENDING'
  AND claimed_at < now() - interval '1 hour'
RETURNING tender_reference, status, attempts, title, buyer_name, closing_date, notice_url,
          matched_concepts;
