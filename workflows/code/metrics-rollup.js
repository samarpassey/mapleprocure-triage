'use strict';

// Turns the rows of database/queries/metrics-counts.sql into the metrics rollup.
//
// Definitions (docs/DECISIONS.md, docs/DESIGN-AMENDMENTS.md A4):
//   processed               every row that reached routing
//   decided without human   AUTO_MATCH + NOT_RELEVANT, by how the row was routed
//   sent to review          NEEDS_REVIEW + NEEDS_REVIEW_CONTRADICTION + CLASSIFICATION_FAILED
//   contradiction rate      NEEDS_REVIEW_CONTRADICTION / processed — a prompt-quality signal
//   invalid-output rate     CLASSIFICATION_FAILED / processed
//
// The headline is never reported without its split. Dismissals count as work avoided, and missed
// opportunities hide among them, so the summary always says how many of each.
//
// The time saved is an estimate from an assumed minutes-per-notice, not a measurement, and says so.
// Shares are null, not NaN, when nothing was processed. Pure: no n8n globals, no I/O.

const DEFAULT_MINUTES_PER_NOTICE = 3;
const ROUTED = ['AUTO_MATCH', 'NOT_RELEVANT', 'NEEDS_REVIEW', 'NEEDS_REVIEW_CONTRADICTION',
  'CLASSIFICATION_FAILED'];

function tally(counts) {
  const byRouted = Object.fromEntries(ROUTED.map((status) => [status, 0]));
  const decided = { HUMAN_APPROVED: 0, HUMAN_REJECTED: 0 };
  for (const { routed_status: routed, status, n } of counts) {
    const count = Number(n);
    if (!ROUTED.includes(routed)) {
      throw new Error(`unknown routed_status ${routed}`);
    }
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`count for ${routed}/${status} is not a non-negative integer: ${n}`);
    }
    byRouted[routed] += count;
    if (status in decided) {
      decided[status] += count;
    }
  }
  return { byRouted, decided };
}

function share(part, whole) {
  return whole === 0 ? null : part / whole;
}

function percent(fraction) {
  return `${Math.round(fraction * 100)}%`;
}

function rollupMetrics(counts, { minutesPerNotice = DEFAULT_MINUTES_PER_NOTICE } = {}) {
  const { byRouted, decided } = tally(counts);
  const processed = ROUTED.reduce((sum, status) => sum + byRouted[status], 0);
  const automatic = byRouted.AUTO_MATCH + byRouted.NOT_RELEVANT;
  const review = byRouted.NEEDS_REVIEW + byRouted.NEEDS_REVIEW_CONTRADICTION +
    byRouted.CLASSIFICATION_FAILED;
  const minutes = automatic * minutesPerNotice;
  const summary = processed === 0
    ? 'No notices processed in this window.'
    : `${percent(automatic / processed)} decided without a human, of which ` +
      `${byRouted.AUTO_MATCH} auto-matched and ${byRouted.NOT_RELEVANT} dismissed; ` +
      `${review} sent to review (${byRouted.NEEDS_REVIEW} uncertain, ` +
      `${byRouted.NEEDS_REVIEW_CONTRADICTION} contradictory, ` +
      `${byRouted.CLASSIFICATION_FAILED} failed classification).`;
  return {
    processed,
    decided_without_human: {
      total: automatic,
      auto_matched: byRouted.AUTO_MATCH,
      dismissed: byRouted.NOT_RELEVANT,
      share: share(automatic, processed),
    },
    sent_to_review: {
      total: review,
      uncertain: byRouted.NEEDS_REVIEW,
      contradictory: byRouted.NEEDS_REVIEW_CONTRADICTION,
      classification_failed: byRouted.CLASSIFICATION_FAILED,
      share: share(review, processed),
      approved: decided.HUMAN_APPROVED,
      rejected: decided.HUMAN_REJECTED,
      awaiting_decision: review - decided.HUMAN_APPROVED - decided.HUMAN_REJECTED,
    },
    contradiction_rate: share(byRouted.NEEDS_REVIEW_CONTRADICTION, processed),
    invalid_output_rate: share(byRouted.CLASSIFICATION_FAILED, processed),
    estimated_time_saved: {
      minutes,
      hours: Math.round(minutes / 6) / 10,
      basis: `an assumed ${minutesPerNotice} minutes per notice decided without a human — ` +
        'an estimate, not a measurement',
    },
    summary,
  };
}

module.exports = { rollupMetrics, DEFAULT_MINUTES_PER_NOTICE };
