'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { route, checkRules } = require('../route');
const rules = require('../../../config/routing-rules.json');

const CRITERIA = ['software_related', 'scope_clear', 'target_market_match'];
const FLOOR = rules.confidence_floor.min;
const CONFIDENT = 0.95;
const HESITANT = FLOOR - 0.01;

function classify(relevance, criteria, confidence = CONFIDENT) {
  return { category: 'other', relevance, rationale: 'r', confidence, criteria };
}

function everyCombination(confidence) {
  const all = [];
  for (const relevance of ['match', 'uncertain', 'not_relevant']) {
    for (let bits = 0; bits < 2 ** CRITERIA.length; bits += 1) {
      const criteria = Object.fromEntries(CRITERIA.map((name, i) => [name, Boolean(bits & (1 << i))]));
      all.push(classify(relevance, criteria, confidence));
    }
  }
  return all;
}

function tally(classifications) {
  const counts = {};
  for (const classification of classifications) {
    const { status } = route(classification, rules);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

const allTrue = { software_related: true, scope_clear: true, target_market_match: true };

test('design doc Tender A — clear software match — is AUTO_MATCH', () => {
  assert.deepEqual(route(classify('match', allTrue), rules),
    { status: 'AUTO_MATCH', rule: 'strong-match', rules_version: rules.version });
});

test('design doc Tender B — office furniture — is NOT_RELEVANT', () => {
  const furniture = classify('not_relevant', { software_related: false, scope_clear: true,
    target_market_match: false });
  assert.equal(route(furniture, rules).status, 'NOT_RELEVANT');
});

test('design doc Tender C — software, unclear scope, uncertain — is NEEDS_REVIEW', () => {
  const transformation = classify('uncertain', { ...allTrue, scope_clear: false,
    target_market_match: false });
  assert.equal(route(transformation, rules).status, 'NEEDS_REVIEW');
});

test('not_relevant contradicted by its own criteria is a contradiction', () => {
  const result = route(classify('not_relevant', allTrue), rules);
  assert.deepEqual([result.status, result.rule],
    ['NEEDS_REVIEW_CONTRADICTION', 'contradiction-not-relevant']);
});

test('match outside the target market is a contradiction, whatever else the output says', () => {
  for (const software_related of [true, false]) {
    for (const scope_clear of [true, false]) {
      const result = route(classify('match',
        { software_related, scope_clear, target_market_match: false }), rules);
      assert.deepEqual([result.status, result.rule],
        ['NEEDS_REVIEW_CONTRADICTION', 'contradiction-match-off-market']);
    }
  }
});

test('both contradiction rules come before every other rule in the committed file', () => {
  assert.deepEqual(rules.rules.slice(0, 2).map((rule) => rule.id),
    ['contradiction-not-relevant', 'contradiction-match-off-market']);
});

test('order is load-bearing: moved last, a contradiction is dismissed', () => {
  const reordered = structuredClone(rules);
  const [contradiction] = reordered.rules.splice(
    reordered.rules.findIndex((rule) => rule.id === 'contradiction-not-relevant'), 1);
  reordered.rules.push(contradiction);
  assert.equal(route(classify('not_relevant', allTrue), reordered).status, 'NOT_RELEVANT');
});

// Expected counts over all 24 combinations, derived by hand from the rules, not by running them.
// match (8): the 4 with target_market_match false are contradictions. Of the other 4, the 2 with
// scope unclear go to review; of the 2 with scope clear, the one also software_related is the only
// AUTO_MATCH and the other falls back to review. uncertain (8): all review. not_relevant (8): the 2
// with software_related and target_market_match both true are contradictions; of the other 6, the 3
// with scope clear are dismissed and the 3 with scope unclear go to review.
test('across every possible confident output, routing lands exactly where the rules say', () => {
  assert.deepEqual(tally(everyCombination(CONFIDENT)),
    { NEEDS_REVIEW_CONTRADICTION: 6, NEEDS_REVIEW: 14, AUTO_MATCH: 1, NOT_RELEVANT: 3 });
});

test('below the confidence floor, nothing is decided without a human', () => {
  assert.deepEqual(tally(everyCombination(HESITANT)),
    { NEEDS_REVIEW_CONTRADICTION: 6, NEEDS_REVIEW: 18 });
});

test('the floor holds back both automatic routes and says so; at the floor they stand', () => {
  const match = route(classify('match', allTrue, HESITANT), rules);
  assert.deepEqual([match.status, match.rule], ['NEEDS_REVIEW', 'below-confidence-floor']);
  const dismissal = route(classify('not_relevant', { ...allTrue, software_related: false },
    HESITANT), rules);
  assert.deepEqual([dismissal.status, dismissal.rule], ['NEEDS_REVIEW', 'below-confidence-floor']);
  assert.equal(route(classify('match', allTrue, FLOOR), rules).status, 'AUTO_MATCH');
});

test('confidence never changes a review route', () => {
  const low = everyCombination(0);
  everyCombination(1).forEach((confident, i) => {
    const status = route(confident, rules).status;
    if (status.startsWith('NEEDS_REVIEW')) {
      assert.equal(route(low[i], rules).status, status);
    }
  });
});

test('uncertain is never routed automatically, whatever the criteria say', () => {
  for (const classification of everyCombination(1).filter((c) => c.relevance === 'uncertain')) {
    assert.match(route(classification, rules).status, /^NEEDS_REVIEW/);
  }
});

test('anything short of all three criteria is not an auto-match', () => {
  for (const name of CRITERIA) {
    const result = route(classify('match', { ...allTrue, [name]: false }), rules);
    assert.match(result.status, /^NEEDS_REVIEW/, `with ${name} false`);
  }
});

test('an output no rule matches falls back to review, and says so', () => {
  const result = route(classify('match', { ...allTrue, software_related: false }), rules);
  assert.deepEqual([result.status, result.rule], ['NEEDS_REVIEW', 'no-rule-matched']);
});

function withRule(change) {
  const config = structuredClone(rules);
  change(config);
  return config;
}

test('a misspelt field is refused rather than becoming a rule that never matches', () => {
  const config = withRule((c) => { c.rules[2].when = { 'criteria.scop_clear': false }; });
  assert.throws(() => route(classify('match', allTrue), config), /unknown field "criteria.scop_clear"/);
});

test('a rule cannot bring back currently_open — it is not in the contract', () => {
  const config = withRule((c) => { c.rules[4].when['criteria.currently_open'] = true; });
  assert.throws(() => checkRules(config), /unknown field "criteria.currently_open"/);
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

test('neither the fallback nor the confidence floor can be an automatic decision', () => {
  assert.throws(() => checkRules(withRule((c) => { c.fallback.route = 'NOT_RELEVANT'; })),
    /fallback must/);
  assert.throws(() => checkRules(withRule((c) => { c.confidence_floor.route = 'AUTO_MATCH'; })),
    /confidence_floor must/);
});

test('a confidence floor that is missing, zero or out of range is refused', () => {
  const broken = [
    (c) => { delete c.confidence_floor; },
    (c) => { c.confidence_floor.min = 0; },
    (c) => { c.confidence_floor.min = 1.5; },
    (c) => { c.confidence_floor.min = '0.8'; },
  ];
  for (const change of broken) {
    assert.throws(() => checkRules(withRule(change)), /confidence_floor/);
  }
});

test('duplicate rule ids, unknown routes, empty conditions and non-boolean criteria are refused', () => {
  const broken = [
    (c) => { c.rules[1].id = 'contradiction-not-relevant'; },
    (c) => { c.rules[1].route = 'ESCALATE'; },
    (c) => { c.rules[1].when = {}; },
    (c) => { c.rules[2].when = { 'criteria.scope_clear': 'no' }; },
    (c) => { c.rules[3].when = { relevance: 'maybe' }; },
  ];
  for (const change of broken) {
    assert.throws(() => checkRules(withRule(change)));
  }
});
