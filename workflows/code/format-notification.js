'use strict';

// Formats the notification for a relevant opportunity: an AUTO_MATCH, or a review-queue row that a
// person approved. Plain text; the channel's node wraps it.
//
// notice_url is null on about 6% of notices. When it is, the reference number is printed and no
// link is built. CanadaBuys URLs are not this project's to construct, and a guessed link that
// breaks is worse than none.
//
// Closing dates are printed as published. The source gives no time zone, so a closing_date that
// arrives as a Date object — already shifted into some zone — is refused rather than printed wrong.
//
// Input: a row as returned by record-classification.sql or record-review.sql, and
// contract.categories from config/routing-rules.json. Returns { text, has_link }.
// Pure: no n8n globals, no I/O.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(:\d{2}(\.\d+)?)?$/;
const HEADINGS = {
  AUTO_MATCH: 'New procurement opportunity',
  HUMAN_APPROVED: 'Procurement opportunity approved in review',
};

function formatClosing(value) {
  if (value === null || value === undefined) {
    return 'not stated in the source';
  }
  if (typeof value !== 'string') {
    throw new Error('closing_date must be the source text; a Date has been moved into a time zone');
  }
  const parts = LOCAL_TIME.exec(value);
  if (!parts) {
    throw new Error(`closing_date not understood: ${value}`);
  }
  const [, year, month, day, hour, minute] = parts;
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}, ${hour}:${minute} ` +
    '(as published; the source gives no time zone)';
}

function formatAsOf(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== 'string' || value === '') {
    throw new Error('source_as_of is required: a notification must say what data it is based on');
  }
  return value;
}

function formatNotification(row, categories) {
  const heading = HEADINGS[row.status];
  if (!heading) {
    throw new Error(`no notification is sent for status ${row.status}`);
  }
  if (typeof row.tender_reference !== 'string' || row.tender_reference === '') {
    throw new Error('tender_reference is required');
  }
  const link = typeof row.notice_url === 'string' && row.notice_url.trim() !== ''
    ? row.notice_url.trim()
    : null;
  const category = row.category ? (categories[row.category] ?? row.category) : 'not classified';
  const lines = [
    heading,
    '',
    row.title,
    '',
    `Category: ${category}`,
    `Buyer: ${row.buyer_name || 'not stated in the source'}`,
    `Closing: ${formatClosing(row.closing_date)}`,
    `Why it matched: ${row.rationale || 'no model rationale — approved by a person in review'}`,
  ];
  if (row.status === 'HUMAN_APPROVED') {
    lines.push(`Approved by: ${row.reviewed_by || 'not recorded'}`);
  }
  lines.push(
    `Reference: ${row.tender_reference}`,
    link
      ? `Notice: ${link}`
      : `Notice: no link in the source data — look up reference ${row.tender_reference} on CanadaBuys`,
    `Source: CanadaBuys via MapleProcure, data as of ${formatAsOf(row.source_as_of)}`,
  );
  return { text: lines.join('\n'), has_link: link !== null };
}

module.exports = { formatNotification };
