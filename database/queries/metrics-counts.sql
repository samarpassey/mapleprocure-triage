-- Counts behind the metrics rollup: routed rows classified in a window, by how they were routed
-- and where they are now. The definitions — what counts as decided without a human, the split —
-- live in workflows/code/metrics-rollup.js, which takes these rows as input. Answerable from
-- triage_results_metrics_idx alone.
--
-- $1 timestamptz  window start, inclusive
-- $2 timestamptz  window end, exclusive
SELECT routed_status, status, count(*)::integer AS n
FROM triage_results
WHERE routed_status IS NOT NULL
  AND classified_at >= $1::timestamptz
  AND classified_at < $2::timestamptz
GROUP BY routed_status, status
ORDER BY routed_status, status;
