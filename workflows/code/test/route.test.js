'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { route, checkRules } = require('../route');
const rules = require('../../../config/routing-rules.json');

const CRITERIA = ['software_related', 'currently_open', 'scope_clear', 'target_market_match'];

function classify(relevance, criteria) {
  return { category: 'other', relevance, rationale: 'r', confidence: 0.5, criteria };
}

function everyCombination() {
  const all = [];
  for (const relevance of ['match', 'uncertain', 'not_relevant']) {
    for (let bits = 0; bits < 16; bits += 1) {
      const criteria = Object.fromEntries(CRITERIA.map((name, i) => [name, Boolean(bits & (1 << i))]));
      all.push(classify(relevance, criteria));
    }
  }
  return all;
}

const allTrue = { software_related: true, currently_open: true, scope_clear: true,
  target_market_match: true };

test('design doc Tender A — clear software match — is AUTO_MATCH', () => {
  assert.deepEqual(route(classify('match', allTrue), rules),
    { status: 'AUTO_MATCH', rule: 'strong-match', rules_version: rules.version });
});

test('design doc Tender B — office furniture — is NOT_RELEVANT', () => {
  const furniture = classify('not_relevant', { software_related: false, currently_open: true,
    scope_clear: true, target_market_match: false });
  assert.equal(route(furniture, rules).status, 'NOT_RELEVANT');
});

test('design doc Tender C — software, unclear scope, uncertain — is NEEDS_REVIEW', () => {
  const transformation = classify('uncertain', { ...allTrue, scope_clear: false,
    target_market_match: false });
  assert.equal(route(transformation, rules).status, 'NEEDS_REVIEW');
});

test('not_relevant contradicted by its own criteria goes to its own review status', () => {
  const result = route(classify('not_relevant', allTrue), rules);
  assert.deepEqual([result.status, result.rule], ['NEEDS_REVIEW_CONTRADICTION', 'contradiction']);
});

test('the contradiction rule comes before the not-relevant rule in the committed file', () => {
  const ids = rules.rules.map((rule) => rule.id);
  assert.ok(ids.indexOf('contradiction') < ids.indexOf('not-relevant'), ids.join(' > '));
});

test('order is load-bearing: moved after not-relevant, a contradiction is dismissed', () => {
  const reordered = structuredClone(rules);
  const [contradiction] = reordered.rules.splice(
    reordered.rules.findIndex((rule) => rule.id === 'contradiction'), 1);
  reordered.rules.push(contradiction);
  assert.equal(route(classify('not_relevant', allTrue), reordered).status, 'NOT_RELEVANT');
});

// Expected counts over all 48 combinations, derived by hand from the rules, not by running them:
// AUTO_MATCH is one combination (match, all four true). Of the 16 not_relevant combinations, 4
// have software_related and target_market_match both true — contradictions. Of the other 12, the
// 6 with scope_clear true are dismissed. Everything else, 37, is plain review.
test('across every possible output, routing lands exactly where the rules say', () => {
  const counts = {};
  for (const classification of everyCombination()) {
    const { status } = route(classification, rules);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  assert.deepEqual(counts,
    { AUTO_MATCH: 1, NOT_RELEVANT: 6, NEEDS_REVIEW_CONTRADICTION: 4, NEEDS_REVIEW: 37 });
});

test('uncertain is never routed automatically, whatever the criteria say', () => {
  for (const classification of everyCombination().filter((c) => c.relevance === 'uncertain')) {
    assert.match(route(classification, rules).status, /^NEEDS_REVIEW/);
  }
});

test('anything short of all four criteria is not an auto-match', () => {
  for (const name of CRITERIA) {
    const result = route(classify('match', { ...allTrue, [name]: false }), rules);
    assert.equal(result.status, 'NEEDS_REVIEW', `with ${name} false`);
  }
});

test('an output no rule matches falls back to review, and says so', () => {
  const result = route(classify('match', { ...allTrue, currently_open: false }), rules);
  assert.deepEqual([result.status, result.rule], ['NEEDS_REVIEW', 'no-rule-matched']);
});

function withRule(change) {
  const config = structuredClone(rules);
  change(config);
  return config;
}

test('a misspelt field is refused rather than becoming a rule that never matches', () => {
  const config = withRule((c) => { c.rules[1].when = { 'criteria.scop_clear': false }; });
  assert.throws(() => route(classify('match', allTrue), config), /unknown field "criteria.scop_clear"/);
});

test('a rule cannot auto-match output the model did not call a match', () => {
  const config = withRule((c) => {
    c.rules.unshift({ id: 'eager', when: { relevance: 'uncertain' }, route: 'AUTO_MATCH' });
  });
  assert.throws(() => checkRules(config), /requires relevance "match"/);
});

test('a rule cannot dismiss output the model did not call irrelevant', () => {
  const config = withRule((c) => {
    c.rules.unshift({ id: 'tidy', when: { 'criteria.software_related': false }, route: 'NOT_RELEVANT' });
  });
  assert.throws(() => checkRules(config), /requires relevance "not_relevant"/);
});

test('the fallback cannot be an automatic decision', () => {
  const config = withRule((c) => { c.fallback.route = 'NOT_RELEVANT'; });
  assert.throws(() => checkRules(config), /fallback must/);
});

test('duplicate rule ids, unknown routes, empty conditions and non-boolean criteria are refused', () => {
  const broken = [
    (c) => { c.rules[1].id = 'contradiction'; },
    (c) => { c.rules[1].route = 'ESCALATE'; },
    (c) => { c.rules[1].when = {}; },
    (c) => { c.rules[1].when = { 'criteria.scope_clear': 'no' }; },
    (c) => { c.rules[2].when = { relevance: 'maybe' }; },
  ];
  for (const change of broken) {
    assert.throws(() => checkRules(withRule(change)));
  }
});
