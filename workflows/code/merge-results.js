'use strict';

// Merges the per-concept search responses into one claim batch for database/queries/claim.sql.
//
// One search per concept means one notice can come back several times. It is kept once, with every
// concept that retrieved it in `matched_concepts`, in the order the responses arrive. Nothing is
// dropped silently:
//
//   closed     Notices whose closing date has already passed. The open-tender file carries some.
//              They are left out of the batch and listed here.
//   truncated  Searches that hit the row cap. Rows past the cap were never returned and cannot be
//              paged for, so the workflow must alert: a concept has outgrown the profile.
//
// A notice with no closing date is kept — it cannot be shown to be closed.
//
// A response that is not a MapleProcure search envelope throws: that is a broken integration, not
// data to route around.
//
// `now` is local wall-clock time, 'YYYY-MM-DDTHH:MM:SS', the same convention as the source's closing
// dates, which carry no time zone. Pure: the clock is an argument, not read here.

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function checkEnvelope(concept, body) {
  const broken = (what) => new Error(`search for concept "${concept}": ${what}`);
  if (typeof body !== 'object' || body === null || !Array.isArray(body.rows)) {
    throw broken('response has no rows array — not a MapleProcure envelope');
  }
  if (typeof body.as_of !== 'string' || !Number.isInteger(body.total_matches) ||
      typeof body.truncated !== 'boolean') {
    throw broken('response is missing as_of, total_matches or truncated');
  }
  for (const row of body.rows) {
    if (typeof row.reference_number !== 'string' || row.reference_number === '' ||
        typeof row.title !== 'string') {
      throw broken('a row has no reference_number or title');
    }
    if (row.closing_date != null && !LOCAL_TIME.test(row.closing_date)) {
      throw broken(`closing_date not understood: ${row.closing_date}`);
    }
  }
}

function blankToNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function mergeResults(responses, { now }) {
  if (typeof now !== 'string' || !LOCAL_TIME.test(now)) {
    throw new Error(`now must be local time as YYYY-MM-DDTHH:MM:SS, got ${now}`);
  }
  const byReference = new Map();
  const truncated = [];
  for (const { concept, body } of responses) {
    checkEnvelope(concept, body);
    if (body.truncated || body.withheld > 0) {
      truncated.push({ concept, total_matches: body.total_matches, returned: body.rows.length });
    }
    for (const row of body.rows) {
      const seen = byReference.get(row.reference_number);
      if (seen) {
        if (!seen.matched_concepts.includes(concept)) {
          seen.matched_concepts.push(concept);
        }
        continue;
      }
      byReference.set(row.reference_number, {
        tender_reference: row.reference_number,
        title: row.title,
        buyer_name: blankToNull(row.buyer_name),
        closing_date: row.closing_date ?? null,
        notice_url: blankToNull(row.notice_url),
        matched_concepts: [concept],
      });
    }
  }
  const notices = [];
  const closed = [];
  for (const notice of byReference.values()) {
    if (notice.closing_date !== null && notice.closing_date < now) {
      closed.push({ tender_reference: notice.tender_reference, closing_date: notice.closing_date });
    } else {
      notices.push(notice);
    }
  }
  return { notices, closed, truncated };
}

module.exports = { mergeResults };
