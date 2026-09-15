'use strict';

// Prepares the classification of one claimed notice from its MapleProcure detail response.
//
// MapleProcure answers a lookup for a reference it no longer holds with 200 and `rows: []`, not
// 404, so "not found" is read from the body. A failed fetch that n8n passed on as an error item has
// no rows either. Both return { found: false }: nothing is recorded, the claim stays PENDING, and
// recover.sql retries it later and gives up after its third attempt.
//
// When found, returns the Anthropic Messages API request, the exact notice text it sends, and the
// envelope provenance that every classified row must carry. The response schema is generated from
// `contract` in config/routing-rules.json, the vocabulary validate-classification.js and route.js
// also read. Structured outputs require additionalProperties: false on every object and every
// property listed in required; they cannot express a numeric range, so confidence's 0 to 1 range
// is still checked by validate-classification.js.
//
// Pure: no n8n globals, no I/O. Settings, prompt and contract are arguments.

const OUTPUT_FIELDS = ['category', 'relevance', 'rationale', 'criteria', 'confidence'];
const NOTICE_FIELDS = [
  ['Reference', (row) => row.reference_number],
  ['Title', (row) => row.title],
  ['Buyer', (row) => row.buyer_name],
  ['End user', (row) => row.end_user_name],
  ['Notice type', (row) => row.notice_type],
  ['Procurement method', (row) => row.procurement_method],
  ['Category', (row) => row.category],
  ['GSIN', (row) => joined(row.gsin, row.gsin_description)],
  ['UNSPSC', (row) => joined(row.unspsc, row.unspsc_description)],
  ['Regions of delivery', (row) => row.regions_of_delivery],
];
const PROVENANCE = ['as_of', 'source_file', 'source_last_modified'];

function joined(...values) {
  return values.filter((value) => typeof value === 'string' && value.trim() !== '').join(' ');
}

function responseSchema(contract) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...OUTPUT_FIELDS],
    properties: {
      category: { type: 'string', enum: Object.keys(contract.categories) },
      relevance: { type: 'string', enum: [...contract.relevance] },
      rationale: { type: 'string' },
      criteria: {
        type: 'object',
        additionalProperties: false,
        required: [...contract.criteria],
        properties: Object.fromEntries(contract.criteria.map((name) => [name, { type: 'boolean' }])),
      },
      confidence: { type: 'number' },
    },
  };
}

function noticeText(row) {
  const lines = NOTICE_FIELDS
    .map(([label, read]) => [label, read(row)])
    .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
    .map(([label, value]) => `${label}: ${value.trim()}`);
  const description = typeof row.description === 'string'
    ? row.description.replace(/\r\n?/g, '\n').trim()
    : '';
  lines.push('', 'Description:', description || '(no description in the source)');
  return lines.join('\n');
}

function envelopeOf(body) {
  for (const field of PROVENANCE) {
    if (typeof body[field] !== 'string' || body[field] === '') {
      throw new Error(`detail response has no ${field}: provenance is required on every classified row`);
    }
  }
  if (!Number.isInteger(body.source_row_count)) {
    throw new Error('detail response has no source_row_count: provenance is required on every classified row');
  }
  return {
    source_file: body.source_file,
    source_as_of: body.as_of,
    source_last_modified: body.source_last_modified,
    source_row_count: body.source_row_count,
    source_notes: Array.isArray(body.notes) ? body.notes : null,
  };
}

function prepareClassification(detail, reference, { settings, prompt, contract }) {
  const rows = detail && Array.isArray(detail.rows) ? detail.rows : [];
  const row = rows.find((candidate) => candidate.reference_number === reference);
  if (!row) {
    return { tender_reference: reference, found: false };
  }
  const text = noticeText(row);
  const request = {
    model: settings.model,
    max_tokens: settings.max_tokens,
    fallbacks: settings.fallbacks,
    system: prompt,
    messages: [{ role: 'user', content: text }],
    output_config: {
      effort: settings.effort,
      format: { type: 'json_schema', schema: responseSchema(contract) },
    },
  };
  return {
    tender_reference: reference,
    found: true,
    notice_text: text,
    request,
    envelope: envelopeOf(detail),
  };
}

module.exports = { prepareClassification, responseSchema };
