'use strict';

// Turns one Anthropic Messages API response into the object database/queries/record-classification.sql
// stores.
//
// The response is read as whatever came back. Only a message that ended normally (stop_reason
// end_turn) is validated; a refusal or a max_tokens stop can carry text that does not match the
// schema, and is CLASSIFICATION_FAILED with the reason. The classification is the first text block;
// thinking blocks come before it. Output that fails validate-classification.js is
// CLASSIFICATION_FAILED with its errors and raw text. Output that passes is routed by route.js.
//
// Returns null when there is no message at all: a call that still failed after n8n's retries and
// was passed on as an error item. Nothing is recorded, and recover.sql retries the claim later.
//
// Every record carries the notice text the model read, the envelope provenance of the MapleProcure
// response it came from, and the model that answered, as the response names it.
//
// validateClassification and route are passed in, so this file stands alone in a Code node.
// Pure: no n8n globals, no I/O.

const EMPTY_CLASSIFICATION = {
  routing_rule: null, category: null, relevance: null, rationale: null, criteria: null,
  model_confidence: null,
};

function recordFor(response, prepared, { rules, promptVersion }, { validateClassification, route }) {
  if (!response || response.type !== 'message' || !Array.isArray(response.content)) {
    return null;
  }
  const block = response.content.find((candidate) => candidate.type === 'text');
  const text = block && typeof block.text === 'string' ? block.text : null;
  const base = {
    model_name: response.model,
    prompt_version: promptVersion,
    rules_version: rules.version,
    notice_text: prepared.notice_text,
    ...prepared.envelope,
  };
  let result;
  if (response.stop_reason !== 'end_turn') {
    result = { ok: false, errors: [`the model stopped with stop_reason ${response.stop_reason}`] };
  } else if (text === null) {
    result = { ok: false, errors: ['the response has no text block'] };
  } else {
    result = validateClassification(text, rules.contract);
  }
  if (!result.ok) {
    return {
      ...base,
      ...EMPTY_CLASSIFICATION,
      routed_status: 'CLASSIFICATION_FAILED',
      validation_errors: result.errors,
      model_output_raw: text,
    };
  }
  const classification = result.classification;
  const routed = route(classification, rules);
  return {
    ...base,
    routed_status: routed.status,
    routing_rule: routed.rule,
    category: classification.category,
    relevance: classification.relevance,
    rationale: classification.rationale,
    criteria: classification.criteria,
    model_confidence: classification.confidence,
    validation_errors: null,
    model_output_raw: null,
  };
}

module.exports = { recordFor };
