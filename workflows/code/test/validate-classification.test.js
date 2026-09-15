'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateClassification } = require('../validate-classification');
const { contract } = require('../../../config/routing-rules.json');

// The design doc's own example output, without the `currently_open` criterion the contract dropped.
const EXAMPLE = {
  category: 'enterprise_software',
  relevance: 'match',
  rationale: 'The notice requests an enterprise financial management platform.',
  criteria: { software_related: true, scope_clear: true, target_market_match: true },
  confidence: 0.91,
};

function errorsFor(output) {
  const result = validateClassification(output, contract);
  assert.equal(result.ok, false, 'expected the output to be rejected');
  return result.errors;
}

test('the design doc example passes, as an object or as JSON text', () => {
  assert.deepEqual(validateClassification(EXAMPLE, contract), { ok: true, classification: EXAMPLE });
  assert.deepEqual(validateClassification(JSON.stringify(EXAMPLE), contract),
    { ok: true, classification: EXAMPLE });
});

test('text that is not JSON is a failed classification, not an exception', () => {
  const errors = errorsFor('Sure! Here is the classification: {"relevance": "match"}');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^not valid JSON/);
});

test('JSON that is not an object is rejected', () => {
  for (const output of ['[]', 'null', '"match"', '42']) {
    assert.deepEqual(errorsFor(output), ['expected a JSON object']);
  }
});

test('a markdown-fenced object is not unwrapped — schema-constrained output never needs it', () => {
  assert.match(errorsFor('```json\n' + JSON.stringify(EXAMPLE) + '\n```')[0], /^not valid JSON/);
});

test('every missing field is reported, not only the first', () => {
  assert.deepEqual(errorsFor({ category: 'saas' }), [
    'relevance: missing', 'rationale: missing', 'criteria: missing', 'confidence: missing',
  ]);
});

test('a field outside the contract is rejected', () => {
  assert.deepEqual(errorsFor({ ...EXAMPLE, route: 'AUTO_MATCH' }), ['route: not in the contract']);
});

test('relevance and category must come from the contract', () => {
  const errors = errorsFor({ ...EXAMPLE, relevance: 'likely', category: 'hardware' });
  assert.ok(errors.some((e) => e.startsWith('relevance: expected one of match, uncertain, not_relevant')));
  assert.ok(errors.some((e) => e.startsWith('category: expected one of enterprise_software')));
});

test('a blank rationale is not a rationale', () => {
  assert.deepEqual(errorsFor({ ...EXAMPLE, rationale: '   ' }),
    ['rationale: expected a non-empty string']);
});

test('criteria must be exactly the contract criteria, each a real boolean', () => {
  const errors = errorsFor({ ...EXAMPLE, criteria: { software_related: 'true', currently_open: true,
    scope_clear: true, vibes: true } });
  assert.deepEqual(errors, [
    'criteria.software_related: expected true or false',
    'criteria.target_market_match: missing',
    'criteria.currently_open: not in the contract',
    'criteria.vibes: not in the contract',
  ]);
  assert.deepEqual(errorsFor({ ...EXAMPLE, criteria: [true, true] }),
    ['criteria: expected an object']);
});

test('confidence must be a number from 0 to 1', () => {
  for (const confidence of [1.2, -0.1, '0.9', null, Number.NaN]) {
    assert.deepEqual(errorsFor({ ...EXAMPLE, confidence }),
      ['confidence: expected a number from 0 to 1'], `confidence ${confidence}`);
  }
  for (const confidence of [0, 1]) {
    assert.equal(validateClassification({ ...EXAMPLE, confidence }, contract).ok, true);
  }
});

test('contradictory but well-formed output passes validation — routing handles it', () => {
  const contradictory = { ...EXAMPLE, relevance: 'not_relevant' };
  assert.equal(validateClassification(contradictory, contract).ok, true);
});
