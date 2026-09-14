'use strict';

// The status and relevance vocabularies are written in two languages — the SQL constraints and
// config/routing-rules.json. These tests fail when one changes without the other.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rules = require('../../../config/routing-rules.json');

const schema = fs.readFileSync(path.join(__dirname, '../../../database/schema.sql'), 'utf8');

function checkList(constraint) {
  const match = new RegExp(`CONSTRAINT ${constraint} CHECK \\(\\w+ IN \\(([^)]*)\\)\\)`).exec(schema);
  assert.ok(match, `constraint ${constraint} not found in schema.sql`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

const routes = new Set([...rules.rules.map((rule) => rule.route), rules.fallback.route]);

test('the schema\'s routed statuses are exactly the rule routes plus CLASSIFICATION_FAILED', () => {
  const expected = [...routes, 'CLASSIFICATION_FAILED'];
  assert.deepEqual(checkList('routed_status_known'), [...new Set(expected)].sort());
});

test('every routed status is also a legal current status', () => {
  const statuses = checkList('status_known');
  for (const routed of checkList('routed_status_known')) {
    assert.ok(statuses.includes(routed), routed);
  }
});

test('the schema\'s relevance values are the contract\'s', () => {
  assert.deepEqual(checkList('relevance_known'), [...rules.contract.relevance].sort());
});
