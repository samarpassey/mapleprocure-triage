'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mergeResults } = require('../merge-results');

const NOW = '2026-09-13T20:00:00';

function row(reference, fields = {}) {
  return { reference_number: reference, title: `Title ${reference}`, buyer_name: 'SSC',
    closing_date: '2026-10-20T14:00:00', category: 'Services', regions_of_delivery: 'Canada',
    notice_url: `https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/${reference}`,
    ...fields };
}

// Shaped like a live /v1/tenders/search response.
function envelope(rows, fields = {}) {
  return { rows, row_count: rows.length, total_matches: rows.length, withheld: 0, truncated: false,
    as_of: '2026-09-14T00:19:57+00:00', source_file: 'https://canadabuys.canada.ca/x.csv',
    source_last_modified: 'Sun, 13 Sep 2026 10:20:16 GMT', source_row_count: 901, coverage: {},
    notes: [], ...fields };
}

test('a notice found by several concepts is kept once, with every concept that found it', () => {
  const { notices } = mergeResults([
    { concept: 'software', body: envelope([row('cb-1'), row('cb-2')]) },
    { concept: 'cloud', body: envelope([row('cb-2'), row('cb-3')]) },
    { concept: 'platform', body: envelope([row('cb-2')]) },
  ], { now: NOW });
  assert.deepEqual(notices.map((n) => [n.tender_reference, n.matched_concepts]), [
    ['cb-1', ['software']], ['cb-2', ['software', 'cloud', 'platform']], ['cb-3', ['cloud']],
  ]);
});

test('notices have exactly the columns claim.sql reads from its batch', () => {
  const claim = fs.readFileSync(path.join(__dirname, '../../../database/queries/claim.sql'), 'utf8');
  const columns = /AS n\(([^)]*)\)/.exec(claim)[1].split(',').map((c) => c.trim().split(/\s+/)[0]);
  const { notices } = mergeResults([{ concept: 'software', body: envelope([row('cb-1')]) }],
    { now: NOW });
  assert.deepEqual(Object.keys(notices[0]).sort(), columns.sort());
});

test('a notice already past closing is left out of the batch and listed, not dropped', () => {
  const result = mergeResults([{ concept: 'software', body: envelope([
    row('open'), row('closed', { closing_date: '2025-08-22T14:00:00' }),
  ]) }], { now: NOW });
  assert.deepEqual(result.notices.map((n) => n.tender_reference), ['open']);
  assert.deepEqual(result.closed, [{ tender_reference: 'closed', closing_date: '2025-08-22T14:00:00' }]);
});

test('a notice with no closing date is kept — it cannot be shown to be closed', () => {
  const { notices, closed } = mergeResults([{ concept: 'software',
    body: envelope([row('undated', { closing_date: null })]) }], { now: NOW });
  assert.deepEqual([notices.length, closed.length], [1, 0]);
});

test('a notice closing later today is still open', () => {
  const { notices } = mergeResults([{ concept: 'software',
    body: envelope([row('today', { closing_date: '2026-09-13T23:59:00' })]) }], { now: NOW });
  assert.equal(notices.length, 1);
});

test('a search that hit the row cap is reported, with what was lost', () => {
  const { truncated } = mergeResults([
    { concept: 'software', body: envelope([row('cb-1')], { total_matches: 140, withheld: 139,
      truncated: true }) },
    { concept: 'cloud', body: envelope([row('cb-2')]) },
  ], { now: NOW });
  assert.deepEqual(truncated, [{ concept: 'software', total_matches: 140, returned: 1 }]);
});

test('a missing or blank notice_url stays null — nothing is invented', () => {
  const { notices } = mergeResults([{ concept: 'software', body: envelope([
    row('none', { notice_url: null }), row('blank', { notice_url: '  ' }),
  ]) }], { now: NOW });
  assert.deepEqual(notices.map((n) => n.notice_url), [null, null]);
});

test('an empty search contributes nothing and is not an error', () => {
  const result = mergeResults([{ concept: 'licence', body: envelope([]) }], { now: NOW });
  assert.deepEqual(result, { notices: [], closed: [], truncated: [] });
});

test('a response that is not a MapleProcure envelope throws, naming the concept', () => {
  assert.throws(() => mergeResults([{ concept: 'cloud', body: { error: 'invalid_request' } }],
    { now: NOW }), /concept "cloud": response has no rows array/);
  assert.throws(() => mergeResults([{ concept: 'cloud', body: { rows: [] } }], { now: NOW }),
    /missing as_of, total_matches or truncated/);
  assert.throws(() => mergeResults([{ concept: 'cloud', body: envelope([{ title: 'x' }]) }],
    { now: NOW }), /no reference_number/);
  assert.throws(() => mergeResults([{ concept: 'cloud',
    body: envelope([row('cb-1', { closing_date: '20 Oct 2026' })]) }], { now: NOW }),
  /closing_date not understood/);
});

test('the clock must be local wall-clock time in the source\'s format', () => {
  for (const now of ['2026-09-13T20:00:00Z', '2026-09-13', undefined]) {
    assert.throws(() => mergeResults([], { now }), /now must be local time/);
  }
});
