'use strict';

// Routes a validated classification using config/routing-rules.json.
//
// The only interpreter of that file. The workflow and the eval harness both call route(), so the
// eval measures the routing that runs. Rules are tried in order and the first whose conditions all
// hold wins; when none holds, the fallback applies. Order is load-bearing — see the file's notes.
//
// The rules file is checked on every call, and a file that could route unsafely is refused rather
// than half-applied: an unknown field in a condition would otherwise make a rule silently never
// match. Input must already have passed validate-classification.js.
//
// Pure: no n8n globals, no I/O.

// Automatic routes, and the model verdict each one requires.
const AUTOMATIC = { AUTO_MATCH: 'match', NOT_RELEVANT: 'not_relevant' };
const REVIEW = ['NEEDS_REVIEW', 'NEEDS_REVIEW_CONTRADICTION'];

function checkCondition(contract, where, path, value) {
  if (path === 'relevance') {
    if (!contract.relevance.includes(value)) {
      throw new Error(`${where}: relevance "${value}" is not in the contract`);
    }
    return;
  }
  const name = path.startsWith('criteria.') ? path.slice('criteria.'.length) : null;
  if (!contract.criteria.includes(name)) {
    throw new Error(`${where}: unknown field "${path}"`);
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${where}: "${path}" must be compared with true or false`);
  }
}

function checkRules(config) {
  const { contract, rules, fallback } = config;
  const ids = new Set();
  for (const rule of rules) {
    const where = `rule "${rule.id}"`;
    if (typeof rule.id !== 'string' || rule.id === '' || ids.has(rule.id)) {
      throw new Error(`${where}: id must be a unique non-empty string`);
    }
    ids.add(rule.id);
    if (!(rule.route in AUTOMATIC) && !REVIEW.includes(rule.route)) {
      throw new Error(`${where}: unknown route "${rule.route}"`);
    }
    const conditions = Object.entries(rule.when || {});
    if (conditions.length === 0) {
      throw new Error(`${where}: has no conditions`);
    }
    for (const [path, value] of conditions) {
      checkCondition(contract, where, path, value);
    }
    const verdict = AUTOMATIC[rule.route];
    if (verdict && rule.when.relevance !== verdict) {
      throw new Error(
        `${where}: routing to ${rule.route} requires relevance "${verdict}" — ` +
          'a rule may narrow the model\'s verdict, never override it',
      );
    }
  }
  if (!fallback || !REVIEW.includes(fallback.route) || typeof fallback.id !== 'string') {
    throw new Error('fallback must have an id and route to a review status');
  }
}

function valueAt(classification, path) {
  if (path === 'relevance') {
    return classification.relevance;
  }
  return classification.criteria[path.slice('criteria.'.length)];
}

// Returns { status, rule, rules_version } — rule is the id of the rule that fired, for the audit
// trail's "why was this routed".
function route(classification, config) {
  checkRules(config);
  for (const rule of config.rules) {
    const holds = Object.entries(rule.when).every(
      ([path, value]) => valueAt(classification, path) === value,
    );
    if (holds) {
      return { status: rule.route, rule: rule.id, rules_version: config.version };
    }
  }
  return { status: config.fallback.route, rule: config.fallback.id, rules_version: config.version };
}

module.exports = { route, checkRules };
