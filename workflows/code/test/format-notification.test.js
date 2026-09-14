'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatNotification } = require('../format-notification');
const { contract } = require('../../../config/routing-rules.json');

function matched(fields = {}) {
  return { tender_reference: 'cb-562-54954316', status: 'AUTO_MATCH',
    title: 'Enterprise Procurement Management Platform', buyer_name: 'Shared Services Canada',
    closing_date: '2026-10-20T14:00:00', category: 'procurement_technology',
    rationale: 'The tender requests procurement-management software.',
    notice_url: 'https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/cb-562-54954316',
    source_file: 'https://canadabuys.canada.ca/opendata/pub/openTenderNotice.csv',
    source_as_of: '2026-09-14T00:19:57+00:00', ...fields };
}

test('an auto-match reads like the design doc example, with its link', () => {
  const { text, has_link: hasLink } = formatNotification(matched(), contract.categories);
  assert.equal(text, [
    'New procurement opportunity',
    '',
    'Enterprise Procurement Management Platform',
    '',
    'Category: Procurement technology',
    'Buyer: Shared Services Canada',
    'Closing: October 20, 2026, 14:00 (as published; the source gives no time zone)',
    'Why it matched: The tender requests procurement-management software.',
    'Reference: cb-562-54954316',
    'Notice: https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/cb-562-54954316',
    'Source: CanadaBuys via MapleProcure, data as of 2026-09-14T00:19:57+00:00',
  ].join('\n'));
  assert.equal(hasLink, true);
});

test('with no notice_url, the reference is printed and no URL of any kind appears', () => {
  for (const noticeUrl of [null, undefined, '', '   ']) {
    const { text, has_link: hasLink } =
      formatNotification(matched({ notice_url: noticeUrl }), contract.categories);
    assert.equal(hasLink, false);
    assert.doesNotMatch(text, /https?:|canadabuys\.canada\.ca|www\./i);
    assert.match(text, /Notice: no link in the source data — look up reference cb-562-54954316/);
    assert.match(text, /Reference: cb-562-54954316/);
  }
});

test('a person-approved review row says so, and who approved it', () => {
  const { text } = formatNotification(matched({ status: 'HUMAN_APPROVED', reviewed_by: 'analyst' }),
    contract.categories);
  assert.match(text, /^Procurement opportunity approved in review\n/);
  assert.match(text, /\nApproved by: analyst\n/);
});

test('an approved row whose classification had failed still formats honestly', () => {
  const { text } = formatNotification(matched({ status: 'HUMAN_APPROVED', reviewed_by: 'analyst',
    category: null, rationale: null }), contract.categories);
  assert.match(text, /Category: not classified/);
  assert.match(text, /Why it matched: no model rationale — approved by a person in review/);
});

test('missing buyer and closing date are stated, not left blank', () => {
  const { text } = formatNotification(matched({ buyer_name: null, closing_date: null }),
    contract.categories);
  assert.match(text, /Buyer: not stated in the source/);
  assert.match(text, /Closing: not stated in the source/);
});

test('a Postgres-style timestamp string is read the same as the ISO form', () => {
  const { text } = formatNotification(matched({ closing_date: '2026-10-20 14:00:00' }),
    contract.categories);
  assert.match(text, /Closing: October 20, 2026, 14:00/);
});

test('a closing date that arrives as a Date is refused rather than printed in a guessed zone', () => {
  assert.throws(() => formatNotification(matched({ closing_date: new Date('2026-10-20T14:00:00Z') }),
    contract.categories), /time zone/);
});

test('no notification for anything that is not a relevant opportunity', () => {
  for (const status of ['NOT_RELEVANT', 'NEEDS_REVIEW', 'NEEDS_REVIEW_CONTRADICTION',
    'CLASSIFICATION_FAILED', 'HUMAN_REJECTED', 'PENDING']) {
    assert.throws(() => formatNotification(matched({ status }), contract.categories),
      /no notification is sent/);
  }
});

test('a notification without provenance or a reference is refused', () => {
  assert.throws(() => formatNotification(matched({ source_as_of: null }), contract.categories),
    /source_as_of is required/);
  assert.throws(() => formatNotification(matched({ tender_reference: '' }), contract.categories),
    /tender_reference is required/);
});
