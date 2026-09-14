'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRequests } = require('../build-requests');
const profile = require('../../../config/search-profile.json');

function withConcept(fields) {
  return { limit: 100, concepts: [{ id: 'software', keywords: 'software', ...fields }] };
}

test('the committed profile becomes one search per concept, in profile order', () => {
  const requests = buildRequests(profile);
  assert.deepEqual(requests.map((r) => r.concept), profile.concepts.map((c) => c.id));
  assert.deepEqual(requests[0],
    { concept: 'software', method: 'GET', path: '/v1/tenders/search',
      query: { keywords: 'software', limit: 100 } });
});

test('only keywords and limit are ever sent', () => {
  for (const { query } of buildRequests(profile)) {
    assert.deepEqual(Object.keys(query).sort(), ['keywords', 'limit']);
  }
});

test('every committed concept was measured under the row cap', () => {
  for (const concept of profile.concepts) {
    assert.ok(concept.matches_when_measured < profile.limit,
      `${concept.id} matched ${concept.matches_when_measured}`);
  }
});

test('no committed concept is excluded elsewhere in the same profile', () => {
  const excluded = new Set(profile.excluded.map((e) => e.keywords.toLowerCase()));
  for (const concept of profile.concepts) {
    assert.ok(!excluded.has(concept.keywords.toLowerCase()), concept.keywords);
  }
});

test('an unknown field is refused, because MapleProcure would silently ignore it', () => {
  assert.throws(() => buildRequests(withConcept({ q: 'software' })),
    /unknown field "q" — MapleProcure would silently ignore it/);
});

test('closing_before is refused: it drops notices with no closing date', () => {
  assert.throws(() => buildRequests(withConcept({ closing_before: '2026-12-31' })),
    /"closing_before" is not sent/);
});

test('region is refused', () => {
  assert.throws(() => buildRequests(withConcept({ region: 'Ontario' })), /"region" is not sent/);
});

test('a limit over MapleProcure\'s cap of 100 is refused rather than clamped', () => {
  assert.throws(() => buildRequests({ ...withConcept({}), limit: 500 }), /from 1 to 100/);
});

test('blank keywords, duplicate ids and malformed ids are refused', () => {
  assert.throws(() => buildRequests(withConcept({ keywords: '  ' })), /keywords/);
  assert.throws(() => buildRequests(withConcept({ id: 'Software Licensing' })), /id must be/);
  assert.throws(() => buildRequests({ limit: 100, concepts: [
    { id: 'cloud', keywords: 'cloud' }, { id: 'cloud', keywords: 'cloud hosting' },
  ] }), /duplicate id/);
  assert.throws(() => buildRequests({ limit: 100, concepts: [] }), /no concepts/);
});
