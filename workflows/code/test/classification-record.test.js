'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recordFor } = require('../classification-record');
const { validateClassification } = require('../validate-classification');
const { route } = require('../route');
const rules = require('../../../config/routing-rules.json');

const modules = { validateClassification, route };
const options = { rules, promptVersion: 'prompt-under-test' };
const prepared = {
  notice_text: 'Title: A notice',
  envelope: { source_file: 'file.csv', source_as_of: '2026-09-14T00:19:57+00:00',
    source_last_modified: 'Sun, 13 Sep 2026 10:20:16 GMT', source_row_count: 901, source_notes: null },
};
const classification = {
  category: 'enterprise_software', relevance: 'match', rationale: 'Buys an ERP.',
  criteria: { software_related: true, scope_clear: true, target_market_match: true },
  confidence: 0.93,
};

function message(text, overrides = {}) {
  return {
    type: 'message', model: 'claude-opus-5', stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }], ...overrides,
  };
}

test('a valid classification is routed and carries provenance, text and the answering model', () => {
  const record = recordFor(message(JSON.stringify(classification)), prepared, options, modules);
  assert.deepEqual(record, {
    model_name: 'claude-opus-5', prompt_version: 'prompt-under-test', rules_version: rules.version,
    notice_text: 'Title: A notice', ...prepared.envelope,
    routed_status: 'AUTO_MATCH', routing_rule: 'strong-match', category: 'enterprise_software',
    relevance: 'match', rationale: 'Buys an ERP.', criteria: classification.criteria,
    model_confidence: 0.93, validation_errors: null, model_output_raw: null,
  });
});

test('a confident-looking match below the floor is recorded as held back for review', () => {
  const hesitant = { ...classification, confidence: rules.confidence_floor.min - 0.05 };
  const record = recordFor(message(JSON.stringify(hesitant)), prepared, options, modules);
  assert.deepEqual([record.routed_status, record.routing_rule],
    ['NEEDS_REVIEW', 'below-confidence-floor']);
});

test('output that fails the contract is CLASSIFICATION_FAILED with its errors and raw text', () => {
  const raw = JSON.stringify({ ...classification, relevance: 'maybe' });
  const record = recordFor(message(raw), prepared, options, modules);
  assert.equal(record.routed_status, 'CLASSIFICATION_FAILED');
  assert.equal(record.model_output_raw, raw);
  assert.match(record.validation_errors[0], /^relevance: expected one of/);
  assert.equal(record.category, null);
  assert.equal(record.notice_text, 'Title: A notice');
});

test('a refusal or a max_tokens stop is a failed classification, whatever text it carries', () => {
  for (const stop of ['refusal', 'max_tokens']) {
    const record = recordFor(message(JSON.stringify(classification), { stop_reason: stop }),
      prepared, options, modules);
    assert.equal(record.routed_status, 'CLASSIFICATION_FAILED');
    assert.deepEqual(record.validation_errors, [`the model stopped with stop_reason ${stop}`]);
  }
});

test('a message with no text block is a failed classification', () => {
  const record = recordFor(message('', { content: [] }), prepared, options, modules);
  assert.deepEqual(record.validation_errors, ['the response has no text block']);
});

test('no message at all records nothing, leaving the claim to recovery', () => {
  for (const response of [null, { error: { message: '529 overloaded' } }, { type: 'error' }]) {
    assert.equal(recordFor(response, prepared, options, modules), null);
  }
});
