'use strict';

// Holds model output to the classification contract in config/routing-rules.json.
//
// Shape only: is it JSON, are exactly the contract's fields present, are values of the right type
// and inside the enums. Whether the fields agree with one another is routing's concern, not this
// module's — contradictory output routes to NEEDS_REVIEW_CONTRADICTION rather than failing here.
//
// Never throws on bad output. Invalid output is a workflow state, CLASSIFICATION_FAILED, not a
// crash. Every error is collected rather than only the first, because the review queue shows them.
//
// Returns { ok: true, classification } or { ok: false, errors: [string] }.
// Pure: no n8n globals, no I/O.

const FIELDS = ['category', 'relevance', 'rationale', 'criteria', 'confidence'];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkCriteria(criteria, contract, errors) {
  if (!isPlainObject(criteria)) {
    errors.push('criteria: expected an object');
    return;
  }
  for (const name of contract.criteria) {
    if (!(name in criteria)) {
      errors.push(`criteria.${name}: missing`);
    } else if (typeof criteria[name] !== 'boolean') {
      errors.push(`criteria.${name}: expected true or false`);
    }
  }
  for (const name of Object.keys(criteria)) {
    if (!contract.criteria.includes(name)) {
      errors.push(`criteria.${name}: not in the contract`);
    }
  }
}

function checkFields(value, contract, errors) {
  const categories = Object.keys(contract.categories);
  if ('category' in value && !categories.includes(value.category)) {
    errors.push(`category: expected one of ${categories.join(', ')}`);
  }
  if ('relevance' in value && !contract.relevance.includes(value.relevance)) {
    errors.push(`relevance: expected one of ${contract.relevance.join(', ')}`);
  }
  if ('rationale' in value && (typeof value.rationale !== 'string' || !value.rationale.trim())) {
    errors.push('rationale: expected a non-empty string');
  }
  if ('criteria' in value) {
    checkCriteria(value.criteria, contract, errors);
  }
  const { confidence } = value;
  if ('confidence' in value &&
      (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1))) {
    errors.push('confidence: expected a number from 0 to 1');
  }
}

function validateClassification(output, contract) {
  let value = output;
  if (typeof output === 'string') {
    try {
      value = JSON.parse(output);
    } catch (error) {
      return { ok: false, errors: [`not valid JSON: ${error.message}`] };
    }
  }
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['expected a JSON object'] };
  }
  const errors = [];
  for (const key of FIELDS) {
    if (!(key in value)) {
      errors.push(`${key}: missing`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!FIELDS.includes(key)) {
      errors.push(`${key}: not in the contract`);
    }
  }
  checkFields(value, contract, errors);
  return errors.length === 0 ? { ok: true, classification: value } : { ok: false, errors };
}

module.exports = { validateClassification };
