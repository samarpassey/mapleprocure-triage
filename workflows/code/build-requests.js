'use strict';

// Turns config/search-profile.json into one search request per concept.
//
// MapleProcure ignores query parameters it does not recognise — `?q=software` returns every
// notice, unfiltered — so a misspelt parameter here would silently turn one concept into the whole
// dataset and put all of it through classification. This module therefore refuses any concept
// field it does not know, rather than passing it along.
//
// `closing_before` is refused too, though MapleProcure documents it: it drops every notice with no
// closing date. Closed notices are filtered, visibly, in merge-results.js instead.
//
// Returns [{ concept, method, path, query }]. Pure: no n8n globals, no I/O.

const PATH = '/v1/tenders/search';
const MAX_LIMIT = 100;
const CONCEPT_FIELDS = ['id', 'keywords', 'matches_when_measured', 'covers'];
const REFUSED = {
  closing_before: 'drops every notice with no closing date; merge-results.js filters closed ones',
  region: 'refused by MapleProcure with 422; filter regions_of_delivery on the rows instead',
};

function checkConcept(concept, seen) {
  const where = `concept ${JSON.stringify(concept.id)}`;
  for (const field of Object.keys(concept)) {
    if (field in REFUSED) {
      throw new Error(`${where}: "${field}" is not sent — ${REFUSED[field]}`);
    }
    if (!CONCEPT_FIELDS.includes(field)) {
      throw new Error(`${where}: unknown field "${field}" — MapleProcure would silently ignore it`);
    }
  }
  if (typeof concept.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(concept.id)) {
    throw new Error(`${where}: id must be lowercase words joined by hyphens`);
  }
  if (seen.has(concept.id)) {
    throw new Error(`${where}: duplicate id`);
  }
  if (typeof concept.keywords !== 'string' || concept.keywords.trim() === '') {
    throw new Error(`${where}: keywords must be a non-empty string`);
  }
}

function buildRequests(profile) {
  if (!Number.isInteger(profile.limit) || profile.limit < 1 || profile.limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}, MapleProcure's cap`);
  }
  if (!Array.isArray(profile.concepts) || profile.concepts.length === 0) {
    throw new Error('profile has no concepts');
  }
  const seen = new Set();
  return profile.concepts.map((concept) => {
    checkConcept(concept, seen);
    seen.add(concept.id);
    return {
      concept: concept.id,
      method: 'GET',
      path: PATH,
      query: { keywords: concept.keywords.trim(), limit: profile.limit },
    };
  });
}

module.exports = { buildRequests };
