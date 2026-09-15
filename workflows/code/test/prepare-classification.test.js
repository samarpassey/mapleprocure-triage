'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareClassification, responseSchema } = require('../prepare-classification');
const { validateClassification } = require('../validate-classification');
const rules = require('../../../config/routing-rules.json');
const settings = require('../../../config/classifier.json');

const context = { settings, prompt: 'System prompt.', contract: rules.contract };

// Shape of a live MapleProcure detail response, trimmed.
function detail(overrides = {}) {
  return {
    rows: [{
      reference_number: 'MX-444156855310', title: 'Peoplesoft Managed Services',
      buyer_name: 'Export Development Canada - EDC', end_user_name: null,
      notice_type: 'RFP', procurement_method: 'Competitive - Open bidding', category: 'Services',
      gsin: null, gsin_description: null, unspsc: '*81111500', unspsc_description: '*Software',
      regions_of_delivery: null, closing_date: '2026-10-02T13:00:00',
      description: 'Line one.\r\nLine two.', ...overrides,
    }],
    as_of: '2026-09-14T00:19:57+00:00',
    source_file: 'https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv',
    source_last_modified: 'Sun, 13 Sep 2026 10:20:16 GMT',
    source_row_count: 901,
    notes: ['A snapshot, not a live feed.'],
  };
}

test('a lookup that returns 200 with no rows is not found, not an error', () => {
  const empty = { ...detail(), rows: [] };
  assert.deepEqual(prepareClassification(empty, 'MX-444156855310', context),
    { tender_reference: 'MX-444156855310', found: false });
});

test('an error item passed on by n8n, or a row for another reference, is not found', () => {
  for (const body of [{ error: { message: 'timeout' } }, null, detail({ reference_number: 'other' })]) {
    assert.equal(prepareClassification(body, 'MX-444156855310', context).found, false);
  }
});

test('the notice text is labelled fields and the description, with blanks and dates left out', () => {
  const { notice_text: text } = prepareClassification(detail(), 'MX-444156855310', context);
  assert.equal(text, [
    'Reference: MX-444156855310',
    'Title: Peoplesoft Managed Services',
    'Buyer: Export Development Canada - EDC',
    'Notice type: RFP',
    'Procurement method: Competitive - Open bidding',
    'Category: Services',
    'UNSPSC: *81111500 *Software',
    '',
    'Description:',
    'Line one.\nLine two.',
  ].join('\n'));
});

test('a missing description is said, not left blank', () => {
  const { notice_text: text } = prepareClassification(detail({ description: '  ' }),
    'MX-444156855310', context);
  assert.match(text, /Description:\n\(no description in the source\)$/);
});

test('the request sends exactly the notice text, with the configured model and structured output', () => {
  const prepared = prepareClassification(detail(), 'MX-444156855310', context);
  assert.deepEqual(prepared.request.messages, [{ role: 'user', content: prepared.notice_text }]);
  assert.equal(prepared.request.model, settings.model);
  assert.equal(prepared.request.fallbacks, settings.fallbacks);
  assert.equal(prepared.request.system, 'System prompt.');
  assert.equal(prepared.request.output_config.effort, settings.effort);
  assert.equal(prepared.request.output_config.format.type, 'json_schema');
  assert.deepEqual(prepared.request.output_config.format.schema, responseSchema(rules.contract));
});

test('every object in the schema forbids extra properties and requires every property', () => {
  const objects = [];
  (function walk(node) {
    if (node && typeof node === 'object') {
      if (node.type === 'object') objects.push(node);
      Object.values(node).forEach(walk);
    }
  }(responseSchema(rules.contract)));
  assert.equal(objects.length, 2);
  for (const object of objects) {
    assert.equal(object.additionalProperties, false);
    assert.deepEqual([...object.required].sort(), Object.keys(object.properties).sort());
  }
});

test('the schema and the validator agree: output built from the schema passes validation', () => {
  const schema = responseSchema(rules.contract);
  assert.deepEqual(schema.properties.criteria.required, rules.contract.criteria);
  assert.ok(!schema.properties.criteria.required.includes('currently_open'));
  const output = {
    category: schema.properties.category.enum[0],
    relevance: schema.properties.relevance.enum[0],
    rationale: 'Buys software.',
    criteria: Object.fromEntries(schema.properties.criteria.required.map((name) => [name, true])),
    confidence: 0.9,
  };
  assert.equal(validateClassification(output, rules.contract).ok, true);
});

test('provenance comes from the envelope, and a response without it is refused', () => {
  const prepared = prepareClassification(detail(), 'MX-444156855310', context);
  assert.deepEqual(prepared.envelope, {
    source_file: detail().source_file, source_as_of: '2026-09-14T00:19:57+00:00',
    source_last_modified: 'Sun, 13 Sep 2026 10:20:16 GMT', source_row_count: 901,
    source_notes: ['A snapshot, not a live feed.'],
  });
  for (const field of ['as_of', 'source_file', 'source_last_modified', 'source_row_count']) {
    const broken = detail();
    delete broken[field];
    assert.throws(() => prepareClassification(broken, 'MX-444156855310', context),
      new RegExp(`no ${field}`));
  }
});
