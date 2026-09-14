'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rollupMetrics } = require('../metrics-rollup');

// The design doc's example: 100 processed, 58 auto-matched, 25 not relevant, 17 reviewed.
// Here the 17 are split 12 uncertain, 3 contradictory, 2 failed, and 9 have been decided.
const DOC_EXAMPLE = [
  { routed_status: 'AUTO_MATCH', status: 'AUTO_MATCH', n: 58 },
  { routed_status: 'NOT_RELEVANT', status: 'NOT_RELEVANT', n: 25 },
  { routed_status: 'NEEDS_REVIEW', status: 'NEEDS_REVIEW', n: 7 },
  { routed_status: 'NEEDS_REVIEW', status: 'HUMAN_APPROVED', n: 3 },
  { routed_status: 'NEEDS_REVIEW', status: 'HUMAN_REJECTED', n: 2 },
  { routed_status: 'NEEDS_REVIEW_CONTRADICTION', status: 'HUMAN_APPROVED', n: 3 },
  { routed_status: 'CLASSIFICATION_FAILED', status: 'HUMAN_REJECTED', n: 1 },
  { routed_status: 'CLASSIFICATION_FAILED', status: 'CLASSIFICATION_FAILED', n: 1 },
];

test('the headline always carries its split', () => {
  assert.equal(rollupMetrics(DOC_EXAMPLE).summary,
    '83% decided without a human, of which 58 auto-matched and 25 dismissed; ' +
    '17 sent to review (12 uncertain, 3 contradictory, 2 failed classification).');
});

test('dismissed notices count as decided without a human', () => {
  const { processed, decided_without_human: decided } = rollupMetrics(DOC_EXAMPLE);
  assert.equal(processed, 100);
  assert.deepEqual(decided, { total: 83, auto_matched: 58, dismissed: 25, share: 0.83 });
});

test('review is counted by how a row was routed, whatever a person later decided', () => {
  assert.deepEqual(rollupMetrics(DOC_EXAMPLE).sent_to_review, {
    total: 17, uncertain: 12, contradictory: 3, classification_failed: 2, share: 0.17,
    approved: 6, rejected: 3, awaiting_decision: 8,
  });
});

test('contradiction and invalid-output rates are reported as shares of processed', () => {
  const rollup = rollupMetrics(DOC_EXAMPLE);
  assert.equal(rollup.contradiction_rate, 0.03);
  assert.equal(rollup.invalid_output_rate, 0.02);
});

test('time saved is labelled an estimate and counts every notice decided without a human', () => {
  assert.deepEqual(rollupMetrics(DOC_EXAMPLE).estimated_time_saved, {
    minutes: 249, hours: 4.2,
    basis: 'an assumed 3 minutes per notice decided without a human — an estimate, not a measurement',
  });
  assert.equal(rollupMetrics(DOC_EXAMPLE, { minutesPerNotice: 5 }).estimated_time_saved.minutes, 415);
});

test('an empty window reports nulls, not NaN or a divide-by-zero 0%', () => {
  const rollup = rollupMetrics([]);
  assert.equal(rollup.processed, 0);
  assert.equal(rollup.decided_without_human.share, null);
  assert.equal(rollup.contradiction_rate, null);
  assert.equal(rollup.summary, 'No notices processed in this window.');
});

test('counts that arrive as strings from the database driver are accepted', () => {
  const rollup = rollupMetrics([{ routed_status: 'AUTO_MATCH', status: 'AUTO_MATCH', n: '4' }]);
  assert.equal(rollup.decided_without_human.auto_matched, 4);
});

test('an unknown routed status or a malformed count throws rather than being skipped', () => {
  assert.throws(() => rollupMetrics([{ routed_status: 'PENDING', status: 'PENDING', n: 1 }]),
    /unknown routed_status PENDING/);
  assert.throws(() => rollupMetrics([{ routed_status: 'AUTO_MATCH', status: 'AUTO_MATCH', n: 'x' }]),
    /not a non-negative integer/);
});
